// Workspace-scoped state for the Gemini companion: job tracking + plugin config.
// Mirrors codex-plugin-cc's state.mjs in shape.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_VERSION = 1;
export const MAX_JOBS = 50;
export const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "gemini-plugin-cc");
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// Hard cap on JSON state files we'll read from disk. Defends against DoS
// from a hostile workspace that planted an enormous metadata file.
export const MAX_STATE_FILE_BYTES = 256 * 1024;

const CONFIG_FILE_NAME = "config.json";
const JOBS_DIR_NAME = "jobs";

// Job IDs come from `newJobId()` which uses base36 timestamps + random suffix.
// We constrain reads/writes to that exact shape so a caller-supplied ID like
// `../../../tmp/evil` cannot escape `jobsDir/`.
export const JOB_ID_PATTERN = /^g-[a-z0-9]+-[a-z0-9]+$/;
export function isValidJobId(s) {
  return typeof s === "string" && JOB_ID_PATTERN.test(s);
}

export function workspaceRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

export function stateDir(cwd = process.cwd()) {
  const root = workspaceRoot(cwd);
  let canonical = root;
  try { canonical = fs.realpathSync.native(root); } catch {}
  const slugSource = path.basename(root) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const base = process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT;
  return path.join(base, `${slug}-${hash}`);
}

export function jobsDir(cwd) { return path.join(stateDir(cwd), JOBS_DIR_NAME); }

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// ---------- jobs ----------

