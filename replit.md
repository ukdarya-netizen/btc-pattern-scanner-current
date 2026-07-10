# ALT Pattern Scanner

Мульти-альт паттерн-сканер — следит за списком из 20 альткоинов, вычисляет метрики по OI/цене/объёму/CVD/funding на каждом 5-минутном цикле и публикует в Telegram сигнал, когда монета подходит под один из 13 именованных паттернов. Бот остаётся сигнальным аналитиком — реальной автоторговли нет, пользователь торгует вручную по сигналам из канала.

## Run & Operate
- API server: `pnpm --filter @workspace/api-server run dev`
- Dashboard: `pnpm --filter @workspace/dashboard run dev`

Required secrets: `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `BINGX_API_KEY`, `BINGX_API_SECRET`, `COINGLASS_API_KEY`, `COINALYZE_API_KEY`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`
Optional: `TELEGRAM_ADMIN_CHAT_IDS` (comma-separated chat IDs for private bot alerts)

Note: exchange keys (Bybit/BingX) are kept from the prior BTC engine but are not currently used by the scanner — all market data now comes from Coinalyze. CoinGlass key is also retained but unused by the scanner itself.

## Stack
- **Frontend**: React 19, Vite, Tailwind v4, TanStack Query, Wouter
- **Backend**: Node.js, Express, TypeScript, esbuild
- **DB**: PostgreSQL via Drizzle ORM
- **Data source**: Coinalyze REST API (Bybit exchange code `.6`) — OI history, futures OHLCV, spot OHLCV, funding rate. Binance REST is geo-blocked (HTTP 451) from Replit, so it's not used.

## Where things live
- `artifacts/dashboard/src/pages/scanner.tsx` — single dashboard page: overall stats, per-pattern stats, open positions, watchlist metrics, recent pattern hits
- `artifacts/api-server/src/services/altScanner.ts` — core scan loop, metric computation, all 13 pattern definitions, open-position tracking
- `artifacts/api-server/src/services/coinalyzeData.ts` — Coinalyze REST client with retry/backoff for rate limits, batch fetchers for OI/OHLCV/funding
- `artifacts/api-server/src/services/dbService.ts` — persistence: save/close pattern signals, overall + per-pattern stats, open signals
- `artifacts/api-server/src/services/telegram.ts` — send-only Telegram client, publishes pattern hits to the channel
- `artifacts/api-server/src/routes/scanner.ts` — API routes: `/scanner/metrics`, `/scanner/hits`, `/scanner/signals`, `/scanner/open-positions`, `/scanner/stats/overall`, `/scanner/stats/patterns`
- DB schema: `artifacts/api-server/src/db/schema.ts` (`pattern_signals` table)

## Watchlist
20 alts (all Coinalyze futures symbol `${SYMBOL}.6`, spot `s${SYMBOL}.6`): SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, LTC, TRX, NEAR, ARB, OP, APT, SUI, INJ, TIA, RUNE, ATOM, SEI, WIF (all vs USDT).

## Cycle & metrics
- Runs every 5 minutes. Fetches data for all 20 symbols per-batch (sequentially, not concurrently, to avoid Coinalyze 429s), then computes per-symbol metrics:
  - `oiChange`: % change over 5m/15m/30m/1h/4h/24h windows
  - `priceChange`: % change current/1h/3h/4h/24h
  - `volMult` / `volMult4h`: futures volume vs recent average
  - `spotVolMult`: spot volume vs recent average
  - `takerNetBuyPct` (+15m variant) and `takerDominance` (buy/sell) from futures OHLCV buy-volume field
  - `spotCvd`: boolean "CVD positive" flags on 5m/15m/1h/4h from spot OHLCV
  - `fundingRate`
- Per-symbol previous-cycle state (`oi30m`, `oi4h`, `spotVolMult`, cascade phase-1 flag) is kept in memory for patterns that need cycle-over-cycle comparison (e.g. `flush_reversal`, `liquidation_cascade`).
- `cycleCount`: per-symbol/per-pattern streak counter of consecutive cycles where the base condition holds; some patterns require a minimum streak before firing (`requiredCycles`).

## 13 patterns (all LONG-only)
`dip_accumulation`, `4h_momentum`, `quiet_oi_accumulation`, `volume_taker` (OR-branch: streak≥2 or spotVolMult≥4x), `spot_absorption`, `flush_reversal`, `oi1h_breakout`, `spot_momentum_reversal`, `spot_oi4h_build`, `liquidation_cascade` (two-phase: sticky phase-1 flush detection gates phase-2 reversal), `spot_taker_lead`, `spot_divergence`, `accumulation_breakout`. Exact thresholds live in `PATTERNS` in `altScanner.ts` — treat that file as the source of truth over this doc.

Each pattern fires once per "episode" (stays suppressed while its base condition keeps holding, re-arms once it goes false) — no time-based cooldown, matching the old "active state only" model.

## Open positions (dashboard-only, no auto-trading)
On pattern fire, a virtual position is recorded (entry price = signal price). Each cycle, positions are checked against:
- Take-profit: +1.5%
- Stop-loss: -1.0%
- Max hold: 48 cycles (~4h)
Closed positions are saved to `pattern_signals` with `closePrice`/`pnlPct`; open positions are hydrated from DB on startup and shown live on the dashboard.

## Dashboard (`/`)
- **Общая статистика по сигналам**: total/open/closed/wins/losses, win-rate, avg PnL%
- **Статистика по паттернам**: per-pattern total/closed/wins/win-rate/avg PnL%
- **Открытые позиции**: symbol, pattern, entry price, current price, unrealized PnL%, cycles held
- **Watchlist Metrics**: live per-symbol metric table
- **Recent Pattern Hits**: session-local log of fired patterns

## Architecture decisions
- Coinalyze is rate-limited on the current plan — `getJson` in `coinalyzeData.ts` retries with retry-after-header-aware backoff (5 attempts). Occasional "rate limited, backing off" log lines during a cycle are expected, not an error.
- Data fetches within a cycle run sequentially (OI → futures OHLCV → spot OHLCV → funding), not concurrently, specifically to reduce 429s.
- Telegram: manual `getUpdates` polling in production; dev instance runs send-only (polling disabled) to avoid 409 conflicts with the production bot. All signals go directly to channel `@bitcoinmarginmaster` via `telegramService.publishPatternSignal()` — no private-chat delivery.
- Old BTC-only engine (SignalEngine, fractalService DTW gate, bufferService, botEngine, Binance data layer, old Terminal/Risk/Signal/Liquidations pages) has been fully removed. Only `altScanner.ts`, `coinalyzeData.ts`, `dbService.ts`, `telegram.ts` remain in `services/`.
- Old BTC-engine DB tables (`bot_sessions`, `open_positions`, `pnl_snapshots`, `trades`) were dropped; replaced by a single `pattern_signals` table.

## User preferences
- No trailing stop, no news guard, no cooldowns — do NOT add
- No real trade execution — signals only, user trades manually
- All signals go directly to the Telegram channel, not via bot private chat
- Dashboard/Telegram copy stays in Russian, consistent with existing UI style

## Gotchas
- Coinalyze free-tier rate limits mean the first cycle(s) after a restart may show partial/stale data until retries clear — this is expected, not a bug.
- `dbService.ts` may carry pre-existing TS quirks around Drizzle numeric/date types from the earlier engine — server runs fine.
- Positions/signals only fully appear in stats once closed (TP/SL/timeout) — open positions show live in the "Открытые позиции" section but count toward `open` in stats until closed.
