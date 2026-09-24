"""Frozen rolling forecast benchmark; stdlib-only outside model inference."""

import argparse
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import resource
import sqlite3
import statistics
import sys
from time import perf_counter


ROOT = Path(__file__).resolve().parents[1]
MODELS = ("unchanged", "momentum", "timesfm_close", "timesfm_ohlcv")
QUANTILES = tuple(i / 10 for i in range(1, 10))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def log(message):
    print(message, file=sys.stderr, flush=True)


def validate_config(config):
    if config["schema_version"] != 1:
        raise ValueError("Unsupported configuration schema")
    symbols = config["symbols"]
    if not symbols or len(set(symbols)) != len(symbols):
        raise ValueError("Symbols must be nonempty and unique")
    if not all(isinstance(s, str) and s for s in symbols):
        raise ValueError("Invalid symbol")
    for key in ("context", "stride", "momentum_lookback"):
        if type(config[key]) is not int or config[key] < 1:
            raise ValueError(f"{key} must be a positive integer")
    if not 32 <= config["context"] <= 15360:
        raise ValueError("Context must be between 32 and 15360")
    if config["momentum_lookback"] >= config["context"]:
        raise ValueError("Momentum lookback must be smaller than context")
    horizons = config["horizons"]
    if not horizons or horizons != sorted(set(horizons)) or any(
        type(h) is not int or not 1 <= h <= 64 for h in horizons
    ):
        raise ValueError("Horizons must be unique, sorted integers between 1 and 64")
    for split in ("development", "holdout"):
        bounds = config[split]
        for key in ("start", "end"):
            if date.fromisoformat(bounds[key]).isoformat() != bounds[key]:
                raise ValueError("Dates must use YYYY-MM-DD")
        if bounds["start"] > bounds["end"]:
            raise ValueError(f"Invalid {split} date range")
    if config["development"]["end"] >= config["holdout"]["start"]:
        raise ValueError("Holdout must follow development without overlap")
    if not math.isfinite(config["direction_deadband_pct"]) or config["direction_deadband_pct"] < 0:
        raise ValueError("Direction deadband must be finite and nonnegative")
    tolerances = config["near_tolerances_pct"]
    if not tolerances or any(not math.isfinite(t) or t <= 0 for t in tolerances):
        raise ValueError("Near tolerances must be positive and finite")
    if config["inference"]["device"] != "cpu":
        raise ValueError("This benchmark uses CPU-only PyTorch")
    for key in ("batch_size", "threads"):
        value = config["inference"][key]
        if type(value) is not int or value < 1:
            raise ValueError(f"{key} must be a positive integer")
    if len(config["revision"]) != 40 or any(c not in "0123456789abcdef" for c in config["revision"]):
        raise ValueError("Pin the model revision to a full commit hash")


@dataclass(frozen=True)
class Candle:
    date: str
    open: float
    high: float
    low: float
    close: float
    adj_close: float
    volume: float


@dataclass(frozen=True)
class Window:
    symbol: str
    history: tuple
    future: tuple

    @property
    def origin(self):
        return self.history[-1].date


def validate_candles(symbol, candles):
    previous = ""
    for candle in candles:
        if date.fromisoformat(candle.date).isoformat() != candle.date or candle.date <= previous:
            raise ValueError(f"{symbol}: dates must be ISO, increasing, and unique")
        prices = (candle.open, candle.high, candle.low, candle.close, candle.adj_close)
        if any(not math.isfinite(p) or p <= 0 for p in prices):
            raise ValueError(f"{symbol} {candle.date}: invalid price")
        if candle.high < candle.low or not math.isfinite(candle.volume) or candle.volume < 0:
            raise ValueError(f"{symbol} {candle.date}: invalid range or volume")
        previous = candle.date


def read_data(path, config, partition):
    # Restrict the SELECT itself: development never reads holdout observations.
    end = config[partition]["end"]
    data = {}
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        for symbol in config["symbols"]:
            rows = db.execute(
                "SELECT date, open, high, low, close, adj_close, volume FROM prices "
                "WHERE symbol = ? AND date <= ? ORDER BY date", (symbol, end),
            ).fetchall()
            candles = tuple(Candle(row[0], *(float(v) for v in row[1:])) for row in rows)
            validate_candles(symbol, candles)
            data[symbol] = candles
    return data


