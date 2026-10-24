import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const once = process.argv.includes("--once");
const expectedRemote = "https://github.com/ukdarya-netizen/alt-pattern-scanner-current.git";
const log = (message) => console.log(`[github-sync] ${message}`);
const git = (...args) => execFileSync("git", args, {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

mkdirSync(".local", { recursive: true });
// An OS advisory lock also releases automatically if the workflow is killed.
if (!process.env.GITHUB_SYNC_LOCKED) {
  execFileSync("flock", [
    "--nonblock", ".local/github-sync.lock", process.execPath,
    fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], {
    cwd: root,
    env: { ...process.env, GITHUB_SYNC_LOCKED: "1" },
    stdio: "inherit",
  });
  process.exit(0);
}

const blockedPath = /(^|\/)(?:\.env(?:\..*)?|credentials\.json|secrets\.json)$|\.(?:pem|key)$/i;
const credentialPatterns = [
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /(?:api[_-]?(?:key|secret)|token|password)\s*[:=]\s*["'][A-Za-z0-9_:/+.-]{20,}["']/i,
];

function checkStagedFiles() {
  const paths = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);
  for (const path of paths) {
    if (blockedPath.test(path) && !/\.env\.(?:example|sample)$/.test(path)) {
      throw new Error(`Credential file blocked: ${path}`);
    }
    const content = git("show", `:${path}`);
    if (credentialPatterns.some((pattern) => pattern.test(content))) {
      throw new Error(`Possible hardcoded credential blocked: ${path}`);
    }
  }
}

let previousFingerprint;
function sync() {
  if (git("branch", "--show-current") !== "main") {
    throw new Error("Paused: checked-out branch is not main.");
  }
  if (git("remote", "get-url", "origin") !== expectedRemote) {
    throw new Error("Paused: origin does not match the configured repository.");
  }
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    try { git("rev-parse", "--verify", marker); }
    catch { continue; }
    throw new Error("Paused: a Git operation is already in progress.");
  }
  // Never take over changes someone has explicitly staged.
  if (git("diff", "--cached", "--name-only")) {
    throw new Error("Paused: staged changes require manual review/commit.");
  }
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status) {
    const hash = createHash("sha256").update(status).update(git("diff", "HEAD", "--"));
    for (const path of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
      hash.update(path).update(readFileSync(path));
    }
    const fingerprint = hash.digest("hex");
    if (!once && previousFingerprint !== fingerprint) {
      previousFingerprint = fingerprint;
      log("Local changes detected; waiting one interval before committing.");
      return;
    }
    git("add", "--all");
    try { checkStagedFiles(); }
    catch (error) {
      git("reset", "--quiet");
      throw error;
    }
    git("commit", "-m", "Sync current project changes from Replit");
    previousFingerprint = undefined;
  }
  git("fetch", "--quiet", "origin", "main");
  const [ahead, behind] = git("rev-list", "--left-right", "--count", "HEAD...origin/main")
    .split(/\s+/).map(Number);
  if (ahead && behind) {
    throw new Error("Paused: both sides have new commits. Merge manually; no force push or reset performed.");
  }
  if (behind) {
    git("merge", "--ff-only", "origin/main");
    log("Downloaded GitHub changes.");
  }
  if (ahead) {
    git("push", "origin", "HEAD:main");
    log("Uploaded Replit changes.");
  }
  log("Up to date.");
}

function tick() {
  try { sync(); }
  catch (error) {
    // Do not log command stderr, which can contain credential-bearing URLs.
    log(error?.status !== undefined
      ? "Git command failed; check access/network or resolve Git state. No force operation was performed."
      : error.message);
    if (once) process.exitCode = 1;
  }
}
tick();
if (!once) setInterval(tick, 60_000);
