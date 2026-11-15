#!/usr/bin/env python3
"""Conservative fallback OHLCV feed from Binance.US public spot klines.

No credentials, trades or wallets. SOL/BTC are quoted in USDT, not USD/USDC.
Writes the same canonical schema as the Kraken primary only after all 8 pass.
"""
from __future__ import annotations
import datetime as dt
import json
import math
import pathlib
import sys
import time
import urllib.parse
import urllib.request

PAIRS = {"SOLUSD": "SOLUSDT", "XBTUSD": "BTCUSDT"}
INTERVALS = {5:"5m",15:"15m",60:"1h",240:"4h"}
MIN_BARS = 100
SAVE_BARS = 120


def utc_text(epoch: int) -> str:
    return dt.datetime.fromtimestamp(epoch,dt.timezone.utc).isoformat().replace("+00:00","Z")


def get_candles(pair: str, mins: int, now: int):
    period = mins * 60
    sym = PAIRS[pair]
    url="https://api.binance.us/api/v3/klines?"+urllib.parse.urlencode({
        "symbol":sym,"interval":INTERVALS[mins],"limit":150})
    req=urllib.request.Request(url,headers={
        "User-Agent":"SOL-Paper-OHLCV-Research/1.0",
        "Accept":"application/json"})
    with urllib.request.urlopen(req,timeout=20) as rsp:
        if rsp.status != 200:
            raise ValueError(f"Binance.US {sym}/{mins} HTTP {rsp.status}")
        data=json.load(rsp)
    if not isinstance(data,list):
        raise ValueError(f"Binance.US {sym}/{mins}: bad JSON")
    bars=[]
    for row in data:
        if not isinstance(row,list) or len(row)<9:
            raise ValueError("Malformed Binance.US candle")
        start=int(row[0])//1000
        if start + period > now: # reject uncommitted candle
            continue
        o,h,l,c,v=(float(row[i]) for i in (1,2,3,4,5))
        count=int(row[8])
        if not all(math.isfinite(n) for n in (o,h,l,c,v)):
            raise ValueError("Nonfinite OHLCV")
        if min(o,h,l,c)<=0 or v<0 or count<0 or h<max(o,l,c) or l>min(o,h,c):
            raise ValueError("Invalid candle")
        if start%period!=0 or abs(int(row[6])//1000 - (start+period-1))>1:
            raise ValueError("Misaligned candle")
        bars.append([start,o,h,l,c,v,count])
    bars.sort(key=lambda b:b[0])
    bars=bars[-SAVE_BARS:]
    recent=bars[-MIN_BARS:]
    if len(recent)<MIN_BARS:
        raise ValueError(f"Binance.US {sym}/{mins}: insufficient completed bars")
    if any(b[0]-a[0]!=period for a,b in zip(recent,recent[1:])):
        raise ValueError("Gaps or duplicate bar times")
    last_close=recent[-1][0]+period
    age=now-last_close
    if age<0 or age>period+120:
        raise ValueError(f"Binance.US {sym}/{mins}: stale latest close {age}s")
    key=f"{pair}-{mins}m"
    doc={
        "schema":"sol-paper-ohlcv/v1","provider":"Binance.US public spot klines",
        "pair":pair,"market_symbol":sym,"quote_asset":"USDT",
        "interval_minutes":mins,"source_url":url,
        "fetched_at_utc":utc_text(now),"last_completed_close_utc":utc_text(last_close),
        "last_completed_close_epoch":last_close,
        "latest_bar_close_age_seconds":age,"volume_unit":"base asset units",
        "columns":["bar_open_epoch_utc","open","high","low","close","base_volume","trade_count"],
        "complete_only":True,"status":"PASS","candles":bars}
    info={"status":"PASS","pair":pair,"market_symbol":sym,"quote_asset":"USDT",
      "provider":doc["provider"],"interval_minutes":mins,"rows":len(bars),
      "latest100_continuous":True,"last_completed_close_epoch":last_close,
      "last_completed_close_utc":utc_text(last_close),"age_seconds":age,
      "source_url":url,"file":f"{key}.json"}
    return doc,info


def main():
    out=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else "market/ohlcv")
    out.mkdir(parents=True,exist_ok=True)
    now=int(time.time())
    docs,summaries={},{}
    for pair in PAIRS:
        for mins in INTERVALS:
            doc,info=get_candles(pair,mins,now)
            key=f"{pair}-{mins}m"
            docs[key]=doc
            summaries[key]=info
            print(f"PASS Binance.US {key} {info['rows']} bars {info['age_seconds']}s old",flush=True)
    for key,doc in docs.items():
        (out/f"{key}.json").write_text(json.dumps(doc,allow_nan=False,separators=(",",":"))+"\n")
    manifest={"schema":"sol-paper-ohlcv-manifest/v1","status":"PASS",
        "fetched_at_utc":utc_text(now),"fetched_at_epoch":now,
        "source":"Binance.US spot SOLUSDT/BTCUSDT; indicative USDT proxies only, NOT SOL/USDC execution",
        "fallback":True,"series":summaries}
    (out/"manifest.json").write_text(json.dumps(manifest,allow_nan=False,separators=(",",":"))+"\n")


if __name__=="__main__":
    main()
