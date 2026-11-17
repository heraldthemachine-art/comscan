/**
 * Public, read-only market-data adapter for independent PAPER simulations.
 * There are NO order, wallet, signature, credential, Sheets or alert APIs here.
 * IMPORTANT: DATA_READY is not a trading signal or an executable USDC quote.
 */
export const PAIRS = ['SOL', 'BTC'];
export const WINDOWS = [5, 15, 60, 240];
export const MIN_ROWS = 100;
export const MAX_CANDLE_AGE_MS = { 5: 7 * 60_000, 15: 20 * 60_000, 60: 75 * 60_000, 240: 260 * 60_000 };
export const MAX_QUOTE_AGE_MS = 10 * 60_000;
export const MAX_QUOTE_SKEW_MS = 10 * 60_000;
export const MAX_QUOTE_DIVERGENCE = 0.0075;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
const KRAKEN_SYMBOLS = { SOL: 'SOLUSD', BTC: 'XBTUSD' };
const BINANCE_SYMBOLS = { SOL: 'SOLUSDT', BTC: 'BTCUSDT' };
const COINBASE_SYMBOLS = { SOL: 'SOL-USD', BTC: 'BTC-USD' };
const TIMEFRAME_BINANCE = { 5: '5m', 15: '15m', 60: '1h', 240: '4h' };
const jsonResponse = (obj, status=200) => new Response(JSON.stringify(obj), {status, headers:JSON_HEADERS});
const finite = n => Number.isFinite(Number(n)) ? Number(n) : NaN;
const utc = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

export async function fetchJSON(fetcher, url, timeout=4500) {
  let err;
  for (let attempt=0; attempt<2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(()=>ctl.abort(), timeout);
    try {
      const response = await fetcher(url, {method:'GET', headers:{accept:'application/json'}, signal:ctl.signal});
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return await response.json();
    } catch (e) { err = e; }
    finally { clearTimeout(timer); }
  }
  throw new Error(String(err?.message || err || 'UPSTREAM_FAILED'));
}

function parseKrakenOHLC(doc, interval, nowMs) {
  if (!doc || (doc.error?.length || 0) > 0 || typeof doc.result !== 'object') throw new Error('KRAKEN_RESPONSE_INVALID');
  const key = Object.keys(doc.result).find(x=>x!=='last');
  if (!key || !Array.isArray(doc.result[key])) throw new Error('KRAKEN_CANDLES_MISSING');
  return doc.result[key].map(r=>({openMs:finite(r[0])*1000, open:finite(r[1]), high:finite(r[2]), low:finite(r[3]), close:finite(r[4]), volume:finite(r[6])}))
    .filter(r=>r.openMs + interval*60_000 <= nowMs - 1000);
}
function parseBinanceOHLC(doc, interval, nowMs) {
  if (!Array.isArray(doc)) throw new Error('BINANCE_CANDLES_MISSING');
  return doc.map(r=>({openMs:finite(r[0]), open:finite(r[1]), high:finite(r[2]), low:finite(r[3]), close:finite(r[4]), volume:finite(r[5])}))
    .filter(r=>r.openMs + interval*60_000 <= nowMs - 1000);
}
export function validateCandles(candles, interval, nowMs) {
  if (candles.length < MIN_ROWS) return {ok:false, reason:'INSUFFICIENT_BARS'};
  const recent = candles.slice(-120);
  let previous = -Infinity;
  for (const c of recent) {
    if (![c.openMs,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) || c.open<=0 || c.close<=0 || c.low<=0 || c.high<c.low || c.high < Math.max(c.open,c.close) || c.low > Math.min(c.open,c.close) || c.volume<0) return {ok:false, reason:'INVALID_OHLCV'};
    if (previous !== -Infinity && c.openMs - previous !== interval*60_000) return {ok:false, reason:'CANDLE_GAP_OR_DUPLICATE'};
    previous = c.openMs;
  }
  const latestCloseMs = recent.at(-1).openMs + interval * 60_000;
  const ageMs = nowMs - latestCloseMs;
  if (ageMs < 0 || ageMs > MAX_CANDLE_AGE_MS[interval]) return {ok:false, reason:'STALE_COMPLETED_CANDLE', latestCloseUtc:utc(latestCloseMs), ageSeconds:Math.round(ageMs/1000)};
  return {ok:true, latestCloseUtc:utc(latestCloseMs), ageSeconds:Math.round(ageMs/1000)};
}

