"""Research forecast cache. No future candles, realized prices, or benchmark writes."""

import argparse
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
from time import perf_counter

from timesfm_inputs import Candle, encoded, fingerprint, model_inputs, validate_candles


ROOT = Path(__file__).resolve().parents[1]
HORIZON = 10
VARIANTS = ("timesfm_ohlcv", "timesfm_close")


def validate_request(request):
    if not isinstance(request, dict):
        raise ValueError("Request must be an object")
    settings = request.get("settings")
    if not isinstance(settings, dict):
        raise ValueError("Request settings are required")
    if settings.get("variant") not in VARIANTS or settings.get("horizon") != HORIZON:
        raise ValueError("Research requires a TimesFM variant and a 10-session horizon")
    if not isinstance(settings.get("model"), str) or not settings["model"]:
        raise ValueError("Model is required")
    revision = settings.get("revision")
    if (not isinstance(revision, str) or len(revision) != 40
            or any(c not in "0123456789abcdef" for c in revision)):
        raise ValueError("Pin the model revision to a full commit hash")
    inference = settings.get("inference")
    if not isinstance(inference, dict):
        raise ValueError("Inference settings are required")
    values = (settings.get("context"), settings.get("stride"),
              inference.get("batch_size"), inference.get("threads"))
    if any(type(value) is not int or value < 1 for value in values):
        raise ValueError("Context, stride, batch size and threads must be positive integers")
    if not 32 <= settings["context"] <= 15360:
        raise ValueError("Context must be between 32 and 15360")
    for key in ("use_symmetric_averaging", "use_znorm", "sort_quantiles"):
        if type(inference.get(key)) is not bool:
            raise ValueError(f"Inference setting {key} must be boolean")

    symbols = request.get("symbols")
    if (not isinstance(symbols, list) or not symbols
            or any(not isinstance(symbol, str) or not symbol for symbol in symbols)
            or len(set(symbols)) != len(symbols)):
        raise ValueError("Symbols must be nonempty and unique")
    ranges = request.get("ranges")
    if not isinstance(ranges, list) or not ranges:
        raise ValueError("Named research ranges must be nonempty and unique")
    names = []
    for bounds in ranges:
        if not isinstance(bounds, dict) or not isinstance(bounds.get("name"), str) \
                or not bounds["name"] or bounds["name"] in names:
            raise ValueError("Named research ranges must be nonempty and unique")
        names.append(bounds["name"])
        for field in ("start", "end"):
            value = bounds.get(field)
            try:
                canonical = date.fromisoformat(value).isoformat()
            except (TypeError, ValueError):
                raise ValueError("Dates must be YYYY-MM-DD") from None
            if canonical != value:
                raise ValueError("Dates must be YYYY-MM-DD")
        if bounds["start"] > bounds["end"]:
            raise ValueError("Research ranges must not overlap")
    previous = ""
    for bounds in sorted(ranges, key=lambda item: item["start"]):
        if bounds["start"] <= previous:
            raise ValueError("Research ranges must not overlap")
        previous = bounds["end"]


@dataclass(frozen=True)
class ResearchWindow:
    symbol: str
    history: tuple
    key: str

    @property
    def origin(self):
        return self.history[-1].date


def inference_identity(settings):
    sources = (
        Path(__file__).resolve(),
        ROOT / "scripts/timesfm_inputs.py",
        ROOT / "scripts/timesfm-research.py",
        ROOT / "scripts/timesfm-research.py.lock",
    )
    return fingerprint({"settings": settings, "sources": {
        str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sources if path.exists()
    }})


