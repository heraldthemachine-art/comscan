#!/usr/bin/env python3
"""Build a validated, public, read-only crypto OHLCV snapshot for paper research.

Only public Kraken market data is fetched. No exchange credentials or orders.
The newest uncommitted Kraken candle is always discarded.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import pathlib
import sys
import time
import urllib.parse
import urllib.request

INTERVALS = (5, 15, 60, 240)
PAIRS = ("SOLUSD", "XBTUSD")
MIN_BARS = 100
SAVE_BARS = 120


def utc_text(epoch: int | float) -> str:
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def get_candles(pair: str, interval: int, now: int) -> tuple[dict, dict]:
    url = "https://api.kraken.com/0/public/OHLC?" + urllib.parse.urlencode({
        "pair": pair, "interval": interval,
    })
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "SOL-Paper-OHLCV-Research/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise ValueError(f"Kraken {pair}/{interval}: HTTP {response.status}")
        payload = json.load(response)

    if not isinstance(payload, dict) or payload.get("error"):
        raise ValueError(f"Kraken {pair}/{interval}: API error {payload.get('error')!r}")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise ValueError(f"Kraken {pair}/{interval}: missing result")
    keys = [key for key, value in result.items() if key != "last" and isinstance(value, list)]
    if len(keys) != 1:
        raise ValueError(f"Kraken {pair}/{interval}: unexpected series keys {keys!r}")

    raw = result[keys[0]]
    if len(raw) < MIN_BARS + 1:
        raise ValueError(f"Kraken {pair}/{interval}: fewer than 100 completed bars")
    period = interval * 60
    # Kraken normally adds the currently forming bar last. Discard it, then
    # independently drop ANY row whose close falls after retrieval time.
    raw = [row for row in raw[:-1] if int(row[0]) + period <= now]
    bars = []
    for record in raw[-SAVE_BARS:]:
        if not isinstance(record, list) or len(record) < 8:
            raise ValueError(f"Kraken {pair}/{interval}: malformed OHLC row")
        start = int(record[0])
        o, h, l, c, v = (float(record[i]) for i in (1, 2, 3, 4, 6))
        count = int(record[7])
        if not all(math.isfinite(x) for x in (o, h, l, c, v)):
            raise ValueError(f"Kraken {pair}/{interval}: nonfinite value")
        if min(o, h, l, c) <= 0 or v < 0 or count < 0 or h < max(o, c, l) or l > min(o, c, h):
            raise ValueError(f"Kraken {pair}/{interval}: invalid OHLCV")
        if start % period != 0 or start + period > now:
            raise ValueError(f"Kraken {pair}/{interval}: noncompleted/misaligned bar")
        bars.append([start, o, h, l, c, v, count])

    latest100 = bars[-MIN_BARS:]
    if len(latest100) < MIN_BARS:
        raise ValueError(f"Kraken {pair}/{interval}: insufficient validated bars")
    if any((b[0] - a[0]) != period for a, b in zip(latest100, latest100[1:])):
        raise ValueError(f"Kraken {pair}/{interval}: gaps or duplicate times in last 100")
    last_close = latest100[-1][0] + period
    age = now - last_close
    if age < 0 or age > period + 120:
        raise ValueError(f"Kraken {pair}/{interval}: last closed bar age {age}s is outside limit")

    label = f"{pair}-{interval}m"
    document = {
        "schema": "sol-paper-ohlcv/v1",
        "provider": "Kraken public REST OHLC",
        "pair": pair,
        "interval_minutes": interval,
        "source_url": url,
        "fetched_at_utc": utc_text(now),
        "last_completed_close_utc": utc_text(last_close),
        "last_completed_close_epoch": last_close,
        "latest_bar_close_age_seconds": age,
        "volume_unit": "base asset units",
        "columns": ["bar_open_epoch_utc", "open", "high", "low", "close", "base_volume", "trade_count"],
        "complete_only": True,
        "status": "PASS",
        "candles": bars,
    }
    summary = {
        "status": "PASS",
        "pair": pair,
        "interval_minutes": interval,
        "rows": len(bars),
        "latest100_continuous": True,
        "last_completed_close_epoch": last_close,
        "last_completed_close_utc": utc_text(last_close),
        "age_seconds": age,
        "source_url": url,
        "file": f"{label}.json",
    }
    return document, summary


def main() -> None:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "market/ohlcv")
    out.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    series: dict[str, dict] = {}
    summaries = {}
    for pair in PAIRS:
        for interval in INTERVALS:
            doc, info = get_candles(pair, interval, now)
            name = f"{pair}-{interval}m"
            series[name] = doc
            summaries[name] = info
            print(f"PASS {name}: {info['rows']} bars; last age {info['age_seconds']} seconds", flush=True)
            time.sleep(0.4)

    for name, document in series.items():
        (out / f"{name}.json").write_text(json.dumps(document, separators=(",", ":"), allow_nan=False) + "\n")
    manifest = {
        "schema": "sol-paper-ohlcv-manifest/v1",
        "status": "PASS",
        "fetched_at_utc": utc_text(now),
        "fetched_at_epoch": now,
        "source": "Kraken public REST OHLC; indicative USD venue candles, not SOL/USDC executions",
        "not_financial_advice": True,
        "series": summaries,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":"), allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
