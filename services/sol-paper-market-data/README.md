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


## On-demand Vercel function (prepared, NOT deployed)

The same read-only validation engine can be called on demand, avoiding the timing limitations of GitHub's `schedule` trigger.

- Import GitHub repository `heraldthemachine-art/comscan` into Vercel and set the **Root Directory** to `services/sol-paper-market-data` (Framework: Other, Node.js runtime). The connection/deployment must be explicitly authorized by the account owner.
- After Vercel deploys the project, GET `https://<your-deployed-domain>/api/market-data?view=health` for pass/fail, or `?view=snapshot` for full actual candle/quote evidence. Neither endpoint persists market data, places trades, or sends alerts.
- Test both routes at prospective scan times for at least 24 hours. Compare source timestamps against real UTC, independently inspect completed candle continuity, and require >=95% `DATA_READY` among eligible scans before proposing a coordinator cutover.
- **Do not configure any coordinator to trust the URL until deployment has been independently tested and the user has approved the cutover.** A 503 or invalid JSON means HOLD, never a paper fill. Kraken/Coinbase/Binance.US can block Vercel network egress, in which case this option also fails closed.
- `quote` data remain indicative USD/USDT market evidence, never executable SOL/USDC liquidity.

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