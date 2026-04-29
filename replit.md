# BTC Scalping Bot

## Overview
A Bitcoin futures scalping bot dashboard with real-time data from Bybit, signal engine, risk management, and Telegram notifications.

## Architecture

### Artifacts
- **`artifacts/dashboard`** — React/Vite frontend trading terminal (preview path: `/`)
- **`artifacts/api-server`** — Express backend with WebSocket exchange connector

### Services (api-server)
- **`services/bybit.ts`** — WebSocket connector to Bybit (tickers, order book, trades)
- **`services/cvd.ts`** — Cumulative Volume Delta calculator (ticks every 1s)
- **`services/signal.ts`** — Signal engine: composite score [-1, +1] from 5 components
- **`services/riskManager.ts`** — Risk management, circuit breaker, P&L tracking
- **`services/botEngine.ts`** — Bot state machine (paper/live mode)
- **`services/telegram.ts`** — Telegraf Telegram bot with commands and notifications

### API Routes
- `GET /api/market/ticker` — Live BTC/USDT ticker
- `GET /api/market/orderbook` — Top 20 order book levels with imbalance
- `GET /api/market/trades` — Last 50 trades
- `GET /api/market/cvd` — CVD time series (120 points)
- `GET /api/market/funding` — Funding rate, open interest
- `GET /api/signal/current` — Signal score with component breakdown
- `GET /api/bot/state` — Bot status
- `POST /api/bot/start` — Start bot `{ mode, maxLeverage, riskPct }`
- `POST /api/bot/stop` — Stop bot
- `GET /api/risk/stats` — Daily P&L, win rate, Sharpe, drawdown
- `GET /api/risk/positions` — Open paper positions

### Dashboard Pages
- `/` — Main terminal: price, CVD chart, signal gauge, bot controls, order book, trades
- `/risk` — Risk & performance: stats grid, open positions table
- `/signal` — Signal explorer: component breakdown with scores

## Signal Components
1. **Order Book Imbalance** (weight 0.25) — bid/ask volume pressure
2. **CVD Trend** (weight 0.30) — cumulative volume delta direction
3. **Funding Rate** (weight 0.15) — funding rate sentiment reversal
4. **Trade Momentum** (weight 0.20) — buy/sell aggression from recent trades
5. **Open Interest** (weight 0.10) — OI context

Signal threshold for trade: |score| > 0.35

## Risk Management
- Circuit breaker: daily loss > 3% → pause + 60min cooldown
- Adaptive leverage based on signal confidence
- SL always set (TP = 2x SL in terms of %)
- Max 2 concurrent paper positions

## Tech Stack
- **Frontend**: React 19, Vite, Tailwind CSS v4, Recharts, TanStack Query, Wouter
- **Backend**: Node.js, Express 5, TypeScript, ws (WebSocket), Telegraf
- **Codegen**: Orval from OpenAPI spec

## Environment Variables
- `TELEGRAM_BOT_TOKEN` — Telegram bot token (secret)
- `SESSION_SECRET` — Session secret

## Telegram Commands
Send `/start` to the bot to register your chat, then:
- `/status` — bot state
- `/signal` — current signal
- `/positions` — open positions
- `/stop` — emergency stop

## Notes
- **Replit is for development only** — for production use a VPS near Bybit/Binance servers (Tokyo/Singapore), latency < 10ms is critical for scalping
- Currently paper trading only (no real exchange orders)
- Live mode wiring to exchange order API is not yet implemented
