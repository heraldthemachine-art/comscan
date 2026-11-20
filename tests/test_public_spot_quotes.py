#!/usr/bin/env python3
"""Offline fixtures for publisher's quote quality gates (no exchange calls)."""
import datetime as dt
import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "attach_public_spot_quotes.py"
spec = importlib.util.spec_from_file_location("spot_quotes", SCRIPT)
quotes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quotes)


class PublicQuoteAuditTests(unittest.TestCase):
    NOW = 1795165000.0

    def quote(self, venue, price, currency="USD", lag=90):
        return {
            "provider": venue, "asset": "SOL", "price": price,
            "quote_currency": currency, "trade_epoch_seconds": self.NOW - lag,
        }

    def test_two_usd_venues_required_and_preferred(self):
        eligible = [
            self.quote("Coinbase Exchange", 70),
            self.quote("Kraken", 70.1),
            self.quote("Binance.US", 70.12, "USDT"),
        ]
        chosen = quotes.choose_pair(eligible)
        self.assertEqual(chosen["status"], "PASS")
        self.assertEqual(chosen["indicative_currency"], "USD")
        self.assertFalse(chosen["executable_sol_usdc_quote"])

    def test_stale_divergent_and_single_source_fail(self):
        self.assertIsNone(quotes.choose_pair([self.quote("Kraken", 70)]))
        self.assertIsNone(quotes.choose_pair([
            self.quote("Kraken", 70), self.quote("Coinbase Exchange", 72)
        ]))
        self.assertIsNone(quotes.choose_pair([
            self.quote("Kraken", 70), self.quote("Coinbase Exchange", 70, lag=800)
        ]))

    def test_parse_rejects_old_coinbase_trade(self):
        old = dt.datetime.fromtimestamp(self.NOW - 901, dt.timezone.utc).isoformat()
        with self.assertRaisesRegex(ValueError, "STALE_QUOTE"):
            quotes.parse_quote(
                "Coinbase Exchange", "SOL", "USD", "https://example.invalid",
                {"price": "70", "time": old}, self.NOW
            )

    def test_complete_two_asset_audit_is_read_only(self):
        def source(url):
            is_sol = "SOL" in url
            price = 70 if is_sol else 65000
            if "coinbase" in url:
                return {"price": str(price), "time": quotes.utc_text(self.NOW - 20)}
            if "kraken" in url:
                return {"error": [], "result": {"PAIR": [[str(price * 1.001), "1", self.NOW - 30]], "last": "x"}}
            return [{"price": str(price), "time": (self.NOW - 10) * 1000}]
        report = quotes.assess(self.NOW, source)
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["assets"]["SOL"]["selected"]["indicative_currency"], "USD")
        self.assertFalse(report["assets"]["BTC"]["selected"]["executable_sol_usdc_quote"])

    def test_missing_second_venue_fails_closed(self):
        def source(url):
            if "coinbase" in url:
                return {"price": "70", "time": quotes.utc_text(self.NOW - 10)}
            raise ConnectionError("blocked")
        report = quotes.assess(self.NOW, source)
        self.assertEqual(report["status"], "DATA_UNAVAILABLE")
        self.assertEqual(report["assets"]["SOL"]["status"], "DATA_UNAVAILABLE")
        self.assertEqual(report["assets"]["BTC"]["status"], "DATA_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