def make_windows(data, request):
    settings = request["settings"]
    identity = inference_identity(settings)
    context, stride = settings["context"], settings["stride"]
    windows = []
    coverage = {}
    for symbol in request["symbols"]:
        candles = tuple(data.get(symbol, ()))
        validate_candles(symbol, candles)
        coverage[symbol] = {bounds["name"]: 0 for bounds in request["ranges"]}
        # Anchored to each symbol's history, not the moving fold boundary.
        for index in range(context - 1, len(candles), stride):
            bounds = next((bounds for bounds in request["ranges"]
                           if bounds["start"] <= candles[index].date <= bounds["end"]), None)
            if bounds is None:
                continue
            history = candles[index - context + 1:index + 1]
            key = fingerprint({
                "inference": identity,
                "symbol": symbol,
                "history": [list(candle.__dict__.values()) for candle in history],
            })
            windows.append(ResearchWindow(symbol, history, key))
            coverage[symbol][bounds["name"]] += 1
        if any(count == 0 for count in coverage[symbol].values()):
            raise ValueError(f"{symbol}: insufficient historical context/coverage for {coverage[symbol]}")
    return sorted(windows, key=lambda window: (window.origin, window.symbol)), coverage


def read_data(path, request):
    end = max(bounds["end"] for bounds in request["ranges"])
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        data = {}
        for symbol in request["symbols"]:
            rows = db.execute(
                "SELECT date, open, high, low, close, adj_close, volume FROM prices "
                "WHERE symbol = ? AND date <= ? ORDER BY date", (symbol, end),
            )
            candles = tuple(Candle(row[0], *(float(value) for value in row[1:])) for row in rows)
            validate_candles(symbol, candles)
            data[symbol] = candles
        return data


def manifest_for(request, windows):
    return {
        "schema_version": 1,
        "partition": "research",
        "config": {**request["settings"], "ranges": request["ranges"], "symbols": request["symbols"]},
        "data_sha256": fingerprint([window.key for window in windows]),
        "expected_windows": len(windows),
    }


