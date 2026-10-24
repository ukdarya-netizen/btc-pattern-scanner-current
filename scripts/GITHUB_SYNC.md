# GitHub synchronization

Repository: https://github.com/ukdarya-netizen/alt-pattern-scanner-current

Run `node scripts/github-sync.mjs` (the **GitHub Auto Sync** Replit workflow).
It checks `main` every 60 seconds and automatically commits local changes after
one unchanged interval. Existing staged changes are left for manual review.
GitHub commits are downloaded only by fast-forward. If both sides have new
commits, synchronization pauses until the branches are manually merged.
It never force-pushes, resets your working tree, or resolves conflicts automatically.

Synchronization runs only while its Replit workflow is running, not while the
workspace is asleep. It does not publish/deploy the app or install dependencies.
Secrets remain in Replit. Common credential files are ignored and newly staged
content is checked for common hardcoded credential formats (not an exhaustive
security scanner).

Authentication uses the existing GitHub CLI login through Git's credential helper;
no token is saved in this repository.

One pass: `node scripts/github-sync.mjs --once`.