async function loadCandles(fetcher, pair, interval, nowMs) {
  const sources = [
    {provider:'Kraken', symbol:KRAKEN_SYMBOLS[pair], denom:'USD', url:`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_SYMBOLS[pair]}&interval=${interval}`, parse:parseKrakenOHLC},
    {provider:'Binance.US', symbol:BINANCE_SYMBOLS[pair], denom:'USDT', url:`https://api.binance.us/api/v3/klines?symbol=${BINANCE_SYMBOLS[pair]}&interval=${TIMEFRAME_BINANCE[interval]}&limit=130`, parse:parseBinanceOHLC}
  ];
  const failures=[];
  for (const src of sources) {
    try {
      const doc = await fetchJSON(fetcher,src.url);
      const rows = src.parse(doc,interval,nowMs);
      const val = validateCandles(rows,interval,nowMs);
      if (!val.ok) throw new Error(val.reason);
      return {ok:true, pair, minutes:interval, provider:src.provider, symbol:src.symbol, quoteCurrency:src.denom, endpoint:src.url, rows:rows.slice(-120).length, latestCompleted:val.latestCloseUtc, latestAgeSeconds:val.ageSeconds,
        columns:['openEpochSeconds','open','high','low','close','volume'], candles:rows.slice(-120).map(r=>[r.openMs/1000,r.open,r.high,r.low,r.close,r.volume]), failures};
    } catch(e) { failures.push(`${src.provider}: ${String(e?.message || e)}`); }
  }
  return {ok:false,pair,minutes:interval,failures};
}

function quote(provider,pair,price,timeMs,denom,url,nowMs){
  const priceNum=finite(price), age=nowMs-timeMs;
  if (!Number.isFinite(priceNum)||priceNum<=0||!Number.isFinite(timeMs)||age < -30_000||age>MAX_QUOTE_AGE_MS) throw new Error(`QUOTE_STALE_OR_INVALID_${provider}`);
  return {provider,pair,price:priceNum,tradeTimeUtc:utc(timeMs),tradeEpochMs:timeMs,ageSeconds:Math.round(age/1000),quoteCurrency:denom,endpoint:url};
}
async function getKrakenTrade(fetcher,pair,nowMs) {
  const url=`https://api.kraken.com/0/public/Trades?pair=${KRAKEN_SYMBOLS[pair]}&count=1`;
  const doc=await fetchJSON(fetcher,url);
  if (doc.error?.length || !doc.result) throw new Error('KRAKEN_TRADES_INVALID');
  const k=Object.keys(doc.result).find(x=>x!=='last');
  const r=doc.result[k]?.at(-1);
  if (!r) throw new Error('KRAKEN_TRADE_MISSING');
  return quote('Kraken',pair,r[0],finite(r[2])*1000,'USD',url,nowMs);
}
async function getCoinbaseTrade(fetcher,pair,nowMs) {
  const url=`https://api.exchange.coinbase.com/products/${COINBASE_SYMBOLS[pair]}/ticker`;
  const doc=await fetchJSON(fetcher,url);
  return quote('Coinbase Exchange',pair,doc.price,Date.parse(doc.time),'USD',url,nowMs);
}
async function getBinanceTrade(fetcher,pair,nowMs) {
  const url=`https://api.binance.us/api/v3/trades?symbol=${BINANCE_SYMBOLS[pair]}&limit=1`;
  const doc=await fetchJSON(fetcher,url);
  if (!Array.isArray(doc)||!doc.length) throw new Error('BINANCE_TRADE_MISSING');
  return quote('Binance.US',pair,doc.at(-1).price,finite(doc.at(-1).time),'USDT',url,nowMs);
}
async function loadQuote(fetcher,pair,nowMs) {
  const providers=[getKrakenTrade,getCoinbaseTrade,getBinanceTrade];
  const results=await Promise.allSettled(providers.map(fn=>fn(fetcher,pair,nowMs)));
  const good=results.filter(x=>x.status==='fulfilled').map(x=>x.value);
  const failures=results.map((x,i)=>x.status==='rejected'?`${['Kraken','Coinbase Exchange','Binance.US'][i]}: ${x.reason?.message || 'unavailable'}`:null).filter(Boolean);
  let chosen;
  // Never choose two prices from the same exchange. Prefer USD/USD corroboration.
  const pairs=[[good.find(q=>q.provider==='Kraken'),good.find(q=>q.provider==='Coinbase Exchange')],
    [good.find(q=>q.provider==='Kraken'),good.find(q=>q.provider==='Binance.US')],
    [good.find(q=>q.provider==='Coinbase Exchange'),good.find(q=>q.provider==='Binance.US')]];
  for(const items of pairs){
    const [a,b]=items;
    if(!a||!b)continue;
    const divergence=Math.abs(a.price-b.price)/((a.price+b.price)/2);
    const skew=Math.abs(a.tradeEpochMs-b.tradeEpochMs);
    if(divergence<=MAX_QUOTE_DIVERGENCE && skew<=MAX_QUOTE_SKEW_MS){chosen={providers:[a,b],proxyMarkUSD:(a.price+b.price)/2,divergencePct:100*divergence,sourceSkewSeconds:Math.round(skew/1000),isIndicativeOnly:true};break;}
    failures.push(`PAIR_DISAGREEMENT_${a.provider}_${b.provider}: divergence=${(100*divergence).toFixed(3)}%, skew=${Math.round(skew/1000)}s`);
  }
  return chosen?{ok:true,pair,...chosen,failures}:{ok:false,pair,reason:'NO_TWO_INDEPENDENT_TIMED_AGREEING_QUOTES',available:good,failures};
}

