#!/usr/bin/env python3
"""Attach timestamped, independently corroborated public SOL/BTC spot evidence.

Adds an OPTIONAL quote_verification section to the immutable-candle manifest.
Candle publication must never fail just because a quote provider is unavailable.
No keys, wallets, orders, or executable SOL/USDC price claims.
"""
from __future__ import annotations

import datetime as dt
import itertools
import json
import math
import pathlib
import sys
import time
import urllib.request

PROVIDERS = {
    "SOL": (
        ("Coinbase Exchange", "USD", "https://api.exchange.coinbase.com/products/SOL-USD/ticker"),
        ("Kraken", "USD", "https://api.kraken.com/0/public/Trades?pair=SOLUSD&count=1"),
        ("Binance.US", "USDT", "https://api.binance.us/api/v3/trades?symbol=SOLUSDT&limit=1"),
    ),
    "BTC": (
        ("Coinbase Exchange", "USD", "https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
        ("Kraken", "USD", "https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=1"),
        ("Binance.US", "USDT", "https://api.binance.us/api/v3/trades?symbol=BTCUSDT&limit=1"),
    ),
}
MAX_QUOTE_AGE_SEC = 600
MAX_PAIR_SKEW_SEC = 600
MAX_DIVERGENCE = 0.0075


def utc_text(seconds: float) -> str:
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_json(url: str) -> object:
    request = urllib.request.Request(
        url, headers={"User-Agent": "SOL-Paper-Quote-Audit/1.0", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=6) as response:
        if response.status != 200:
            raise ValueError("HTTP_" + str(response.status))
        return json.load(response)


def parse_quote(provider: str, asset: str, denomination: str, url: str,
                document: object, now: float) -> dict:
    if provider == "Coinbase Exchange":
        price = float(document["price"])
        stamp = dt.datetime.fromisoformat(document["time"].replace("Z", "+00:00")).timestamp()
    elif provider == "Kraken":
        if document.get("error"):
            raise ValueError("KRAKEN_ERROR")
        result = document.get("result", {})
        keys = [key for key, value in result.items() if key != "last" and isinstance(value, list)]
        if len(keys) != 1 or not result[keys[0]]:
            raise ValueError("KRAKEN_TRADE_MISSING")
        row = result[keys[0]][-1]
        price, stamp = float(row[0]), float(row[2])
    elif provider == "Binance.US":
        if not isinstance(document, list) or not document:
            raise ValueError("BINANCE_TRADE_MISSING")
        row = document[-1]
        price, stamp = float(row["price"]), float(row["time"]) / 1000.0
    else:
        raise ValueError("UNKNOWN_PROVIDER")

    age = now - stamp
    if not math.isfinite(price) or price <= 0 or not math.isfinite(stamp):
        raise ValueError("INVALID_QUOTE")
    if age < -30 or age > MAX_QUOTE_AGE_SEC:
        raise ValueError("STALE_QUOTE")
    return {
        "provider": provider, "asset": asset, "quote_currency": denomination,
        "price": price, "trade_time_utc": utc_text(stamp),
        "trade_epoch_seconds": stamp, "age_seconds_at_capture": round(age, 1),
        "source_url": url,
    }


def choose_pair(available: list[dict]) -> dict | None:
    eligible = []
    for a, b in itertools.combinations(available, 2):
        if a["provider"] == b["provider"]:
            continue
        skew = abs(a["trade_epoch_seconds"] - b["trade_epoch_seconds"])
        divergence = abs(a["price"] - b["price"]) / ((a["price"] + b["price"]) / 2)
        if skew <= MAX_PAIR_SKEW_SEC and divergence <= MAX_DIVERGENCE:
            # Prefer two actual USD quotes, never silently equate USDT with USD.
            score = (int(a["quote_currency"] == "USD") + int(b["quote_currency"] == "USD"),
                     -divergence, -skew)
            eligible.append((score, a, b, divergence, skew))
    if not eligible:
        return None
    _, a, b, divergence, skew = max(eligible, key=lambda p: p[0])
    all_usd = a["quote_currency"] == b["quote_currency"] == "USD"
    return {
        "status": "PASS", "sources": [a, b],
        "indicative_average": (a["price"] + b["price"]) / 2,
        "indicative_currency": "USD" if all_usd else "MIXED_USD_USDT_PROXY",
        "divergence_pct": round(divergence * 100, 5),
        "timestamp_skew_seconds": round(skew, 1),
        "executable_sol_usdc_quote": False,
    }


def assess(now: float, fetcher=fetch_json) -> dict:
    per_asset = {}
    for asset, providers in PROVIDERS.items():
        good, failures = [], []
        for provider, currency, url in providers:
            try:
                good.append(parse_quote(provider, asset, currency, url, fetcher(url), now))
            except Exception as error:
                failures.append({"provider": provider, "reason": str(error)[:120]})
        pair = choose_pair(good)
        per_asset[asset] = {
            "status": "PASS" if pair else "DATA_UNAVAILABLE",
            "selected": pair, "available": good, "failures": failures
        }
    ready = all(v["status"] == "PASS" for v in per_asset.values())
    return {
        "status": "PASS" if ready else "DATA_UNAVAILABLE",
        "checked_at_utc": utc_text(now),
        "maximum_age_seconds": MAX_QUOTE_AGE_SEC,
        "maximum_skew_seconds": MAX_PAIR_SKEW_SEC,
        "maximum_divergence_pct": MAX_DIVERGENCE * 100,
        "assets": per_asset,
        "disclaimer": "Read-only indicative public trades, NOT an executable SOL/USDC quote or trading permission. Revalidate source times at decision.",
    }


def main() -> None:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "market/ohlcv")
    path = root / "manifest.json"
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != "sol-paper-ohlcv-manifest/v1" or manifest.get("status") != "PASS":
        raise ValueError("CANDLE_MANIFEST_NOT_VALID")
    quote_report = assess(time.time())
    manifest["quote_verification"] = quote_report
    path.write_text(json.dumps(manifest, separators=(",", ":"), allow_nan=False) + "\n")
    print("Public independent SOL/BTC quotes:", quote_report["status"], flush=True)


if __name__ == "__main__":
    main()
