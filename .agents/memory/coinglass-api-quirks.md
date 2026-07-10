---
name: CoinGlass v4 API quirks
description: Non-obvious details about the CoinGlass v4 REST API discovered while wiring it in as a market-data source.
---

- Base `https://open-api-v4.coinglass.com`, auth via `CG-API-KEY` header (not query param).
- No multi-symbol batch endpoint — every history endpoint takes one `symbol` at a time. Plan for N sequential requests per data type when watching N symbols.
- Endpoint paths are kebab-case (`open-interest`, `funding-rate`, `taker-buy-sell-volume`), not camelCase — camelCase 404s silently.
- `time` fields are milliseconds, not seconds — downstream code expecting Unix-seconds bars must divide by 1000.
- Price history endpoints do NOT include buy/sell taker volume; it must be fetched separately from `taker-buy-sell-volume/history` and merged by timestamp to reconstruct a buy-volume field.
- Rate limit is generous relative to Coinalyze's free tier (header `api-key-max-limit` around 300/min), so per-symbol sequential fetching across ~20 symbols is comfortable — this is why it was chosen as primary with Coinalyze demoted to fallback.

**Why:** Coinalyze free-tier rate limits caused frequent scan-cycle failures; CoinGlass has enough headroom to be primary, but its lack of batch endpoints and differing time units/casing are easy to get wrong if assumed to match Coinalyze's conventions.

**How to apply:** When adding new CoinGlass-backed data fields, always check path casing against the live API (don't assume REST convention), convert `time` to seconds before feeding into shared bar-processing code, and fetch taker volume as a separate call to merge in.