export function newJobId() {
  return "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function atomicWrite(target, content) {
  // write-then-rename so concurrent readers/writers can never see a torn file.
  // Using crypto.randomBytes (not pid+timestamp) defeats predictable-name
  // symlink attacks in shared tmp dirs. `wx` flag is exclusive-create:
  // `open` fails (EEXIST) if the path already exists, including when an
  // attacker pre-planted a symlink there.
  const tmp = `${target}.tmp.${randomBytes(12).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function readBoundedJson(filePath) {
  // Refuse to parse files larger than MAX_STATE_FILE_BYTES so a hostile
  // workspace can't OOM us via a giant config.json.
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_STATE_FILE_BYTES) {
    throw new Error(`state file too large: ${filePath} (${stat.size} > ${MAX_STATE_FILE_BYTES})`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJobMeta(jobId, meta, cwd) {
  if (!isValidJobId(jobId)) {
    throw new Error(`invalid jobId: ${String(jobId).slice(0, 64)}`);
  }
  ensureDir(jobsDir(cwd));
  atomicWrite(
    path.join(jobsDir(cwd), `${jobId}.json`),
    JSON.stringify(meta, null, 2)
  );
}

export function readJobMeta(jobId, cwd) {
  if (!isValidJobId(jobId)) return null;
  try {
    return readBoundedJson(path.join(jobsDir(cwd), `${jobId}.json`));
  } catch { return null; }
}

export function listJobs(cwd) {
  const dir = jobsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => readJobMeta(f.replace(/\.json$/, ""), cwd))
    .filter(Boolean)
    .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
}

export function pruneJobs(cwd) {
  const all = listJobs(cwd);
  // Never delete still-running jobs — losing their metadata orphans the PID
  // and breaks /gemini:status / /gemini:cancel.
  const candidates = all.filter(j => j.status !== "running");
  if (candidates.length <= MAX_JOBS) return;
  const dir = jobsDir(cwd);
  // Only unlink log paths that actually live inside our jobsDir, never blindly
  // trust whatever was recorded in a job file (defense-in-depth).
  for (const j of candidates.slice(MAX_JOBS)) {
    if (!isValidJobId(j.id)) continue;
    try { fs.unlinkSync(path.join(dir, `${j.id}.json`)); } catch {}
    if (j.stdout_path && safeJobLogPath(j.stdout_path, cwd)) {
      try { fs.unlinkSync(j.stdout_path); } catch {}
    }
    if (j.stderr_path && safeJobLogPath(j.stderr_path, cwd)) {
      try { fs.unlinkSync(j.stderr_path); } catch {}
    }
  }
}

// Confine a job-log path to the jobs directory. Job metadata is JSON we wrote
// ourselves, but the file can be tampered with on disk by anything with write
// access to ${CLAUDE_PLUGIN_DATA}. Without confinement, a manipulated stdout_path
// could make /gemini:result read any user-readable file. Returns the resolved
// path on success, or null if the path resolves outside jobsDir.
export function safeJobLogPath(p, cwd) {
  if (typeof p !== "string" || !p) return null;
  const dir = path.resolve(jobsDir(cwd));
  const resolved = path.resolve(p);
  if (path.dirname(resolved) !== dir) return null;
  return resolved;
}

// Purge non-running jobs older than maxAgeMs (default: all). Returns count.
// Safe-by-construction: only operates on jobIds matching JOB_ID_PATTERN and
// only unlinks log paths that resolve inside jobsDir.
export function purgeJobs({ maxAgeMs = null, cwd } = {}) {
  const all = listJobs(cwd);
  const dir = jobsDir(cwd);
  const cutoff = typeof maxAgeMs === "number" && maxAgeMs > 0
    ? Date.now() - maxAgeMs
    : null;
  let purged = 0;
  for (const j of all) {
    if (j.status === "running") continue;
    if (!isValidJobId(j.id)) continue;
    if (cutoff !== null) {
      const ts = Date.parse(j.ended_at || j.started_at || "");
      if (!Number.isFinite(ts) || ts > cutoff) continue;
    }
    try { fs.unlinkSync(path.join(dir, `${j.id}.json`)); purged++; } catch {}
    if (j.stdout_path && safeJobLogPath(j.stdout_path, cwd)) {
      try { fs.unlinkSync(j.stdout_path); } catch {}
    }
    if (j.stderr_path && safeJobLogPath(j.stderr_path, cwd)) {
      try { fs.unlinkSync(j.stderr_path); } catch {}
    }
  }
  return purged;
}

// ---------- config (review gate) ----------

function configFile(cwd) { return path.join(stateDir(cwd), CONFIG_FILE_NAME); }

export function readConfig(cwd) {
  try {
    const parsed = readBoundedJson(configFile(cwd));
    return parsed || { version: STATE_VERSION, reviewGateEnabled: false };
  } catch {
    return { version: STATE_VERSION, reviewGateEnabled: false };
  }
}

export function writeConfig(cwd, config) {
  ensureDir(stateDir(cwd));
  atomicWrite(configFile(cwd), JSON.stringify(config, null, 2));
}

// Cross-process lock around config.json read-modify-write. atomicWrite makes
// the file replacement atomic, but the read+modify+write pattern in
// setReviewGate / setActiveModel is not — two concurrent callers can both
// read the same starting state and the second write silently overwrites
// the first's update. The lock funnels them through one at a time.
//
// Implementation notes:
//   - O_EXCL via "wx" gives us a primitive `try-acquire`.
//   - We write the holder process's PID into the lock file on acquire so
//     stale recovery can verify the holder is genuinely dead (NTP-style
//     clock adjustments that move mtime backwards no longer falsely look
//     "stale" — pid liveness is the source of truth).
//   - Reclaiming a dead holder's lock uses `renameSync` to a unique path
//     instead of `unlinkSync`. rename is atomic and first-rename-wins:
//     two waiters that both see a dead holder can't both succeed in
//     reclaiming, which closes the prior TOCTOU where two unlinks raced
//     and one process unlinked another's freshly-created lock.
//   - Atomics.wait gives a real synchronous sleep without busy-waiting,
//     which we need because setReviewGate / setActiveModel are sync.
import { isAlive } from "./process.mjs";

const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_STALE_MS = 30_000;
// Tighter window for the no-PID-stamp recovery path. A healthy writer
// can never leave a 0-byte file for >2 s — writeSync is synchronous and
// completes in microseconds. If a 0-byte lock has been there 2 seconds,
// it's almost certainly from a terminated process. Without this shorter
// threshold, a freshly-crashed writer leaves operations blocked for the
// full 30 s `CONFIG_LOCK_STALE_MS` even though the writer is already
// gone.
const CONFIG_LOCK_ORPHAN_MS = 2_000;
const CONFIG_LOCK_POLL_MS = 25;

function sleepSync(ms) {
  // Atomics.wait blocks the thread without spinning. The shared array
  // never changes, so wait always returns "timed-out" after `ms`.
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// Strict decimal-pid match. parseInt would accept "123abc" → 123 and let
// a digit-prefixed garbage stamp masquerade as a valid pid (potentially
// referencing a live unrelated process and stranding the lock until that
// process exits). Require the entire file content to be a pid > 1.
const PID_STAMP_PATTERN = /^[1-9]\d*$/;
function readLockHolderPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (!PID_STAMP_PATTERN.test(raw)) return null;
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function tryReclaimStaleLock(lockPath) {
  // Use rename to atomically claim the right to delete a stale lock.
  // First rename wins; subsequent attempts get ENOENT and loop into the
  // normal acquire path. This is the TOCTOU fix: two waiters can't both
  // unlink the same lock file and then race to create new ones.
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(lockPath, reclaimPath);
  } catch {
    return false;  // someone else reclaimed first, or it's already gone
  }
  // Re-confirm the holder is dead inside the quarantined copy before
  // discarding (the rename happened, but if a live holder somehow had
  // the same dead-looking pid via reuse we'd rather not destroy their
  // record). A missing/unparseable PID is treated as dead — we only
  // reach this branch when the caller already decided the lock was
  // orphaned (either dead-pid or no-pid-stamp + aged mtime).
  const stillDead = (() => {
    const pid = readLockHolderPid(reclaimPath);
    if (pid === null) return true;
    return !isAlive(pid);
  })();
  if (stillDead) {
    try { fs.unlinkSync(reclaimPath); } catch {}
    return true;
  }
  // Live holder showed up under the same pid (unlikely but possible).
  // Restore the lock and back off.
  try { fs.renameSync(reclaimPath, lockPath); } catch {}
  return false;
}

function withConfigLock(cwd, fn) {
  const dir = stateDir(cwd);
  ensureDir(dir);
  const lockPath = path.join(dir, CONFIG_FILE_NAME + ".lock");
  const start = Date.now();
  let fd = null;
  while (Date.now() - start < CONFIG_LOCK_TIMEOUT_MS) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      // Stamp our PID so a future stale check can verify liveness.
      try { fs.writeSync(fd, String(process.pid)); } catch {}
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Holder exists. Reclaim if any of:
      //   (a) PID is parseable AND the process is dead AND mtime is stale.
      //       Two conditions together — a live process under load can age
      //       past the window, and a freshly-created lock can have a stale
      //       mtime under clock skew (NTP adjustment), so neither alone
      //       is sufficient.
      //   (b) Lock file has no parseable PID (empty / partial write /
      //       legacy v0.5.6 lock) AND mtime is stale. Without this
      //       fallback, a crash between `openSync("wx")` and `writeSync`
      //       leaves a 0-byte lock that's permanently unrecoverable —
      //       worse than the v0.5.5 mtime-only behavior we replaced.
      const holderPid = readLockHolderPid(lockPath);
      let tooOld = false;
      try {
        const lstat = fs.statSync(lockPath);
        tooOld = Date.now() - lstat.mtimeMs > CONFIG_LOCK_STALE_MS;
      } catch {}
      const holderDead = holderPid !== null && !isAlive(holderPid);
      const noPidStamp = holderPid === null;
      // (b) fallback uses a much shorter window. A healthy stamp-write is
      // microseconds; if the file is still missing/garbled after 2 s, the
      // writer crashed. Keeping the 30 s window only for the dead-pid case
      // protects live-pid-aged-mtime from being mistakenly reclaimed.
      let orphanAge = false;
      try {
        const lstat = fs.statSync(lockPath);
        orphanAge = Date.now() - lstat.mtimeMs > CONFIG_LOCK_ORPHAN_MS;
      } catch {}
      const orphanedByMissingPid = noPidStamp && orphanAge;
      if ((holderDead && tooOld) || orphanedByMissingPid) {
        if (tryReclaimStaleLock(lockPath)) continue;
      }
      sleepSync(CONFIG_LOCK_POLL_MS);
    }
  }
  if (fd === null) {
    throw new Error(`config.json lock acquisition timeout: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

export function setReviewGate(cwd, enabled) {
  return withConfigLock(cwd, () => {
    const c = readConfig(cwd);
    c.reviewGateEnabled = !!enabled;
    c.version = STATE_VERSION;
    writeConfig(cwd, c);
    return c;
  });
}

// Persist the model that setup's fallback chain landed on, so subsequent
// per-workspace invocations of /gemini:ask, /gemini:review, /gemini:task
// inherit it. Pass null to clear (e.g. when the configured default works
// again on a later setup). The model id is validated to avoid persisting
// arbitrary strings written by a hostile config tamper.
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
export function setActiveModel(cwd, model) {
  return withConfigLock(cwd, () => {
    const c = readConfig(cwd);
    if (model === null || model === undefined) {
      delete c.activeModel;
    } else {
      if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) {
        throw new Error(`invalid model id: ${String(model).slice(0, 64)}`);
      }
      c.activeModel = model;
    }
    c.version = STATE_VERSION;
    writeConfig(cwd, c);
    return c;
  });
}
