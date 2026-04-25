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
    if (j.stdout_path && path.dirname(path.resolve(j.stdout_path)) === dir) {
      try { fs.unlinkSync(j.stdout_path); } catch {}
    }
    if (j.stderr_path && path.dirname(path.resolve(j.stderr_path)) === dir) {
      try { fs.unlinkSync(j.stderr_path); } catch {}
    }
  }
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

export function setReviewGate(cwd, enabled) {
  const c = readConfig(cwd);
  c.reviewGateEnabled = !!enabled;
  c.version = STATE_VERSION;
  writeConfig(cwd, c);
  return c;
}
