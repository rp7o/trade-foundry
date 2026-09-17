"""Run with python3 -m unittest discover -s test -p 'test_timesfm_*.py'."""

from dataclasses import replace
from datetime import date, timedelta
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import timesfm_benchmark as benchmark


def config():
    value = json.loads((benchmark.ROOT / "docs/timesfm-benchmark.json").read_text())
    value.update(symbols=["TEST"], context=32, stride=2, horizons=[1, 5], momentum_lookback=10)
    value["development"] = {"start": "2024-02-01", "end": "2024-03-10"}
    value["holdout"] = {"start": "2024-03-11", "end": "2024-04-01"}
    return value


def candles():
    return tuple(benchmark.Candle(
        (date(2024, 1, 1) + timedelta(days=i)).isoformat(),
        99 + i, 102 + i, 98 + i, 100 + i, (100 + i) * 0.5, 1000 + i,
    ) for i in range(92))


def fake_outputs(windows, settings):
    horizon = max(settings["horizons"])
    output = []
    for window in windows:
        p = window.history[-1].adj_close
        output.append(([p] * horizon, [[p + i for i in range(-4, 5)] for _ in range(horizon)]))
    return {"timesfm_close": output, "timesfm_ohlcv": output}


class BenchmarkTests(unittest.TestCase):
    def test_configuration_rejects_overlap_and_bad_horizons(self):
        settings = config()
        benchmark.validate_config(settings)
        settings["holdout"]["start"] = settings["development"]["end"]
        with self.assertRaises(ValueError):
            benchmark.validate_config(settings)
        settings = config()
        settings["horizons"] = [5, 1]
        with self.assertRaises(ValueError):
            benchmark.validate_config(settings)

    def test_horizons_end_inside_partition_and_are_session_offsets(self):
        settings = config()
        data = {"TEST": candles()}
        windows = benchmark.make_windows(data, settings, "development")
        self.assertTrue(windows)
        self.assertEqual(windows[0].origin, "2024-02-01")
        for window in windows:
            self.assertEqual(len(window.history), 32)
            self.assertEqual(len(window.future), 5)
            self.assertLess(window.origin, window.future[0].date)
            self.assertLessEqual(window.future[-1].date, settings["development"]["end"])
        # Missing sessions do not get interpolated as if they were trading days.
        sparse = {"TEST": tuple(c for i, c in enumerate(candles()) if i % 7 not in (5, 6))}
        window = benchmark.make_windows(sparse, settings, "development")[0]
        index = sparse["TEST"].index(window.history[-1])
        self.assertEqual(window.future[4], sparse["TEST"][index + 5])

    def test_future_mutation_cannot_change_inputs_or_baselines(self):
        settings = config()
        original = benchmark.make_windows({"TEST": candles()}, settings, "development")[0]
        changed = {"TEST": tuple(replace(c, adj_close=c.adj_close * 9, volume=999999)
                                  if c.date > original.origin else c for c in candles())}
        other = benchmark.make_windows(changed, settings, "development")[0]
        self.assertNotEqual(original.future, other.future)
        self.assertEqual(benchmark.model_inputs(original.history), benchmark.model_inputs(other.history))
        self.assertEqual(benchmark.baselines(original.history, [1, 5], 10),
                         benchmark.baselines(other.history, [1, 5], 10))

    def test_adjustment_and_volume_channels(self):
        target, covariates = benchmark.model_inputs(candles()[:1])
        self.assertEqual(target, [50])
        self.assertEqual(covariates, [[49.5], [51], [49], [1000]])
        benchmark.validate_candles("TEST", [replace(candles()[0], volume=0)])

    def test_development_query_excludes_holdout_and_preserves_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.db"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE prices(symbol,date,open,high,low,close,adj_close,volume)")
                db.executemany("INSERT INTO prices VALUES (?,?,?,?,?,?,?,?)",
                               [("TEST", *c.__dict__.values()) for c in candles()])
                db.execute("UPDATE prices SET adj_close=-1 WHERE date > '2024-03-10'")
            before = path.read_bytes()
            data = benchmark.read_data(path, config(), "development")
            self.assertEqual(data["TEST"][-1].date, "2024-03-10")
            self.assertEqual(before, path.read_bytes())
            with self.assertRaises(ValueError):
                benchmark.read_data(path, config(), "holdout")

    def test_metrics_known_values_and_flat_baseline(self):
        rows = [dict(origin_price=100, actual_price=102, forecast_price=101,
                     quantiles=json.dumps(list(range(97, 106)))),
                dict(origin_price=100, actual_price=98, forecast_price=99,
                     quantiles=json.dumps(list(range(95, 104))))]
        summary = benchmark.summarize(rows, config())
        self.assertAlmostEqual(summary["return_mae_pp"], 1)
        self.assertEqual(summary["near"]["1.0"]["hits"], 2)
        self.assertEqual(summary["direction_hits"], 2)
        self.assertEqual(summary["up_down_balanced_accuracy_pct"], 100)
        self.assertEqual(summary["interval_80_coverage_pct"], 100)
        self.assertEqual(summary["interval_80_mean_width_pp"], 8)
        self.assertEqual(summary["quantile_observed_coverage_pct"]["0.9"], 100)
        for row in rows:
            row.update(forecast_price=100, quantiles=None)
        summary = benchmark.summarize(rows, config())
        self.assertEqual(summary["direction_accuracy_pct"], 0)
        self.assertIsNone(summary["interval_80_coverage_pct"])

    def test_return_error_is_scale_invariant(self):
        first = dict(origin_price=100, actual_price=110, forecast_price=105, quantiles=None)
        second = {key: value * 0.01 if value is not None else None for key, value in first.items()}
        self.assertAlmostEqual(benchmark.summarize([first], config())["return_mae_pp"],
                               benchmark.summarize([second], config())["return_mae_pp"])

    def test_cache_atomicity_resume_and_data_identity(self):
        settings = config()
        data = {"TEST": candles()}
        windows = benchmark.make_windows(data, settings, "development")
        manifest = benchmark.create_manifest(settings, data, windows, "development")
        with tempfile.TemporaryDirectory() as directory:
            db = benchmark.open_cache(Path(directory) / "cache.db")
            try:
                campaign = benchmark.register_campaign(db, manifest)
                bad = fake_outputs(windows[:2], settings)
                bad["timesfm_ohlcv"] = bad["timesfm_ohlcv"][:1]
                with self.assertRaises(ValueError):
                    benchmark.store_batch(db, campaign, windows[:2], bad, settings)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0], 0)
                benchmark.store_batch(db, campaign, windows[:2], fake_outputs(windows[:2], settings), settings)
                self.assertEqual(len(benchmark.completed_windows(db, campaign, settings["horizons"])), 2)
                self.assertEqual(benchmark.report_campaign(db, campaign)["status"], "partial")
                benchmark.store_batch(db, campaign, windows, fake_outputs(windows, settings), settings)
                count = len(windows) * len(benchmark.MODELS) * len(settings["horizons"])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0], count)
                report = benchmark.report_campaign(db, campaign)
                self.assertEqual(report["status"], "complete")
                self.assertTrue(all(c["mae_skill_vs_unchanged_pct"] == 0 for c in report["comparisons"]))
                other_data = {"TEST": (replace(candles()[0], volume=1), *candles()[1:])}
                other_manifest = benchmark.create_manifest(settings, other_data, windows, "development")
                self.assertNotEqual(campaign, benchmark.register_campaign(db, other_manifest))
                db.execute("DELETE FROM forecasts WHERE campaign=? AND rowid=(SELECT MIN(rowid) FROM forecasts)", (campaign,))
                db.commit()
                with self.assertRaisesRegex(ValueError, "incomplete"):
                    benchmark.report_campaign(db, campaign)
            finally:
                db.close()

    def test_report_remains_consistent_when_another_batch_commits(self):
        settings = config()
        data = {"TEST": candles()}
        windows = benchmark.make_windows(data, settings, "development")
        manifest = benchmark.create_manifest(settings, data, windows, "development")
        with tempfile.TemporaryDirectory() as directory:
            db = benchmark.open_cache(Path(directory) / "cache.db")
            try:
                campaign = benchmark.register_campaign(db, manifest)
                benchmark.store_batch(db, campaign, windows[:1], fake_outputs(windows[:1], settings), settings)

                class ConcurrentWriter:
                    def execute(self, query, parameters):
                        cursor = db.execute(query, parameters)
                        if query.startswith("SELECT * FROM forecasts"):
                            snapshot = cursor.fetchall()
                            benchmark.store_batch(db, campaign, windows[1:2],
                                                  fake_outputs(windows[1:2], settings), settings)
                            return iter(snapshot)
                        return cursor

                report = benchmark.report_campaign(ConcurrentWriter(), campaign)
                self.assertEqual(report["completed_windows"], 1)
                self.assertEqual(report["forecast_rows"], 8)
                self.assertEqual(len(benchmark.completed_windows(db, campaign, settings["horizons"])), 2)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
