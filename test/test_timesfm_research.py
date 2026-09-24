"""Run with python3 -m unittest discover -s test -p 'test_timesfm_*.py'."""

from contextlib import contextmanager
from dataclasses import replace
from datetime import date, timedelta
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import timesfm_inputs as inputs
import timesfm_research as research


def settings():
    return {
        "model": "google/timesfm-3.0-pytorch",
        "revision": "43046b85ec22d584a13f8098c2ed39c889e129c2",
        "variant": "timesfm_ohlcv",
        "context": 32,
        "stride": 2,
        "horizon": 10,
        "inference": {
            "batch_size": 2,
            "threads": 1,
            "use_symmetric_averaging": False,
            "use_znorm": False,
            "sort_quantiles": True,
        },
    }


def request(**changes):
    value = {
        "settings": settings(),
        "symbols": ["TEST"],
        "ranges": [
            {"name": "first", "start": "2024-02-01", "end": "2024-02-15"},
            {"name": "second", "start": "2024-02-16", "end": "2024-03-01"},
        ],
    }
    value.update(changes)
    return value


def candles(count=92):
    return tuple(inputs.Candle(
        (date(2024, 1, 1) + timedelta(days=index)).isoformat(),
        99 + index, 102 + index, 98 + index, 100 + index,
        (100 + index) * 0.5, 1000 + index,
    ) for index in range(count))