def make_windows(data, config, partition):
    start, end = config[partition]["start"], config[partition]["end"]
    context, horizon = config["context"], max(config["horizons"])
    windows = []
    for symbol in config["symbols"]:
        candles = data[symbol]
        eligible = [i for i in range(context - 1, len(candles) - horizon)
                    if start <= candles[i].date <= end and candles[i + horizon].date <= end]
        for i in eligible[::config["stride"]]:
            windows.append(Window(symbol, candles[i - context + 1:i + 1], candles[i + 1:i + horizon + 1]))
        if not eligible:
            raise ValueError(f"{symbol}: no complete windows in {partition}")
    return sorted(windows, key=lambda w: (w.origin, w.symbol))


def model_inputs(history):
    """Only historical candles cross the inference boundary."""
    target = [c.adj_close for c in history]
    covariates = [[], [], [], []]
    for c in history:
        factor = c.adj_close / c.close
        for series, value in zip(covariates, (c.open * factor, c.high * factor, c.low * factor, c.volume)):
            series.append(value)
    return target, covariates


def baselines(history, horizons, lookback):
    origin = history[-1].adj_close
    daily_log_return = math.log(origin / history[-lookback - 1].adj_close) / lookback
    return {
        "unchanged": [origin for _ in horizons],
        "momentum": [origin * math.exp(daily_log_return * h) for h in horizons],
    }


def create_manifest(config, data, windows, partition):
    sources = (Path(__file__), ROOT / "scripts/timesfm-benchmark.py",
               ROOT / "scripts/timesfm-benchmark.py.lock")
    return {
        "schema_version": 1,
        "config": config,
        "partition": partition,
        "data_sha256": fingerprint({s: [list(c.__dict__.values()) for c in rows] for s, rows in data.items()}),
        "source_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sources if p.exists()},
        "expected_windows": len(windows),
        "expected_rows": len(windows) * len(MODELS) * len(config["horizons"]),
        "origins_by_symbol": {s: sum(w.symbol == s for w in windows) for s in config["symbols"]},
        "first_origin": windows[0].origin,
        "last_origin": windows[-1].origin,
    }


