---
name: CoinGlass V4 API integration
description: V4 API details, correct base URL/auth, working endpoints, integration into signal engine
---

## V4 API
- Base URL: `https://open-api-v4.coinglass.com`
- Auth header: `CG-API-KEY: $COINGLASS_API_KEY` (same key, different header from V2's `coinglassSecret`)
- Account: STANDARD (expires ~1782571965000, renews periodically)

## Working endpoints on Standard
- `/api/futures/coin/netflow?symbol=BTC` — cross-exchange taker buy/sell (5m/15m/30m/1h/4h). Returns `taker_buy_volume_usd_15m`, `taker_sell_volume_usd_15m`, `net_flow_usd_15m`, `net_flow_usd_15m_market_cap_ratio` etc
- `/api/futures/orderbook/aggregated-ask-bids-history?symbol=BTC&exchange_list=ALL&interval=m5&limit=N` — total bids/asks across all exchanges
- `/api/futures/liquidation/order?symbol=BTC` — recent liquidation orders
- `/api/futures/open-interest/aggregated-history?symbol=BTC&interval=m5&limit=N` — OI OHLC
- `/api/user/account/subscription` — account level check

## Not available on Standard
- `/api/futures/liquidation/aggregated-map` → requires Pro
- Aggregated taker buy/sell history and CVD history → return empty []

## What was integrated (V4 → coinglassService.ts → signal.ts)
- `cgV4Request()` — separate request helper with `CG-API-KEY` header
- `NetflowData` interface — all 5m/15m/30m/1h/4h buy/sell/net/ratio fields
- `AggObData` interface — bidsUsd/asksUsd/imbalance (avg of last 3 m5 candles)
- **getCvdSignal()** now uses V4 netflow as PRIMARY (falls back to local CVD Bybit)
- **getObSignal()** now also reads V4 agg OB; if local+V4 OB conflict → treat as neutral; if local neutral → use V4
- `MarketSnapshot` has netflowNet15m/netflowNet1h/netflowRatio15m/netflowSignal/cgObImbalance/cgObSignal
- buildDebugMessage() shows "🌐 NF:" row with 15m+1h netflow + V4 OB in OB row

## Netflow thresholds
- scalp (15m): |ratio| > 0.0015 (0.15% market cap)
- intraday (1h): |ratio| > 0.0020 (0.20% market cap)
- swing (4h): |ratio| > 0.0030 (0.30% market cap)

**Why:** netflow is cross-exchange CVD (24 exchanges) vs Bybit-only local CVD. Much more reliable signal.
**How to apply:** whenever getCvdSignal is called, coinglassService.getNetflow() is checked first.
