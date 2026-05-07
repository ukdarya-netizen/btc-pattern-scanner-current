# BTC Scalping Bot

A Bitcoin futures scalping signal bot — acts as a signal analyst, user trades manually based on signals published to a Telegram channel.

## Run & Operate
- API server: `pnpm --filter @workspace/api-server run dev`
- Dashboard: `pnpm --filter @workspace/dashboard run dev`
- Force daily report: `POST /api/admin/report/daily`
- Force weekly report: `POST /api/admin/report/weekly`

Required secrets: `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `BINGX_API_KEY`, `BINGX_API_SECRET`, `COINGLASS_API_KEY`, `COINALYZE_API_KEY`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`
Optional: `TELEGRAM_ADMIN_CHAT_IDS` (comma-separated chat IDs for private bot alerts)

## Stack
- **Frontend**: React 19, Vite, Tailwind v4, Recharts, TanStack Query, Wouter
- **Backend**: Node.js, Express, TypeScript, esbuild
- **DB**: PostgreSQL via Drizzle ORM
- **Exchanges**: Bybit (WebSocket), BingX (REST polling fallback — WS blocked in Replit)

## Where things live
- `artifacts/dashboard/src/pages/` — Terminal, Risk, Signal, Liquidations pages
- `artifacts/api-server/src/services/` — all core services
- `artifacts/api-server/src/routes/` — API routes incl. `/admin` for manual reports
- DB schema: `artifacts/api-server/src/db/`

## Fractal Pattern Engine
- `fractalService.ts` — DTW-based pattern matching on 1D (2001 candles, ~2019→now) + 4H (1000 candles via BingX REST)
- Algorithm: DTW price distance (0.7) + Pearson volume correlation (0.3) = similarity_score per match
- Collects top-20 matches per timeframe, derives probability (win-rate), avg SL/TP, expected move
- Combined signal: 1D + 4H agree → average score; single TF → 20% penalty
- Gate threshold: overall_signal_score ≥ 0.45 + win-rate ≥ 55% + R:R ≥ 1.5
- **Fractal is the primary gate in signalTracker** — without a valid fractal signal, no trades open
- Refreshes: 1D every 6h, 4H every 4h
- API endpoint: `GET /api/fractal/signal` — returns combined + per-TF signals with full historical performance
- 4H data: BingX public REST (Bybit blocked with 403 in Replit), fallback to CryptoCompare 4H aggregate

## Architecture decisions
- **SignalTracker is the single source of truth**: opens signal when `|score| ≥ 0.35` + valid SL/TP clusters, publishes to channel via `notifyChannel()`, saves to DB on close. No time-based cooldown — only "is there an active signal".
- **Signal close triggers**: SL/TP hit OR direction reversal (score crosses ±0.35 to opposite side)
- **Telegram**: manual `getUpdates` polling (replaces `bot.launch()` which broke on AbortSignal in node-fetch@2.x). All signals/reports go directly to channel `@bitcoinmarginmaster` via `notifyChannel()`.
- **Daily report**: rolling 24h window (no dead zones). If 0 trades → sends "no signals" message instead of zeros. Manual trigger: `POST /api/admin/report/daily`.
- **CoinGlass heatmap**: unavailable on current plan → auto-fallback to coinalyze synthetic map.

## Product
- Signal engine v2: 7 weighted components (MTF CVD 0.30, OB 0.20, CVD 0.15, Momentum 0.13, VWAP 0.10, EMA 0.07, Liq 0.05) + 6 display-only
- 4 gates for `allGatesPassed`: MTF CVD alignment, OB confirms direction, SL on cluster ($3M+, 0.4–2.5%), TP on cluster ($2M+, R:R ≥ 1.5) — gates shown in Signal page but NOT required for signalTracker
- Telegram channel `@bitcoinmarginmaster`: signal open/close + daily/weekly/monthly reports
- Dashboard: Terminal `/`, Risk `/risk`, Signal `/signal`, Liquidations `/liquidations`

## User preferences
- No trailing stop, no news guard — do NOT add
- patternService is display-only (weight: 0) — do NOT make it weighted
- ATR is display-only for leverage calc — NEVER use for SL/TP (clusters only)
- All signals and stats go directly to the channel, not via bot private chat

## Gotchas
- MTF CVD needs ~5-10 min after restart to accumulate bucket data
- BingX WebSocket never connects in Replit sandbox — REST polling is normal
- `dbService.ts` has pre-existing TS errors (Date vs string Drizzle types) — server runs fine, do not fix
- SignalTracker saves to DB only on CLOSE (SL/TP/reversal) — open signals don't appear in reports yet
- Reports query `trades` table with `closed_at` not null — only closed signalTracker trades count