class ResearchTests(unittest.TestCase):
    def test_main_plan_lifecycle_resume_and_alias_safety(self):
        current = request()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            market = root / "market.db"
            cache = root / "research-cache.db"
            request_path = root / "request.json"
            request_path.write_text(json.dumps(current))
            with sqlite3.connect(market) as db:
                db.execute("CREATE TABLE prices(symbol,date,open,high,low,close,adj_close,volume)")
                db.executemany("INSERT INTO prices VALUES (?,?,?,?,?,?,?,?)",
                               [("TEST", *candle.__dict__.values()) for candle in candles()])

            def invoke(command, cache_path=cache, *extra):
                argv = ["timesfm-research.py", command, "--request", str(request_path),
                        "--db", str(market), "--cache", str(cache_path), *extra]
                with patch.object(sys, "argv", argv), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    research.main()

            invoke("plan")
            self.assertFalse(cache.exists(), "plan must not create or write a cache")

            calls = []

            def fake_infer(db, pending, model_settings, max_batches=None):
                calls.append((len(pending), max_batches))
                limit = len(pending) if max_batches is None else model_settings["inference"]["batch_size"] * max_batches
                batch = pending[:limit]
                research.store_batch(db, batch, [100 + index for index in range(len(batch))])

            with patch.object(research, "infer_pending", side_effect=fake_infer):
                invoke("run", cache, "--max-batches", "1")
            with sqlite3.connect(cache) as db:
                campaign, status, predictions = db.execute(
                    "SELECT id, status, (SELECT COUNT(*) FROM predictions) FROM campaigns"
                ).fetchone()
                self.assertEqual(status, "partial")
                self.assertGreater(predictions, 0)
            self.assertEqual(calls, [(len(research.make_windows({"TEST": candles()}, current)[0]), 1)])

            def failed_infer(*args, **kwargs):
                raise ValueError("mock inference failure")

            with patch.object(research, "infer_pending", side_effect=failed_infer):
                with self.assertRaises(SystemExit) as raised:
                    invoke("run")
            self.assertEqual(raised.exception.code, 2)
            with sqlite3.connect(cache) as db:
                self.assertEqual(db.execute("SELECT status FROM campaigns WHERE id=?", (campaign,)).fetchone()[0],
                                 "partial")

            with patch.object(research, "infer_pending", side_effect=fake_infer):
                invoke("run")
            with sqlite3.connect(cache) as db:
                self.assertEqual(db.execute("SELECT status FROM campaigns WHERE id=?", (campaign,)).fetchone()[0],
                                 "complete")

            def no_model_on_empty(db, pending, model_settings, max_batches=None):
                self.assertFalse(pending, "a complete campaign must not invoke model inference")

            with patch.object(research, "infer_pending", side_effect=no_model_on_empty):
                invoke("run")

            hardlink = root / "market-hardlink.db"
            os.link(market, hardlink)
            with self.assertRaises(SystemExit) as raised:
                invoke("run", hardlink)
            self.assertEqual(raised.exception.code, 2)

    def test_request_validation_rejects_bad_identity_and_ranges(self):
        research.validate_request(request())
        bad = request(settings={**settings(), "revision": "x" * 40})
        with self.assertRaises(ValueError):
            research.validate_request(bad)
        bad = request(ranges=[
            {"name": "same", "start": "2024-02-01", "end": "2024-02-15"},
            {"name": "same", "start": "2024-02-16", "end": "2024-03-01"},
        ])
        with self.assertRaises(ValueError):
            research.validate_request(bad)
        bad = request(ranges=[
            {"name": "first", "start": "2024-02-01", "end": "2024-02-20"},
            {"name": "second", "start": "2024-02-15", "end": "2024-03-01"},
        ])
        with self.assertRaises(ValueError):
            research.validate_request(bad)

    def test_model_inputs_are_past_only_and_adjusted(self):
        history = candles()[:2]
        target, covariates = inputs.model_inputs(history)
        self.assertEqual(target, [50, 50.5])
        self.assertEqual(covariates, [[49.5, 50], [51, 51.5], [49, 49.5], [1000, 1001]])
        changed = tuple(replace(candle, adj_close=999, volume=999999)
                        if candle.date > history[-1].date else candle for candle in candles())
        self.assertEqual(inputs.model_inputs(history), inputs.model_inputs(changed[:2]))

    def test_windows_have_no_future_rows_and_cover_each_range(self):
        current = request()
        windows, coverage = research.make_windows({"TEST": candles()}, current)
        self.assertTrue(windows)
        self.assertTrue(all(len(window.history) == 32 for window in windows))
        self.assertEqual(coverage["TEST"], {"first": 8, "second": 7})
        self.assertTrue(all(window.origin <= "2024-03-01" for window in windows))
        changed = {"TEST": tuple(replace(candle, adj_close=999)
                                  if candle.date > windows[0].origin else candle for candle in candles())}
        other, _ = research.make_windows(changed, current)
        self.assertEqual(windows[0].key, other[0].key)

    def test_read_data_is_read_only_and_excludes_future_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.db"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE prices(symbol,date,open,high,low,close,adj_close,volume)")
                db.executemany("INSERT INTO prices VALUES (?,?,?,?,?,?,?,?)",
                               [("TEST", *candle.__dict__.values()) for candle in candles()])
                db.execute("UPDATE prices SET adj_close=-1 WHERE date > '2024-03-01'")
            before = path.read_bytes()
            data = research.read_data(path, request())
            self.assertEqual(data["TEST"][-1].date, "2024-03-01")
            self.assertEqual(before, path.read_bytes())
            with self.assertRaises(ValueError):
                research.open_cache(path)

    def test_cache_is_atomic_resumable_and_identity_bound(self):
        current = request()
        windows, _ = research.make_windows({"TEST": candles()}, current)
        with tempfile.TemporaryDirectory() as directory:
            db = research.open_cache(Path(directory) / "cache.db")
            try:
                campaign = research.register_campaign(db, current, windows)
                with self.assertRaises(ValueError):
                    research.store_batch(db, windows[:2], [100, float("nan")])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 0)
                research.store_batch(db, windows[:2], [100, 101])
                self.assertEqual(len(research.pending_windows(db, windows)), len(windows) - 2)
                db.execute("UPDATE campaigns SET status='partial' WHERE id=?", (campaign,))
                research.store_batch(db, windows[2:], [100 + index for index in range(len(windows) - 2)])
                self.assertEqual(research.pending_windows(db, windows), [])
                db.execute("UPDATE campaigns SET status='complete' WHERE id=?", (campaign,))
                self.assertEqual(db.execute("SELECT status FROM campaigns WHERE id=?", (campaign,)).fetchone()[0],
                                 "complete")
                changed = request(settings={**settings(), "stride": 1})
                changed_windows, _ = research.make_windows({"TEST": candles()}, changed)
                self.assertNotEqual(windows[0].key, changed_windows[0].key)
                changed_data = {"TEST": (replace(candles()[0], volume=1), *candles()[1:])}
                changed_data_windows, _ = research.make_windows(changed_data, current)
                self.assertNotEqual(windows[0].key, changed_data_windows[0].key)
            finally:
                db.close()

    def test_mocked_model_inference_caches_and_rejects_invalid_output(self):
        current = request()
        windows, _ = research.make_windows({"TEST": candles()}, current)
        calls = []

        class FakeTorch:
            def set_num_threads(self, value):
                calls.append(("threads", value))

            def manual_seed(self, value):
                calls.append(("seed", value))

            @staticmethod
            @contextmanager
            def inference_mode():
                yield

        class FakeModel:
            def predict_batch(self, **kwargs):
                calls.append(kwargs)
                self.seen = kwargs
                return [types.SimpleNamespace(forecast=[100 + i] * 10)
                        for i, _ in enumerate(kwargs["contexts"])]

        fake_timesfm = types.SimpleNamespace(
            ModelConfig=lambda **kwargs: kwargs,
            TimesFM3Forecaster=lambda config: FakeModel(),
        )
        fake_numpy = types.SimpleNamespace(asarray=lambda value, dtype=None: value, float32=float)
        with tempfile.TemporaryDirectory() as directory:
            db = research.open_cache(Path(directory) / "cache.db")
            try:
                campaign = research.register_campaign(db, current, windows)
                with patch.dict(sys.modules, {"torch": FakeTorch(), "numpy": fake_numpy,
                                              "timesfm3": fake_timesfm}):
                    research.infer_pending(db, windows[:2], current["settings"])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 2)
                self.assertIsNotNone(calls[2]["past_only_covariates"])
                class BadModel(FakeModel):
                    def predict_batch(self, **kwargs):
                        return [types.SimpleNamespace(forecast=[100] * 9) for _ in kwargs["contexts"]]
                fake_timesfm.TimesFM3Forecaster = lambda config: BadModel()
                with patch.dict(sys.modules, {"torch": FakeTorch(), "numpy": fake_numpy,
                                              "timesfm3": fake_timesfm}):
                    with self.assertRaises(ValueError):
                        research.infer_pending(db, windows[2:4], current["settings"])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM predictions").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT status FROM campaigns WHERE id=?", (campaign,)).fetchone()[0],
                                 "partial")
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
