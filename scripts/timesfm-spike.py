# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["timesfm[torch]==3.0.1", "torch==2.10.0"]
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""CPU-only TimesFM smoke test: uv run scripts/timesfm-spike.py."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import resource
import sqlite3
import sys
from time import perf_counter


MODEL = "google/timesfm-3.0-pytorch"
REVISION = "43046b85ec22d584a13f8098c2ed39c889e129c2"
ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path.cwd() / "db/market.db")
    parser.add_argument("--symbol", default="CBA.AX")
    parser.add_argument("--context", type=int, default=256)
    parser.add_argument("--horizon", type=int, default=10)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if not 32 <= args.context <= 15360:
        parser.error("--context must be between 32 and 15360")
    if not 1 <= args.horizon <= 64:
        parser.error("--horizon must be between 1 and 64 for this spike")
    if args.threads < 1:
        parser.error("--threads must be positive")

    # Read only; hold out the last horizon rows before calling the model.
    with closing(sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute(
            "SELECT date, open, high, low, close, adj_close, volume "
            "FROM prices WHERE symbol = ? "
            "ORDER BY date DESC LIMIT ?",
            (args.symbol, args.context + args.horizon),
        ).fetchall()[::-1]
    if len(rows) != args.context + args.horizon:
        parser.error(f"{args.symbol}: need {args.context + args.horizon} rows; got {len(rows)}")

    import numpy as np
    import torch
    from timesfm3 import ModelConfig, TimesFM3Forecaster

    values = np.asarray([row[1:] for row in rows], dtype=np.float32)
    if not np.isfinite(values).all() or (values <= 0).any():
        parser.error("OHLC, adjusted close, and volume must be finite and positive")
    # Apply each day's close adjustment factor to OHL so all price variates are
    # on the same split/dividend-adjusted scale as the target.
    adjustment = values[:, 4] / values[:, 3]
    adjusted_ohl = values[:, :3] * adjustment[:, None]
    target = values[:, 4]
    covariates = np.column_stack((adjusted_ohl, values[:, 5])).T
    history, actual = target[:args.context], target[args.context:]
    history_covariates = covariates[:, :args.context]
    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    print(f"{args.symbol}: {args.context} context rows through {rows[args.context - 1][0]}, "
          f"{args.horizon} held-out rows through {rows[-1][0]}", file=sys.stderr, flush=True)
    print("Loading TimesFM on CPU (first run downloads the weights)...", file=sys.stderr, flush=True)
    started = perf_counter()
    model = TimesFM3Forecaster(ModelConfig(
        checkpoint_path=MODEL,
        revision=REVISION,
        device="cpu",
        per_core_batch_size=1,
    ))
    load_seconds = perf_counter() - started
    print("Forecasting with and without OHLV covariates...", file=sys.stderr, flush=True)
    started = perf_counter()
    with torch.inference_mode():
        univariate_result = model.predict(
            history, horizon=args.horizon, return_quantiles=True,
            use_symmetric_averaging=False,
        )
        result = model.predict(
            history, horizon=args.horizon,
            past_only_covariates=history_covariates,
            return_quantiles=True, use_symmetric_averaging=False,
        )
    inference_seconds = perf_counter() - started
    univariate_forecast = np.asarray(univariate_result.forecast)
    forecast, quantiles = np.asarray(result.forecast), np.asarray(result.quantiles)
    if forecast.shape != (args.horizon,) or quantiles.shape != (args.horizon, 9):
        raise RuntimeError(f"Unexpected output shapes: {forecast.shape}, {quantiles.shape}")
    if not np.isfinite(forecast).all() or not np.isfinite(quantiles).all():
        raise RuntimeError("Model returned non-finite outputs")

    baseline = np.full_like(actual, history[-1])
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report = {
        "model": MODEL,
        "revision": REVISION,
        "device": "cpu",
        "torch_version": torch.__version__,
        "threads": args.threads,
        "symbol": args.symbol,
        "price_field": "adj_close",
        "past_only_covariates": ["adjusted_open", "adjusted_high", "adjusted_low", "volume"],
        "context_rows": args.context,
        "context_start": rows[0][0],
        "forecast_origin": rows[args.context - 1][0],
        "horizon": args.horizon,
        "load_seconds": round(load_seconds, 3),
        "inference_seconds": round(inference_seconds, 3),
        "peak_process_rss_mib": round(peak_rss / (1024**2 if sys.platform == "darwin" else 1024), 1),
        "multivariate_model_mae": float(np.abs(forecast - actual).mean()),
        "univariate_model_mae": float(np.abs(univariate_forecast - actual).mean()),
        "unchanged_price_mae": float(np.abs(baseline - actual).mean()),
        "quantile_crossings": int((np.diff(quantiles, axis=1) < 0).sum()),
        "predictions": [
            {"date": row[0], "actual": float(observed), "forecast": float(predicted),
             "q10": float(q[0]), "q90": float(q[8])}
            for row, observed, predicted, q in zip(rows[args.context:], actual, forecast, quantiles)
        ],
        "note": "One retrospective window tests inference only; it does not establish trading value.",
    }
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
