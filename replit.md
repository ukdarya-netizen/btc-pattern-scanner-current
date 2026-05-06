# BTC Scalping Bot

## Overview
A Bitcoin futures scalping bot dashboard with real-time data from multiple exchanges (Bybit, BingX, OKX), signal engine v2, risk management, and Telegram notifications. Acts as a signal analyst — user trades manually based on signals.

## Architecture

### Artifacts
- **`artifacts/dashboard`** — React/Vite frontend trading terminal (preview path: `/`)
- **`artifacts/api-server`** — Express backend with multi-exchange WebSocket/REST connectors

### Multi-Exchange Layer (api-server)
- **`services/exchanges/types.ts`** — Shared interfaces: IExchangeConnector, ExchangeTicker, ExchangeOrderbook, ExchangeTrade, etc.
- **`services/exchanges/aggregator.ts`** — Aggregates data from all exchanges: best bid/ask, merged orderbook, cross-exchange spread, best connector for trading

### Services (api-server)
- **`services/cvd.ts`** — Multi-Timeframe CVD (1m/5m/15m buckets); getAlignment() returns trend consensus across all 3 TFs
- **`services/signal.ts`** — Signal engine v2: 7 weighted components + 6 display-only; 4 gates required for allGatesPassed
- **`services/coinglassService.ts`** — CoinGlass client: liquidation_info (1m cache) + heatmap (5m cache, fallback to coinalyze) + OI delta history
- **`services/coinalyzeService.ts`** — Coinalyze: 2h liq candles + synthetic liq map (fallback for heatmap)
- **`services/signalTracker.ts`** — Always-on virtual signal tracker (0.01 BTC), saves to DB with exchange="Signal"
- **`services/botEngine.ts`** — Bot state machine (paper/live) with exponential SL cooldown
- **`services/statsScheduler.ts`** — Daily (21:00 MSK), weekly (Sun 12:00), monthly (1st 10:00) Telegram reports
- **`services/riskManager.ts`** — Risk management, circuit breaker (3% daily loss), P&L tracking
- **`services/telegram.ts`** — Telegraf Telegram bot with commands and notifications

### Signal Engine v2 — Weights
| Component | Weight | Notes |
|---|---|---|
| MTF CVD (1m/5m/15m) | 0.30 | PRIMARY — replaces Pattern |
| Order Book Imbalance | 0.20 | |
| CVD Trend (1m) | 0.15 | |
| Trade Momentum | 0.13 | |
| VWAP Deviation | 0.10 | |
| EMA 9/21 | 0.07 | |
| Liquidations (Coinalyze) | 0.05 | |
| Historical Pattern, Funding, OI Delta, OI, Cross-Exchange Spread, Cross-Exchange Divergence | 0 | display-only |

### 4 Gates (all required for allGatesPassed)
1. **MTF CVD Alignment** — all 3 timeframes (1m/5m/15m) agree on direction
2. **Order Book Imbalance** — stacked bids/asks confirm direction
3. **SL on liq cluster** — nearest significant cluster ($3M+) within 0.4–2.5% of price
4. **TP on liq cluster + R:R ≥ 1.5** — target cluster ($2M+) with minimum risk/reward

### Direction Logic
- If `alignment.strong` (all 3 MTF CVD agree) → direction from MTF CVD
- Otherwise → direction from composite score (>0.25 long / <-0.25 short)

### Leverage Logic (fixed, not inverted)
- ATR > 0.5% → 20x | > 0.3% → 35x | > 0.2% → 50x | > 0.1% → 75x | else → 100x
- Multiplied by quality: `0.7 + |score| × 0.3`

### SL Cooldown (botEngine)
Exponential after consecutive SLs: 1st=5m, 2nd=15m, 3rd=45m, 4th=2h, 5th+=4h

### Dashboard Pages
- `/` — Terminal: ticker, CVD chart, order book, recent trades, signal gauge, bot controls
- `/risk` — Risk: equity curve (DB), balances per exchange, open positions, trade history, stats
- `/signal` — Signal v2: 4 gates, 13 components (7 weighted + 6 display), ATR/VWAP, pattern chart
- `/liquidations` — Liquidation map: CoinGlass 1h/4h/12h/24h volumes, Bybit WS heatmap, event feed

### CoinGlass Integration
- **Heatmap**: `GET /public/v2/liquidation_heatmap?symbol=BTC&range=12` (5m cache, falls back to coinalyze synthetic map)
- **Liq info**: `GET /public/v2/liquidation_info` (1m cache)
- **OI Delta**: collected from aggregator.getPrimaryOpenInterest() every 1m (30 snapshots = 30min history)

## Exchange Status
- **Bybit** ✅ WebSocket connected (public data) — BYBIT_API_KEY + BYBIT_API_SECRET configured
- **BingX** ✅ REST polling (WebSocket blocked in Replit; use VPS for production) — BINGX_API_KEY + BINGX_API_SECRET configured
- **OKX** ⏳ Ready but waiting for OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE secrets

## Environment Secrets
- `BYBIT_API_KEY`, `BYBIT_API_SECRET` — Bybit exchange
- `BINGX_API_KEY`, `BINGX_API_SECRET` — BingX exchange
- `COINGLASS_API_KEY` — CoinGlass liquidation data
- `COINALYZE_API_KEY` — Coinalyze synthetic liq map fallback
- `SESSION_SECRET` — Express session
- `TELEGRAM_BOT_TOKEN` — Telegram bot

## Key Notes
- MTF CVD needs ~5-10 min after startup to accumulate enough bucket data for alignment
- CoinGlass heatmap endpoint may not be available on current plan — coinalyze synthetic map used as fallback automatically
- BingX WebSocket doesn't upgrade in Replit sandbox — uses REST polling fallback
- patternService.ts is DISPLAY-ONLY (weight: 0) — do NOT add back as weighted component
- ATR is display-only for leverage calc — NEVER use ATR for SL/TP (clusters only)
- Trailing stop and news guard: DO NOT ADD
- SignalTracker always runs (even when bot stopped) — populates DB for reports
