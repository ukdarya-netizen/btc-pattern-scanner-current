---
name: Intentional code reset
description: User's explicit reset instruction overrides historical scanner documentation.
---
The user explicitly required deleting the bot code while retaining API and Telegram access.
Do not restore the old scanner merely because its documentation, archives, or Git history remain.
The user subsequently specified uploading the current cleared code, not the pre-deletion bot, to GitHub.

**Why:** The earlier addition of TA patterns to the old scanner did not follow the user's instruction to replace it, and the user repeated the reset instruction.

**How to apply:** Treat old scanner documentation as historical context, not permission to restart or rebuild the old bot. Require a new request before restoring functionality.
