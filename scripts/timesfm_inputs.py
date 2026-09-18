"""Small, stdlib-only helpers shared by the TimesFM research runner."""

from dataclasses import dataclass
from datetime import date
import hashlib
import json
import math


def encoded(value):
    """Encode manifest values deterministically and reject non-finite JSON."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Candle:
    date: str
    open: float
    high: float
    low: float
    close: float
    adj_close: float
    volume: float


def validate_candles(symbol, candles):
    """Validate ordered, finite OHLCV rows before they cross the model boundary."""
    previous = ""
    for candle in candles:
        if not isinstance(candle.date, str):
            raise ValueError(f"{symbol}: dates must be ISO, increasing, and unique")
        try:
            canonical = date.fromisoformat(candle.date).isoformat()
        except (TypeError, ValueError):
            raise ValueError(f"{symbol}: dates must be ISO, increasing, and unique") from None
        if canonical != candle.date or candle.date <= previous:
            raise ValueError(f"{symbol}: dates must be ISO, increasing, and unique")
        prices = (candle.open, candle.high, candle.low, candle.close, candle.adj_close)
        if any(not isinstance(value, (int, float)) or isinstance(value, bool)
               or not math.isfinite(value) or value <= 0 for value in prices):
            raise ValueError(f"{symbol} {candle.date}: invalid price")
        if (candle.high < candle.low or not isinstance(candle.volume, (int, float))
                or isinstance(candle.volume, bool) or not math.isfinite(candle.volume)
                or candle.volume < 0):
            raise ValueError(f"{symbol} {candle.date}: invalid range or volume")
        previous = candle.date


def model_inputs(history):
    """Return adjusted-close target plus past-only adjusted OHLC and volume channels."""
    target = [c.adj_close for c in history]
    covariates = [[], [], [], []]
    for candle in history:
        factor = candle.adj_close / candle.close
        for series, value in zip(
            covariates,
            (candle.open * factor, candle.high * factor, candle.low * factor, candle.volume),
        ):
            series.append(value)
    return target, covariates
