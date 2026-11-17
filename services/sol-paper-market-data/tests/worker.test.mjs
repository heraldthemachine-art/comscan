import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, validateCandles } from '../src/worker.mjs';

const NOW = Date.parse('2026-11-17T12:10:30Z');
const intervals=[5,15,60,240];
const floor=(ms,interval)=>Math.floor(ms/(interval*60000))*(interval*60000);
const fixture=(pair,interval,nowMs=NOW)=>{
  const intervalMs=interval*60000;
  const lastCompletedStart=floor(nowMs,interval)-intervalMs;
  const prices=pair==='SOL'?72:65000;
  return Array.from({length:121},(_,i)=>{
    const openMs=lastCompletedStart-(119-i)*intervalMs;
    return [Math.floor(openMs/1000),prices,prices+2,prices-2,prices+.4,prices+.1,10+i,3];
  });
};
const binanceFixture=(pair,interval,nowMs=NOW)=>fixture(pair,interval,nowMs).map(r=>[r[0]*1000, r[1],r[2],r[3],r[4],r[6],r[0]*1000+interval*60_000-1]);
const makeFetch=({staleCandle=false,krakenDown=false,quoteDrift=false,staleQuote=false,binanceDown=false,krakenBrokenOne=false,coinbaseDown=false}={})=>async (url)=>{
  const uri=new URL(url);
  const pair=/SOL/i.test(url)?'SOL':'BTC';
  const quote=pair==='SOL'?72:65000;
  const qTime=staleQuote?NOW-12*60_000:NOW-30_000;
  let body;
  if(uri.pathname.endsWith('/OHLC')){
    if(krakenDown) return {ok:false,status:503,json:async()=>({})};
    const interval=Number(uri.searchParams.get('interval'));
    const rows=fixture(pair,interval,staleCandle?NOW-20*60_000:NOW);
    if(krakenBrokenOne && pair==='SOL' && interval===5) rows[110][0]-=1000;
    body={error:[],result:{[pair==='SOL'?'SOLUSD':'XXBTZUSD']:rows,last:0}};
  } else if(uri.pathname.endsWith('/Trades')){
    body={error:[],result:{[pair==='SOL'?'SOLUSD':'XXBTZUSD']:[[String(quote),'1',qTime/1000,'b','m','',1]],last:'0'}};
  } else if(uri.hostname==='api.exchange.coinbase.com'){
    if(coinbaseDown)return {ok:false,status:503,json:async()=>({})};
    body={price:quoteDrift?String(quote*1.05):String(quote*1.0001),time:new Date(qTime).toISOString()};
  } else if(uri.pathname.endsWith('/klines')){
    if(binanceDown)return {ok:false,status:503,json:async()=>({})};
    const interval=({ '5m':5,'15m':15,'1h':60,'4h':240})[uri.searchParams.get('interval')];
    body=binanceFixture(pair,interval,staleCandle?NOW-20*60_000:NOW);
  } else if(uri.pathname.endsWith('/trades')) {
    if(binanceDown)return {ok:false,status:503,json:async()=>({})};
    body=[{price:quoteDrift?String(quote*1.1):String(quote*1.0002), time:qTime}];
  } else throw new Error('unknown '+url);
  return {ok:true,status:200,json:async()=>body};
};

test('fresh valid independent quotes + all 8 OHLCV series -> DATA_READY', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch(),nowMs:NOW});
  assert.equal(s.status,'DATA_READY');
  assert.equal(s.checks.seriesPassed,8);
  assert.equal(s.quotes.SOL.providers.length,2);
  assert.equal(s.series['SOL-5m'].rows,120);
  assert.equal(s.series['BTC-240m'].minutes,240);
  assert.equal(s.quotes.BTC.proxyMarkUSD>0,true);
});

test('Kraken candle failure -> Binance.US fallback, no fake USD label', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch({krakenDown:true}),nowMs:NOW});
  assert.equal(s.status,'DATA_READY');
  assert.equal(s.series['SOL-5m'].provider,'Binance.US');
  assert.equal(s.series['SOL-5m'].quoteCurrency,'USDT');
});

test('both candle providers stale -> DATA_UNAVAILABLE', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch({staleCandle:true}),nowMs:NOW});
  assert.equal(s.status,'DATA_UNAVAILABLE');
  assert.equal(s.checks.candlesVerified,false);
});

test('price divergence across Kraken, Coinbase, Binance.US blocks data readiness', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch({quoteDrift:true}),nowMs:NOW});
  assert.equal(s.status,'DATA_UNAVAILABLE');
  assert.equal(s.checks.quotesVerified,false);
});

test('stale spot trades prevent quote corroboration', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch({staleQuote:true}),nowMs:NOW});
  assert.equal(s.status,'DATA_UNAVAILABLE');
  assert.equal(s.checks.quotesVerified,false);
});

test('corrupt continuity from primary falls back to independent secondary', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch({krakenBrokenOne:true}),nowMs:NOW});
  assert.equal(s.status,'DATA_READY');
  assert.equal(s.series['SOL-5m'].provider,'Binance.US');
});

test('no candle in flight is counted complete',()=>{
  const c=[{openMs:NOW-5*60_000,open:72,high:73,low:71,close:72.5,volume:10}];
  assert.equal(validateCandles(c,5,NOW).ok,false);
});

test('provider loss still fails closed if fewer than two time-stamped quotes', async()=>{
  const s=await buildSnapshot({fetcher:makeFetch({coinbaseDown:true,binanceDown:true}),nowMs:NOW});
  assert.equal(s.status,'DATA_UNAVAILABLE');
  assert.equal(s.checks.quotesVerified,false);
});