export async function buildSnapshot({fetcher=fetch, nowMs=Date.now()}={}) {
  const names=PAIRS.flatMap(pair=>WINDOWS.map(minutes=>({pair,minutes})));
  const [series,quoteResults]=await Promise.all([
    Promise.all(names.map(({pair,minutes})=>loadCandles(fetcher,pair,minutes,nowMs))),
    Promise.all(PAIRS.map(pair=>loadQuote(fetcher,pair,nowMs)))
  ]);
  const candlesVerified=series.every(x=>x.ok);
  const quotesVerified=quoteResults.every(x=>x.ok);
  const seriesList=Object.fromEntries(series.map(s=>[`${s.pair}-${s.minutes}m`,s]));
  const quotes=Object.fromEntries(quoteResults.map(q=>[q.pair,q]));
  const dataReadyForEvaluation=candlesVerified&&quotesVerified;
  return {schema:'sol-paper-market-data/v1',checkedAtUtc:utc(nowMs),status:dataReadyForEvaluation?'DATA_READY':'DATA_UNAVAILABLE',
    checks:{candlesVerified,quotesVerified,seriesPassed:series.filter(s=>s.ok).length,seriesRequired:8, max5mAgeSeconds:420, maxQuoteAgeSeconds:600, maxDivergencePct:0.75},
    quotes,series:seriesList,
    disclaimer:'PAPER ANALYSIS DATA ONLY. Neither a trading signal nor an executable SOL/USDC order quote. No transactions, alerts, or account connections.'};
}

export default {
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(request.method !== 'GET') return jsonResponse({error:'METHOD_NOT_ALLOWED'},405);
    if(path!=='/v1/snapshot' && path!=='/v1/health') return jsonResponse({error:'NOT_FOUND',routes:['/v1/snapshot','/v1/health']},404);
    const result=await buildSnapshot();
    if(path==='/v1/health'){
      return jsonResponse({schema:result.schema,checkedAtUtc:result.checkedAtUtc,status:result.status,checks:result.checks,
        quoteStatus:Object.fromEntries(PAIRS.map(p=>[p,{ok:result.quotes[p].ok,reason:result.quotes[p].reason||null}])),
        candleStatus:Object.fromEntries(Object.entries(result.series).map(([k,v])=>[k,{ok:v.ok,provider:v.provider||null,latestCompleted:v.latestCompleted||null,latestAgeSeconds:v.latestAgeSeconds??null,failures:v.failures}])),
        disclaimer:result.disclaimer},result.status==='DATA_READY'?200:503);
    }
    return jsonResponse(result,result.status==='DATA_READY'?200:503);
  }
};