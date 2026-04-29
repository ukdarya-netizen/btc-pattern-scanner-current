# BTC Scalping Bot

## Overview
A Bitcoin futures scalping bot dashboard with real-time data from multiple exchanges (Bybit, BingX, OKX), signal engine, risk management, and Telegram notifications.

## Architecture

### Artifacts
- **`artifacts/dashboard`** — React/Vite frontend trading terminal (preview path: `/`)
- **`artifacts/api-server`** — Express backend with multi-exchange WebSocket/REST connectors

### Multi-Exchange Layer (api-server)
- **`services/exchanges/types.ts`** — Shared interfaces: IExchangeConnector, ExchangeTicker, ExchangeOrderbook, ExchangeTrade, etc.
- **`services/exchanges/utils.ts`** — Shared utilities: hmacSha256, buildQueryString, computeImbalance
- **`services/exchanges/bybitConnector.ts`** — Bybit: public WebSocket (tickers, orderbook, trades) + private REST (orders, positions, balance)
- **`services/exchanges/bingxConnector.ts`** — BingX: public WebSocket with REST polling fallback + private REST (orders, positions, balance)
- **`services/exchanges/okxConnector.ts`** — OKX: public WebSocket + private REST (needs OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE secrets)
- **`services/exchanges/aggregator.ts`** — Aggregates data from all exchanges: best bid/ask, merged orderbook, cross-exchange spread, best connector for trading

### Services (api-server)
- **`services/cvd.ts`** — Cumulative Volume Delta from aggregated trades (ticks every 1s)
- **`services/signal.ts`** — Signal engine: composite score [-1, +1] from 5 components using aggregated data
- **`services/riskManager.ts`** — Risk management, circuit breaker (3% daily loss), P&L tracking
- **`services/botEngine.ts`** — Bot state machine (paper/live), uses aggregator for price & best exchange for orders
- **`services/telegram.ts`** — Telegraf Telegram bot with commands and notifications

### API Routes
- `GET /api/market/ticker` — Aggregated BTC/USDT ticker (avg price + per-exchange prices)
- `GET /api/market/orderbook` — Merged order book (all exchanges, or ?exchange=Bybit for single)
- `GET /api/market/trades` — Last 50 trades (all exchanges, with exchange tag)
- `GET /api/market/cvd` — CVD time series (120 points)
- `GET /api/market/funding` — Funding rate, open interest
- `GET /api/market/exchanges` — Status of each exchange (connected, price, hasApiKey)
- `GET /api/signal/current` — Signal score with component breakdown
- `GET /api/bot/state` — Bot status
- `POST /api/bot/start` — Start bot `{ mode, maxLeverage, riskPct }`
- `POST /api/bot/stop` — Stop bot
- `GET /api/risk/stats` — Daily P&L, win rate, Sharpe, drawdown
- `GET /api/risk/positions` — Open positions
- `GET /api/history/trades` — Closed trades from DB (+ in-memory fallback)
- `GET /api/history/pnl` — Equity curve snapshots for chart (24h default)
- `GET /api/account/balance` — Real balance from exchanges (or paper balance)

### Database (PostgreSQL via Drizzle ORM)
- **`db/schema.ts`** — Tables: `bot_sessions`, `trades`, `pnl_snapshots`, `open_positions`
- **`db/index.ts`** — pg pool + drizzle instance
- **`services/dbService.ts`** — startSession, stopSession, saveTrade, saveSnapshot, syncOpenPositions, getRecentTrades, getPnlChart, getDailyStats
- Schema pushed via `drizzle.config.ts` + `drizzle-kit push`

### Dashboard Pages
- `/` — Terminal: ticker (multi-exchange prices), CVD chart, order book, recent trades (tagged by exchange), signal gauge, bot controls
- `/risk` — Risk manager: equity curve (DB), account balance per exchange, open positions, trade history from DB, stats (Win Rate, Sharpe, Drawdown)
- `/signal` — Signal breakdown: component scores, radar chart
- `/liquidations` — Liquidation map: CoinGlass 1h/4h/12h/24h long/short volumes, live Bybit WS heatmap by price level, live event feed

### CoinGlass Integration
- **`services/coinglassService.ts`** — Polls `/public/v2/liquidation_info` (1-min cache); uses `coinglassSecret` header
- **`services/liquidationService.ts`** — Aggregates Bybit WS liquidation events into price buckets (30min window, heatmap)
- Routes: `GET /api/liquidations/heatmap`, `GET /api/liquidations/events`, `GET /api/liquidations/info`
- COINGLASS_API_KEY secret configured

## Exchange Status
- **Bybit** ✅ WebSocket connected (public data) — BYBIT_API_KEY + BYBIT_API_SECRET configured
- **BingX** ✅ REST polling (WebSocket blocked in Replit; use VPS for production) — BINGX_API_KEY + BINGX_API_SECRET configured
- **OKX** ⏳ Ready but waiting for OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE secrets

## Environment Secrets
- `BYBIT_API_KEY`, `BYBIT_API_SECRET` — Bybit exchange
- `BINGX_API_KEY`, `BINGX_API_SECRET` — BingX exchange
- `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_PASSPHRASE` — OKX exchange (not yet added)
- `SESSION_SECRET` — Express session
- `TELEGRAM_BOT_TOKEN` — Telegram bot

## Key Notes
- BingX WebSocket doesn't upgrade in Replit sandbox — uses REST polling fallback (works fine in production VPS)
- On a Tokyo/Singapore VPS: all 3 exchange WebSockets connect natively with <10ms latency
- Live trading execution: uses `getBestConnectorForTrading()` which prefers Bybit > OKX > BingX
- Signal threshold for trading: 0.35 score required, min 30s between trades
