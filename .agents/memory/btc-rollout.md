---
name: BTC rollout and legacy DB
description: Approval gate for BTC patterns and a Drizzle legacy-sequence migration caveat.
---
BTC history is to be exported by the scanner agent, placed in GitHub, and analyzed before patterns are proposed to the user for approval. Do not enable patterns before that approval.

**Why:** The user specified this rollout order and said the Telegram channel setting is unused until the first patterns.

**How to apply:** Operate and verify the new engine without inventing or enabling patterns; request the channel setting securely.

Drizzle table filters do not necessarily filter independently introspected sequences. An excluded legacy table's owned sequence may still be proposed for removal, and a failed schema push may already have created new tables.

**Why:** A filtered BTC schema push created the BTC tables but then attempted to drop the legacy sequence; PostgreSQL rejected that drop because the legacy table still depended on it.

**How to apply:** Preserve legacy tables and owned sequences explicitly. Inspect actual database state after failed pushes; never use CASCADE or force to silence this failure.
