"""Research forecast cache. No future candles, realized prices, or benchmark writes."""
import argparse
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import sys
from time import perf_counter

from timesfm_benchmark import Candle, encoded, fingerprint, model_inputs, validate_candles

ROOT = Path(__file__).resolve().parents[1]


def validate_request(request):
    settings = request["settings"]
    if settings["variant"] not in ("timesfm_ohlcv", "timesfm_close") or settings["horizon"] != 10:
        raise ValueError("Research requires a TimesFM variant and a 10-session horizon")
    if not isinstance(settings["model"], str) or not settings["model"]:
        raise ValueError("Model is required")
    revision = settings["revision"]
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Pin the model revision to a full commit hash")
    for value in (settings["context"], settings["stride"], settings["inference"]["batch_size"], settings["inference"]["threads"]):
        if type(value) is not int or value < 1:
            raise ValueError("Context, stride, batch size and threads must be positive integers")
    if not 32 <= settings["context"] <= 15360:
        raise ValueError("Context must be between 32 and 15360")
    symbols = request["symbols"]
    if not symbols or len(set(symbols)) != len(symbols) or any(not isinstance(s, str) or not s for s in symbols):
        raise ValueError("Symbols must be nonempty and unique")
    ranges = request["ranges"]
    if not ranges or len({r["name"] for r in ranges}) != len(ranges):
        raise ValueError("Named research ranges must be nonempty and unique")
    previous = ""
    for bounds in sorted(ranges, key=lambda r: r["start"]):
        for field in ("start", "end"):
            if date.fromisoformat(bounds[field]).isoformat() != bounds[field]:
                raise ValueError("Dates must be YYYY-MM-DD")
        if bounds["start"] > bounds["end"] or bounds["start"] <= previous:
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
    sources = (Path(__file__), ROOT / "scripts/timesfm_benchmark.py",
               ROOT / "scripts/timesfm-research.py", ROOT / "scripts/timesfm-research.py.lock")
    return fingerprint({"settings": settings, "sources": {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sources if p.exists()}})


def make_windows(data, request):
    settings = request["settings"]
    identity = inference_identity(settings)
    context, stride = settings["context"], settings["stride"]
    windows = []
    coverage = {}
    for symbol in request["symbols"]:
        candles = data[symbol]
        validate_candles(symbol, candles)
        coverage[symbol] = {r["name"]: 0 for r in request["ranges"]}
        # Anchored to each symbol's history, not the moving fold boundary.
        for i in range(context - 1, len(candles), stride):
            bounds = next((r for r in request["ranges"] if r["start"] <= candles[i].date <= r["end"]), None)
            if bounds is None:
                continue
            history = candles[i - context + 1:i + 1]
            key = fingerprint({"inference": identity, "symbol": symbol,
                               "history": [list(c.__dict__.values()) for c in history]})
            windows.append(ResearchWindow(symbol, history, key))
            coverage[symbol][bounds["name"]] += 1
        if any(count == 0 for count in coverage[symbol].values()):
            raise ValueError(f"{symbol}: insufficient historical context/coverage for {coverage[symbol]}")
    return sorted(windows, key=lambda w: (w.origin, w.symbol)), coverage


def read_data(path, request):
    end = max(r["end"] for r in request["ranges"])
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        return {symbol: tuple(Candle(row[0], *(float(v) for v in row[1:])) for row in db.execute(
            "SELECT date, open, high, low, close, adj_close, volume FROM prices "
            "WHERE symbol = ? AND date <= ? ORDER BY date", (symbol, end)))
            for symbol in request["symbols"]}


def manifest_for(request, windows):
    return {"schema_version": 1, "partition": "research",
            "config": {**request["settings"], "ranges": request["ranges"], "symbols": request["symbols"]},
            "data_sha256": fingerprint([w.key for w in windows]), "expected_windows": len(windows)}


def open_cache(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    # Refuse to migrate or write a benchmark cache even if mistakenly supplied.
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecasts'").fetchone():
        db.close()
        raise ValueError("Research requires a separate cache, not the benchmark database")
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
        db.executemany("INSERT OR IGNORE INTO campaign_windows VALUES (?, ?, ?, ?, ?, ?)",
                       [(campaign, w.symbol, w.origin, request["settings"]["variant"], 10, w.key) for w in windows])
    return campaign


def pending_windows(db, windows):
    cached = {r[0] for r in db.execute("SELECT key FROM predictions")}
    return [w for w in windows if w.key not in cached]


def store_batch(db, windows, predictions):
    if len(windows) != len(predictions) or any(not math.isfinite(p) or p <= 0 for p in predictions):
        raise ValueError("Invalid research forecast batch")
    with db:
        db.executemany("INSERT OR IGNORE INTO predictions VALUES (?, ?, ?)",
                       [(w.key, w.history[-1].adj_close, float(p)) for w, p in zip(windows, predictions)])


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
    model = TimesFM3Forecaster(ModelConfig(checkpoint_path=settings["model"], revision=settings["revision"],
                                         device="cpu", per_core_batch_size=cfg["batch_size"]))
    started = perf_counter()
    for batch_number, offset in enumerate(range(0, len(pending), cfg["batch_size"])):
        if max_batches is not None and batch_number >= max_batches:
            break
        batch = pending[offset:offset + cfg["batch_size"]]
        inputs = [model_inputs(w.history) for w in batch]
        with torch.inference_mode():
            outputs = list(model.predict_batch(
                contexts=[np.asarray(target, dtype=np.float32) for target, _ in inputs], horizon=10,
                past_only_covariates=[np.asarray(cov, dtype=np.float32) for _, cov in inputs]
                    if settings["variant"] == "timesfm_ohlcv" else None,
                return_quantiles=True, use_symmetric_averaging=cfg["use_symmetric_averaging"],
                use_znorm=cfg["use_znorm"], sort_quantiles=cfg["sort_quantiles"],
            ))
        store_batch(db, batch, [float(output.forecast[9]) for output in outputs])
        done = offset + len(batch)
        elapsed = perf_counter() - started
        print(f"Cached {done}/{len(pending)} new research windows; ETA {elapsed / done * (len(pending) - done) / 60:.1f} min",
              file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "run"))
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--max-batches", type=int)
    args = parser.parse_args()
    try:
        if args.cache.resolve() == args.db.resolve():
            raise ValueError("Cache must not be the market database")
        if args.max_batches is not None and args.max_batches < 1:
            raise ValueError("max-batches must be positive")
        request = json.loads(args.request.read_text())
        validate_request(request)
        windows, coverage = make_windows(read_data(args.db, request), request)
        if args.command == "plan":
            print(json.dumps({"campaign": fingerprint(manifest_for(request, windows))[:20],
                              "windows": len(windows), "coverage": coverage}, indent=2))
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
        print(json.dumps({"campaign": campaign, "status": status, "windows": len(windows),
                          "remaining": remaining, "coverage": coverage}, indent=2))
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error) as exc:
        parser.exit(2, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
