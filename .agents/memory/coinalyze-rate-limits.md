---
name: Coinalyze rate limits
description: Why Coinalyze API calls show "rate limited, backing off" warnings during scan cycles
---
Coinalyze's free/current plan rate-limits batch requests across many symbols (20+ symbols per OI/OHLCV/funding call). Warnings like "Coinalyze rate limited, backing off" with retryAfterMs in logs are expected and self-recovering via retry-after-aware backoff — not an error requiring a code fix.

**Why:** confirmed during multi-alt scanner buildout — cycles complete successfully after transient 429s clear, data is fully populated once retries finish.

**How to apply:** when debugging "empty metrics" or "stale watchlist" symptoms right after a server restart, check for these warnings first — they usually resolve within the same or next cycle without intervention. Don't add extra caching/dedup logic to "fix" this.