def open_cache(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    # Never migrate or write a market/benchmark database by accident.
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('forecasts', 'prices')").fetchone():
        db.close()
        raise ValueError("Research requires a separate cache, not a market or benchmark database")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS predictions (
        key TEXT PRIMARY KEY, origin_price REAL NOT NULL, forecast_price REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS campaign_windows (
        campaign TEXT NOT NULL REFERENCES campaigns(id), symbol TEXT NOT NULL,
        origin TEXT NOT NULL, model TEXT NOT NULL, horizon INTEGER NOT NULL, key TEXT NOT NULL,
        PRIMARY KEY(campaign, symbol, origin, model, horizon));
      CREATE VIEW IF NOT EXISTS forecasts AS
        SELECT w.campaign, w.symbol, w.origin, w.model, w.horizon, p.origin_price, p.forecast_price
        FROM campaign_windows w JOIN predictions p ON w.key=p.key;
    """)
    return db


def register_campaign(db, request, windows):
    manifest = manifest_for(request, windows)
    campaign = fingerprint(manifest)[:20]
    existing = db.execute("SELECT manifest FROM campaigns WHERE id=?", (campaign,)).fetchone()
    if existing and existing[0] != encoded(manifest):
        raise ValueError("Campaign hash collision")
    with db:
        db.execute("INSERT OR IGNORE INTO campaigns VALUES (?, ?, ?, 'partial')",
                   (campaign, encoded(manifest), datetime.now(timezone.utc).isoformat()))
        db.executemany("INSERT OR IGNORE INTO campaign_windows VALUES (?, ?, ?, ?, ?, ?)", [
            (campaign, window.symbol, window.origin, request["settings"]["variant"], HORIZON, window.key)
            for window in windows
        ])
    return campaign


def pending_windows(db, windows):
    cached = {row[0] for row in db.execute("SELECT key FROM predictions")}
    return [window for window in windows if window.key not in cached]


def store_batch(db, windows, predictions):
    if len(windows) != len(predictions):
        raise ValueError("Invalid research forecast batch")
    values = []
    for window, prediction in zip(windows, predictions):
        try:
            value = float(prediction)
        except (TypeError, ValueError):
            raise ValueError("Invalid research forecast batch") from None
        if not math.isfinite(value) or value <= 0:
            raise ValueError("Invalid research forecast batch")
        values.append((window.key, window.history[-1].adj_close, value))
    with db:
        db.executemany("INSERT OR IGNORE INTO predictions VALUES (?, ?, ?)", values)


def _point_forecast(output):
    try:
        forecast = output.forecast
        if len(forecast) != HORIZON:
            raise ValueError
        value = float(forecast[HORIZON - 1])
    except (AttributeError, IndexError, TypeError, ValueError):
        raise ValueError("Invalid TimesFM forecast output") from None
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Invalid TimesFM forecast output")
    return value


def infer_pending(db, pending, settings, max_batches=None):
    if not pending:
        return
    import numpy as np
    import torch
    from timesfm3 import ModelConfig, TimesFM3Forecaster

    cfg = settings["inference"]
    torch.set_num_threads(cfg["threads"])
    torch.manual_seed(0)
    print(f"Loading {settings['model']} on CPU; {len(pending)} windows pending", file=sys.stderr, flush=True)
    model = TimesFM3Forecaster(ModelConfig(
        checkpoint_path=settings["model"], revision=settings["revision"], device="cpu",
        per_core_batch_size=cfg["batch_size"],
    ))
    started = perf_counter()
    for batch_number, offset in enumerate(range(0, len(pending), cfg["batch_size"])):
        if max_batches is not None and batch_number >= max_batches:
            break
        batch = pending[offset:offset + cfg["batch_size"]]
        inputs = [model_inputs(window.history) for window in batch]
        with torch.inference_mode():
            outputs = list(model.predict_batch(
                contexts=[np.asarray(target, dtype=np.float32) for target, _ in inputs],
                horizon=HORIZON,
                past_only_covariates=[np.asarray(covariates, dtype=np.float32) for _, covariates in inputs]
                    if settings["variant"] == "timesfm_ohlcv" else None,
                return_quantiles=True,
                use_symmetric_averaging=cfg["use_symmetric_averaging"],
                use_znorm=cfg["use_znorm"],
                sort_quantiles=cfg["sort_quantiles"],
            ))
        if len(outputs) != len(batch):
            raise ValueError("Invalid TimesFM forecast output count")
        store_batch(db, batch, [_point_forecast(output) for output in outputs])
        done = offset + len(batch)
        elapsed = perf_counter() - started
        print(
            f"Cached {done}/{len(pending)} new research windows; "
            f"ETA {elapsed / done * (len(pending) - done) / 60:.1f} min",
            file=sys.stderr, flush=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "run"))
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--max-batches", type=int)
    args = parser.parse_args()
    try:
        same_database = args.cache.resolve() == args.db.resolve()
        try:
            same_database = same_database or os.path.samefile(args.cache, args.db)
        except FileNotFoundError:
            pass
        if same_database:
            raise ValueError("Cache must not be the market database")
        if args.max_batches is not None and args.max_batches < 1:
            raise ValueError("max-batches must be positive")
        request = json.loads(args.request.read_text())
        validate_request(request)
        windows, coverage = make_windows(read_data(args.db, request), request)
        if args.command == "plan":
            print(json.dumps({
                "campaign": fingerprint(manifest_for(request, windows))[:20],
                "windows": len(windows), "coverage": coverage,
            }, indent=2))
            return
        with closing(open_cache(args.cache)) as db:
            campaign = register_campaign(db, request, windows)
            pending = pending_windows(db, windows)
            print(f"Research campaign {campaign}: {len(windows) - len(pending)}/{len(windows)} windows reused",
                  file=sys.stderr, flush=True)
            infer_pending(db, pending, request["settings"], args.max_batches)
            remaining = len(pending_windows(db, windows))
            status = "partial" if remaining else "complete"
            with db:
                db.execute("UPDATE campaigns SET status=? WHERE id=?", (status, campaign))
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Research cache integrity check failed")
        print(json.dumps({
            "campaign": campaign, "status": status, "windows": len(windows),
            "remaining": remaining, "coverage": coverage,
        }, indent=2))
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error, IndexError, AttributeError) as exc:
        parser.exit(2, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
