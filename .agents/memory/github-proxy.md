---
name: GitHub proxy
description: Replit's GitHub CLI may configure an internal secure proxy remote.
---
GitHub CLI operations can create remotes on `github.replit.internal` while reporting the public repository URL on `github.com`. The CLI explicitly identifies this as Replit's secure GitHub proxy.

**Why:** Assuming the remote must use github.com can incorrectly block an otherwise working repository connection. A source-control connector also withheld credentials while the GitHub App connector and CLI worked.

**How to apply:** Verify the repository owner/name and recognize both public and Replit secure-proxy hosts; do not extract tokens or rewrite working authentication merely because the host differs.
