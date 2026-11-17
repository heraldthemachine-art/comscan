# SOL paper market-data Worker (independent, read-only)

An on-demand Cloudflare Worker for **independent validation**, NOT an automatic replacement for the original four SOL paper strategies. It makes no wallet calls, has no exchange keys, contains no trading actions, never writes Google Sheets, and sends no notifications. Do not change A/B/C/D2, their schedules, rules or ledgers to test this service.

## Contract

- `GET /v1/health`: pass/fail diagnostics, no candle arrays. HTTP 503 on incomplete evidence.
- `GET /v1/snapshot`: validated 120 *completed* OHLCV bars where available for SOL & BTC, 5m/15m/1h/4h; two independent, timestamped spot references for each asset. HTTP 503 on incomplete evidence, with failure reasons. **No fail-open.**
- OHLCV Kraken USD primary, Binance.US USDT fallback. Quotes: Kraken most recent actual trade timestamp, Coinbase Exchange timestamped ticker; Binance.US last trade backup. Price correlation maximum 0.75%; each quote no older than ten minutes, two provider timestamps no more than ten minutes apart. At least 100 continuous completed OHLCV candles per interval; 5m candle close must be under seven minutes old at query time. 15m/1h/4h have interval-aware age limits. Never use unfinished bars.
- `DATA_READY` only indicates market data passed basic gates. It is **not** a strategy buy/sell signal or executable SOL/USDC/Jupiter quote. The original coordinator must independently verify any additional execution rules.
- Mark/quote is **indicative USD proxy**. When Binance.US is used, USDT vs USD basis applies. Data provider and URL are recorded in results.
- Public upstream endpoints can block Cloudflare egress. Provider problems trigger explicit `DATA_UNAVAILABLE`, never fabricated candles or prices.

## Testing and deployment

```bash
cd services/sol-paper-market-data
npm test
npm install
npx wrangler login
npx wrangler deploy
curl -i https://<deployed-subdomain>.workers.dev/v1/health
```

The Worker must be deployed under a separate Cloudflare account/application. A Cloudflare connection or deployment login is required for permanent deployment. Existing GitHub cron publisher can continue untouched as independent fallback. Do not link this Worker to the original four-strategy coordinator yet.

## Parallel acceptance criteria (minimum 24 hours after deployment)

1. Query `/v1/health` at every existing paper scan time and sample between scans. Preserve outputs in a **separate** test log; do not write to original A/B/C/D2 workbook.
2. Track freshness success, quote corroboration success, both-provider availability, source disagreements, and per-interval gaps; retain reasons for any HTTP 503.
3. Require >=95% DATA_READY scans over >=24 hours and no false readiness in deliberately stale/disagreeing-provider tests. Confirm source timestamps and comparable prices independently.
4. Review results before considering any coordinator routing change. Do not auto-switch the first four strategies.

### Source references

- Kraken public REST OHLC `/0/public/OHLC` and recent trades `/0/public/Trades`
- Coinbase Exchange public product ticker `/products/{product_id}/ticker`
- Binance.US public `/api/v3/klines` and `/api/v3/trades`
- Cloudflare Workers: https://developers.cloudflare.com/workers/

The existing `sol-ohlcv-feed` branch and GitHub Actions jobs are not modified by this implementation.