def open_cache(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS campaigns (
            id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL,
            runtime TEXT, status TEXT NOT NULL DEFAULT 'partial'
        );
        CREATE TABLE IF NOT EXISTS forecasts (
            campaign TEXT NOT NULL REFERENCES campaigns(id), symbol TEXT NOT NULL,
            origin TEXT NOT NULL, model TEXT NOT NULL, horizon INTEGER NOT NULL,
            target_date TEXT NOT NULL, origin_price REAL NOT NULL,
            actual_price REAL NOT NULL, forecast_price REAL NOT NULL, quantiles TEXT,
            PRIMARY KEY (campaign, symbol, origin, model, horizon)
        );
    """)
    return db


def register_campaign(db, manifest):
    campaign = fingerprint(manifest)[:20]
    existing = db.execute("SELECT manifest FROM campaigns WHERE id=?", (campaign,)).fetchone()
    if existing and existing[0] != encoded(manifest):
        raise ValueError("Campaign hash collision")
    with db:
        db.execute("INSERT OR IGNORE INTO campaigns(id,manifest,created_at) VALUES (?,?,?)",
                   (campaign, encoded(manifest), datetime.now(timezone.utc).isoformat()))
    return campaign


def completed_windows(db, campaign, horizons):
    rows = db.execute("SELECT symbol,origin,model,horizon FROM forecasts WHERE campaign=?", (campaign,))
    return complete_keys(rows, horizons)


def complete_keys(rows, horizons):
    present = defaultdict(set)
    for symbol, origin, model, horizon in rows:
        present[(symbol, origin)].add((model, horizon))
    expected = {(model, h) for model in MODELS for h in horizons}
    return {key for key, values in present.items() if values == expected}


def validate_output(forecast, quantiles, horizon):
    if len(forecast) != horizon or len(quantiles) != horizon:
        raise ValueError("Unexpected forecast horizon")
    if any(not math.isfinite(v) for v in forecast):
        raise ValueError("Non-finite point forecast")
    for row in quantiles:
        if len(row) != 9 or any(not math.isfinite(q) for q in row):
            raise ValueError("Invalid quantiles")
        if any(a > b for a, b in zip(row, row[1:])):
            raise ValueError("Crossed quantiles")


def store_batch(db, campaign, windows, outputs, config):
    horizons = config["horizons"]
    if set(outputs) != {"timesfm_close", "timesfm_ohlcv"}:
        raise ValueError("Both model variants are required")
    if any(len(output) != len(windows) for output in outputs.values()):
        raise ValueError("Batch output count mismatch")
    records = []
    for index, window in enumerate(windows):
        prices = baselines(window.history, horizons, config["momentum_lookback"])
        quantiles = {}
        for model, results in outputs.items():
            forecast, qs = results[index]
            validate_output(forecast, qs, max(horizons))
            prices[model] = [float(forecast[h - 1]) for h in horizons]
            quantiles[model] = [encoded([float(q) for q in qs[h - 1]]) for h in horizons]
        for model in MODELS:
            for i, h in enumerate(horizons):
                records.append((campaign, window.symbol, window.origin, model, h,
                                window.future[h - 1].date, window.history[-1].adj_close,
                                window.future[h - 1].adj_close, prices[model][i],
                                quantiles[model][i] if model in quantiles else None))
    # Commit both variants, baselines, and all horizons together. A failed batch
    # leaves no half-written windows for the next run to mistake as complete.
    with db:
        db.executemany("INSERT OR REPLACE INTO forecasts VALUES (?,?,?,?,?,?,?,?,?,?)", records)


def infer_pending(db, campaign, pending, config, max_batches):
    if not pending:
        return 0
    import numpy as np
    import torch
    from timesfm3 import ModelConfig, TimesFM3Forecaster

    runtime = {name: version(name) for name in ("timesfm", "torch", "numpy", "safetensors")}
    runtime["python"] = sys.version.split()[0]
    previous = db.execute("SELECT runtime FROM campaigns WHERE id=?", (campaign,)).fetchone()[0]
    if previous and json.loads(previous) != runtime:
        raise ValueError("Runtime changed; use the locked dependencies or a separate cache")
    with db:
        db.execute("UPDATE campaigns SET runtime=? WHERE id=?", (encoded(runtime), campaign))
    settings = config["inference"]
    torch.set_num_threads(settings["threads"])
    torch.manual_seed(0)
    log(f"Loading {config['model']} on CPU...")
    started = perf_counter()
    model = TimesFM3Forecaster(ModelConfig(
        checkpoint_path=config["model"], revision=config["revision"], device="cpu",
        per_core_batch_size=settings["batch_size"],
    ))
    log(f"Model loaded in {perf_counter() - started:.2f}s; {len(pending)} windows pending")
    started = perf_counter()
    finished = 0
    for batch_index, offset in enumerate(range(0, len(pending), settings["batch_size"])):
        if max_batches is not None and batch_index >= max_batches:
            break
        batch = pending[offset:offset + settings["batch_size"]]
        inputs = [model_inputs(w.history) for w in batch]
        contexts = [np.asarray(target, dtype=np.float32) for target, _ in inputs]
        covariates = [np.asarray(cov, dtype=np.float32) for _, cov in inputs]
        outputs = {}
        with torch.inference_mode():
            for variant in ("timesfm_close", "timesfm_ohlcv"):
                results = list(model.predict_batch(
                    contexts=contexts, horizon=max(config["horizons"]),
                    past_only_covariates=covariates if variant == "timesfm_ohlcv" else None,
                    return_quantiles=True,
                    use_symmetric_averaging=settings["use_symmetric_averaging"],
                    use_znorm=settings["use_znorm"], sort_quantiles=settings["sort_quantiles"],
                ))
                outputs[variant] = [(r.forecast.tolist(), r.quantiles.tolist()) for r in results]
        store_batch(db, campaign, batch, outputs, config)
        finished += len(batch)
        elapsed = perf_counter() - started
        eta = elapsed / finished * (len(pending) - finished)
        log(f"Cached {finished}/{len(pending)} new windows; {elapsed:.1f}s elapsed; ETA {eta / 60:.1f} min")
    return finished


def direction(value, deadband):
    return 1 if value > deadband else -1 if value < -deadband else 0


def summarize(rows, config):
    errors, price_errors, correct, directions, actual_directions = [], [], [], [], []
    coverage, widths, pinballs = [], [], []
    quantile_hits = [0] * 9
    for row in rows:
        origin = row["origin_price"]
        actual_return = 100 * (row["actual_price"] / origin - 1)
        predicted_return = 100 * (row["forecast_price"] / origin - 1)
        errors.append(100 * abs(row["forecast_price"] - row["actual_price"]) / origin)
        price_errors.append(abs(row["forecast_price"] - row["actual_price"]))
        a, p = direction(actual_return, config["direction_deadband_pct"]), direction(predicted_return, config["direction_deadband_pct"])
        correct.append(a == p)
        actual_directions.append(a)
        directions.append(p)
        if row["quantiles"] is not None:
            qs = json.loads(row["quantiles"])
            coverage.append(qs[0] <= row["actual_price"] <= qs[-1])
            widths.append(100 * (qs[-1] - qs[0]) / origin)
            for i, (level, q) in enumerate(zip(QUANTILES, qs)):
                quantile_hits[i] += row["actual_price"] <= q
                error = 100 * (row["actual_price"] - q) / origin
                pinballs.append(max(level * error, (level - 1) * error))
    n = len(rows)
    recalls = [statistics.mean(c for c, a in zip(correct, actual_directions) if a == sign)
               for sign in (-1, 1) if sign in actual_directions]
    return {
        "n": n,
        "return_mae_pp": statistics.mean(errors),
        "price_mae": statistics.mean(price_errors),
        "direction_hits": sum(correct),
        "direction_accuracy_pct": 100 * statistics.mean(correct),
        "up_down_balanced_accuracy_pct": 100 * statistics.mean(recalls) if len(recalls) == 2 else None,
        "actual_up_pct": 100 * actual_directions.count(1) / n,
        "actual_flat_pct": 100 * actual_directions.count(0) / n,
        "predicted_nonflat_pct": 100 * sum(d != 0 for d in directions) / n,
        "near": {str(t): {"hits": sum(e <= t for e in errors),
                            "pct": 100 * sum(e <= t for e in errors) / n}
                 for t in config["near_tolerances_pct"]},
        "interval_80_coverage_pct": 100 * statistics.mean(coverage) if coverage else None,
        "interval_80_mean_width_pp": statistics.mean(widths) if widths else None,
        "mean_quantile_pinball_pp": statistics.mean(pinballs) if pinballs else None,
        "quantile_observed_coverage_pct": {str(q): 100 * hits / len(coverage)
                                           for q, hits in zip(QUANTILES, quantile_hits)} if coverage else None,
    }


def report_campaign(db, campaign):
    entry = db.execute("SELECT * FROM campaigns WHERE id=?", (campaign,)).fetchone()
    if entry is None:
        raise ValueError(f"Unknown campaign {campaign}")
    manifest = json.loads(entry["manifest"])
    config = manifest["config"]
    rows = list(db.execute("SELECT * FROM forecasts WHERE campaign=? ORDER BY symbol,origin,model,horizon", (campaign,)))
    # Derive coverage from the same materialized SELECT as metrics, so a writer
    # committing another batch cannot change the counts halfway through a report.
    complete = complete_keys(((r["symbol"], r["origin"], r["model"], r["horizon"]) for r in rows),
                             config["horizons"])
    if len(rows) != len(complete) * len(MODELS) * len(config["horizons"]):
        raise ValueError("Cache contains incomplete windows; rerun to repair before reporting")
    groups = defaultdict(list)
    for row in rows:
        for dimension, label in (("overall", "all"), ("symbol", row["symbol"]), ("year", row["origin"][:4])):
            groups[(dimension, label, row["model"], row["horizon"])].append(row)
    metrics = [{"group": dimension, "label": label, "model": model, "horizon": h,
                **summarize(values, config)}
               for (dimension, label, model, h), values in sorted(groups.items())]
    overall = {(m["model"], m["horizon"]): m for m in metrics if m["group"] == "overall"}
    comparisons = []
    for h in config["horizons"]:
        for model in ("timesfm_close", "timesfm_ohlcv"):
            if (model, h) not in overall:
                continue
            result = overall[(model, h)]
            baseline = overall[("unchanged", h)]
            stock_results = [m for m in metrics if m["group"] == "symbol" and m["model"] == model and m["horizon"] == h]
            stock_baselines = {m["label"]: m for m in metrics if m["group"] == "symbol" and m["model"] == "unchanged" and m["horizon"] == h}
            comparisons.append({
                "model": model, "horizon": h,
                "mae_skill_vs_unchanged_pct": 100 * (1 - result["return_mae_pp"] / baseline["return_mae_pp"]) if baseline["return_mae_pp"] else None,
                "symbols_beating_unchanged": sum(m["return_mae_pp"] < stock_baselines[m["label"]]["return_mae_pp"] for m in stock_results),
                "symbols_evaluated": len(stock_results),
                "equal_weight_symbol_mae_pp": statistics.mean(m["return_mae_pp"] for m in stock_results),
            })
    return {
        "campaign": campaign, "manifest": manifest,
        "status": "complete" if len(complete) == manifest["expected_windows"] else "partial",
        "completed_windows": len(complete), "forecast_rows": len(rows),
        "metrics": metrics, "comparisons": comparisons,
        "runtime": json.loads(entry["runtime"]) if entry["runtime"] else None,
        "limitations": [
            "Retrospective adjusted-data snapshot; not verified point-in-time data.",
            "Current fixed stock universe can introduce survivorship bias.",
            "Forecasts overlap in time and across stocks; counts are not independent trials.",
            "Holdout is reserved from this workflow, not guaranteed unseen during model pretraining.",
            "Direction and return errors are relative to the fixed origin close, not the previous forecast day.",
            "No portfolio returns or execution costs are inferred from forecast accuracy.",
        ],
    }


def write_report(report, output):
    folder = output / report["campaign"]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    lines = ["# TimesFM Rolling Benchmark", "", f"Status: {report['status']}",
             f"Windows: {report['completed_windows']}/{report['manifest']['expected_windows']}",
             f"Partition: {report['manifest']['partition']}", "",
             "MAE is in return percentage points. Higher near/direction accuracy is better.", "",
             "| Horizon | Model | N | MAE (pp) | Direction % | Within 1 pp % | 80% coverage % |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for m in sorted((m for m in report["metrics"] if m["group"] == "overall"), key=lambda m: (m["horizon"], m["model"])):
        coverage = f"{m['interval_80_coverage_pct']:.1f}" if m["interval_80_coverage_pct"] is not None else "n/a"
        near = m["near"].get("1.0", m["near"].get("1"))
        near_text = f"{near['pct']:.1f}" if near else "n/a"
        lines.append(f"| {m['horizon']} | {m['model']} | {m['n']} | {m['return_mae_pp']:.3f} | {m['direction_accuracy_pct']:.1f} | {near_text} | {coverage} |")
    lines.extend(["", "Full per-stock, per-year, quantile, and baseline comparisons are in report.json.", "",
                  *[f"- {item}" for item in report["limitations"]], ""])
    (folder / "report.md").write_text("\n".join(lines))
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "run", "report"))
    parser.add_argument("--config", type=Path, default=ROOT / "docs/timesfm-benchmark.json")
    parser.add_argument("--db", type=Path, default=Path.cwd() / "db/market.db")
    parser.add_argument("--cache", type=Path, default=Path.cwd() / ".autoresearch/timesfm/forecasts.db")
    parser.add_argument("--output", type=Path, default=Path.cwd() / ".autoresearch/timesfm")
    parser.add_argument("--partition", choices=("development", "holdout"), default="development")
    parser.add_argument("--unlock-holdout", action="store_true")
    parser.add_argument("--max-batches", type=int, help="Bound new work; rerun without this to finish")
    parser.add_argument("--campaign", help="Required for report; shown by plan/run")
    args = parser.parse_args()
    try:
        if args.cache.resolve() == args.db.resolve():
            raise ValueError("Cache must not be the source market database")
        if args.command == "report":
            if not args.campaign:
                raise ValueError("report requires --campaign")
            with closing(sqlite3.connect(args.cache.resolve().as_uri() + "?mode=ro", uri=True)) as db:
                db.row_factory = sqlite3.Row
                report = report_campaign(db, args.campaign)
            folder = write_report(report, args.output)
        else:
            config = json.loads(args.config.read_text())
            validate_config(config)
            if args.partition == "holdout" and not args.unlock_holdout:
                raise ValueError("Holdout is locked. Freeze research choices before using --unlock-holdout")
            if args.max_batches is not None and args.max_batches < 1:
                raise ValueError("--max-batches must be positive")
            data = read_data(args.db, config, args.partition)
            windows = make_windows(data, config, args.partition)
            manifest = create_manifest(config, data, windows, args.partition)
            if args.command == "plan":
                print(json.dumps({"campaign": fingerprint(manifest)[:20], **manifest}, indent=2))
                return
            with closing(open_cache(args.cache)) as db:
                campaign = register_campaign(db, manifest)
                complete = completed_windows(db, campaign, config["horizons"])
                pending = [w for w in windows if (w.symbol, w.origin) not in complete]
                log(f"Campaign {campaign}: {len(complete)}/{len(windows)} windows already cached")
                infer_pending(db, campaign, pending, config, args.max_batches)
                report = report_campaign(db, campaign)
                with db:
                    db.execute("UPDATE campaigns SET status=? WHERE id=?", (report["status"], campaign))
                if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError("Cache integrity check failed")
                folder = write_report(report, args.output)
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        print(json.dumps({"campaign": report["campaign"], "status": report["status"],
                          "completed_windows": report["completed_windows"], "report": str(folder / "report.md"),
                          "peak_process_rss_mib": peak / (1024**2 if sys.platform == "darwin" else 1024),
                          "comparisons": report["comparisons"]}, indent=2))
    except (ValueError, KeyError, OSError, sqlite3.Error) as exc:
        parser.exit(2, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
