import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isValidJobId,
  newJobId,
  writeJobMeta,
  readJobMeta,
  listJobs,
  pruneJobs,
  purgeJobs,
  jobsDir,
  safeJobLogPath,
  setReviewGate,
  readConfig,
  setActiveModel,
  stateDir
} from "../plugins/gemini/scripts/lib/state.mjs";

// Each test gets a fresh CLAUDE_PLUGIN_DATA so state writes are isolated.
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-test-"));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

beforeEach(() => {
  freshDataDir();
});

test("isValidJobId: accepts well-formed ids", () => {
  assert.equal(isValidJobId("g-abc123-xy9z"), true);
  assert.equal(isValidJobId("g-moemxyz-1234"), true);
});

test("isValidJobId: rejects path-traversal attempts", () => {
  assert.equal(isValidJobId("../etc/passwd"), false);
  assert.equal(isValidJobId("g-abc/../evil"), false);
  assert.equal(isValidJobId("/absolute/path"), false);
});

test("isValidJobId: rejects shell metacharacters and null bytes", () => {
  assert.equal(isValidJobId("g-abc;rm-rf"), false);
  assert.equal(isValidJobId("g-abc\x00null"), false);
  assert.equal(isValidJobId("g-abc$(echo)"), false);
});

test("isValidJobId: rejects wrong shape", () => {
  assert.equal(isValidJobId("noprefix-123"), false);
  assert.equal(isValidJobId("g-toolong-toolong-extra"), false);
  assert.equal(isValidJobId("g-CAPS-allowed?"), false);
  assert.equal(isValidJobId(""), false);
  assert.equal(isValidJobId(null), false);
  assert.equal(isValidJobId(42), false);
});

test("newJobId: matches the validation pattern", () => {
  for (let i = 0; i < 20; i++) {
    const id = newJobId();
    assert.equal(isValidJobId(id), true, `newJobId returned invalid id: ${id}`);
  }
});

test("writeJobMeta + readJobMeta roundtrip", () => {
  const id = newJobId();
  const meta = { id, kind: "task", status: "running", task_text: "hi" };
  writeJobMeta(id, meta);
  const back = readJobMeta(id);
  assert.equal(back.id, id);
  assert.equal(back.kind, "task");
  assert.equal(back.task_text, "hi");
});

test("writeJobMeta refuses invalid jobId (defense against caller bugs)", () => {
  let err;
  try { writeJobMeta("../evil", { id: "../evil" }); } catch (e) { err = e; }
  assert.equal(/invalid jobId/.test(err && err.message), true);
});

test("readJobMeta returns null for invalid jobId without throwing", () => {
  assert.equal(readJobMeta("../etc/passwd"), null);
});

test("listJobs: returns empty array when dir does not exist", () => {
  assert.deepEqual(listJobs(), []);
});

test("listJobs: returns jobs sorted by started_at descending", () => {
  const a = newJobId();
  const b = newJobId();
  writeJobMeta(a, { id: a, started_at: "2026-01-01T00:00:00Z", status: "completed" });
  writeJobMeta(b, { id: b, started_at: "2026-04-01T00:00:00Z", status: "completed" });
  const all = listJobs();
  assert.equal(all[0].id, b);
  assert.equal(all[1].id, a);
});

test("safeJobLogPath: accepts paths inside jobsDir", () => {
  const id = newJobId();
  writeJobMeta(id, { id, status: "completed" }); // ensure jobsDir exists
  const inside = path.join(jobsDir(), `${id}.stdout.log`);
  assert.equal(safeJobLogPath(inside), path.resolve(inside));
});

test("safeJobLogPath: rejects paths outside jobsDir", () => {
  assert.equal(safeJobLogPath("/etc/passwd"), null);
  assert.equal(safeJobLogPath("/tmp/foo.log"), null);
  assert.equal(safeJobLogPath("../../escape.txt"), null);
});

test("safeJobLogPath: rejects non-string and empty input", () => {
  assert.equal(safeJobLogPath(""), null);
  assert.equal(safeJobLogPath(null), null);
  assert.equal(safeJobLogPath(undefined), null);
  assert.equal(safeJobLogPath(42), null);
});

test("purgeJobs: deletes all non-running jobs by default", () => {
  const a = newJobId(), b = newJobId(), c = newJobId();
  writeJobMeta(a, { id: a, status: "completed" });
  writeJobMeta(b, { id: b, status: "failed" });
  writeJobMeta(c, { id: c, status: "running" });
  const purged = purgeJobs();
  assert.equal(purged, 2);
  assert.equal(readJobMeta(c) !== null, true); // running survived
  assert.equal(readJobMeta(a), null);
  assert.equal(readJobMeta(b), null);
});

test("purgeJobs: --older-than respects ended_at", () => {
  const old = newJobId(), recent = newJobId();
  const longAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const justNow = new Date(Date.now() - 60_000).toISOString();
  writeJobMeta(old, { id: old, status: "completed", ended_at: longAgo, started_at: longAgo });
  writeJobMeta(recent, { id: recent, status: "completed", ended_at: justNow, started_at: justNow });
  const purged = purgeJobs({ maxAgeMs: 86_400_000 }); // 1 day
  assert.equal(purged, 1);
  assert.equal(readJobMeta(old), null);
  assert.equal(readJobMeta(recent) !== null, true);
});

test("setReviewGate / readConfig: persists toggle", () => {
  setReviewGate(process.cwd(), true);
  assert.equal(readConfig(process.cwd()).reviewGateEnabled, true);
  setReviewGate(process.cwd(), false);
  assert.equal(readConfig(process.cwd()).reviewGateEnabled, false);
});

test("setActiveModel: persists model id and is clearable", () => {
  setActiveModel(process.cwd(), "gemini-2.5-pro");
  assert.equal(readConfig(process.cwd()).activeModel, "gemini-2.5-pro");
  setActiveModel(process.cwd(), null);
  assert.equal(readConfig(process.cwd()).activeModel, undefined);
});

// Smoke test: the cmdTask write-gate must refuse BEFORE checking whether the
// gemini binary is installed. If the order is reversed, a CI runner (no
// gemini installed) sees "not installed" instead of the policy reason — and
// worse, a real user sees contradictory feedback. This test invokes the
// dispatcher directly with a guaranteed-missing PATH so `which("gemini")`
// fails, and asserts the write refusal still wins.
test("cmdTask: --write refusal fires BEFORE the gemini-not-installed check", async () => {
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const companion = path.resolve(here, "../plugins/gemini/scripts/companion.mjs");

  const r = spawnSync(process.execPath, [companion, "task", "--write", "anything"], {
    encoding: "utf8",
    env: {
      // Empty PATH guarantees `which gemini` fails. The refusal must still win.
      PATH: "/nonexistent",
      HOME: process.env.HOME || "/tmp",
      // Critically: do NOT set GEMINI_PLUGIN_ALLOW_WRITE.
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA
    }
  });

  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr was: ${r.stderr}`);
  assert.match((r.stderr || "") + (r.stdout || ""), /GEMINI_PLUGIN_ALLOW_WRITE/);
  assert.doesNotMatch((r.stderr || "") + (r.stdout || ""), /not installed/);
});

test("setReviewGate: removes the lock file after the operation", () => {
  // withConfigLock must release the lock whether the wrapped fn returns
  // normally or throws. A leftover .lock file would block all subsequent
  // setReviewGate / setActiveModel calls until the 30s stale-lock window
  // elapses — a regression that stale tests would have missed.
  setReviewGate(process.cwd(), true);
  const dir = stateDir(process.cwd());
  assert.equal(fs.existsSync(path.join(dir, "config.json.lock")), false);
});

test("setReviewGate + setActiveModel concurrent calls preserve both fields", async () => {
  // Genuinely-concurrent contention check: launch many child processes via
  // async spawn() (NOT spawnSync, which serializes) and Promise.all on
  // their exits, so the OS schedules them overlappingly. Without the
  // lock, the read-modify-write windows interleave and updates are lost.
  // With the lock, every writer's update lands.
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const tmpData = process.env.CLAUDE_PLUGIN_DATA;
  const stateModule = path.resolve(here, "../plugins/gemini/scripts/lib/state.mjs").replace(/\\/g, "/");

  const setGateScript = `
    import("${stateModule}").then(m => m.setReviewGate(process.cwd(), true));
  `;
  const setModelScript = `
    import("${stateModule}").then(m => m.setActiveModel(process.cwd(), "gemini-2.5-pro"));
  `;
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: tmpData };

  function launch(script) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["-e", script], {
        env,
        stdio: ["ignore", "ignore", "pipe"]
      });
      let err = "";
      p.stderr.on("data", d => { err += d.toString(); });
      p.on("exit", code => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`)));
      p.on("error", reject);
    });
  }

  // Multiple writers per side: alternating gate-toggle and model-set so
  // any unlocked window of one would clobber the other's recent write.
  const procs = [];
  for (let i = 0; i < 4; i++) {
    procs.push(launch(setGateScript));
    procs.push(launch(setModelScript));
  }
  await Promise.all(procs);

  const { readConfig } = await import("../plugins/gemini/scripts/lib/state.mjs");
  const cfg = readConfig(process.cwd());
  assert.equal(cfg.reviewGateEnabled, true);
  assert.equal(cfg.activeModel, "gemini-2.5-pro");
});

test("--timeout overflow is clamped, not silently truncated", async () => {
  // Node's setTimeout caps at 2^31-1 ms; any larger delay fires at ~1ms
  // with a TimeoutOverflowWarning. resolveTimeoutMs must clamp before the
  // value hits setTimeout, otherwise --timeout 30d turns into "instantly".
  // Invoking the dispatcher with a guaranteed-missing gemini lets us check
  // the clamp warning fires before the not-installed exit.
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const companion = path.resolve(here, "../plugins/gemini/scripts/companion.mjs");

  const r = spawnSync(process.execPath, [companion, "ask", "--timeout", "30d", "test"], {
    encoding: "utf8",
    env: {
      PATH: "/nonexistent",
      HOME: process.env.HOME || "/tmp",
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA
    }
  });
  assert.match(r.stderr || "", /exceeds Node's max setTimeout/);
});

test("runJob: silent-failure diagnostic fires on non-zero exit with empty buffers", async () => {
  // Issue #3 regression guard. Previously, a Gemini process that exited
  // non-zero without writing any stdout/stderr AND without matching
  // classifyAuthBlob left the user with zero diagnostic output — and a
  // rescue parent would see "no output" with no clue why. The new branch
  // in runJob's close handler emits a structured marker pointing at
  // /gemini:result. We exercise it by mocking gemini with a tiny shell
  // script that exits 1 and writes nothing.
  const { spawnSync } = await import("node:child_process");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const companion = path.resolve(here, "../plugins/gemini/scripts/companion.mjs");

  const fakeBinDir = fsm.mkdtempSync(path.join(os.tmpdir(), "gemini-fake-bin-"));
  const fakeGemini = path.join(fakeBinDir, "gemini");
  fsm.writeFileSync(fakeGemini, "#!/bin/sh\nexit 1\n");
  fsm.chmodSync(fakeGemini, 0o755);

  const r = spawnSync(process.execPath, [companion, "task", "anything"], {
    encoding: "utf8",
    env: {
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
      HOME: process.env.HOME || "/tmp",
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA
    }
  });

  const combined = (r.stderr || "") + (r.stdout || "");
  assert.match(
    combined,
    /exited 1 with no stdout\/stderr/,
    `Expected silent-failure diagnostic, got stderr=${r.stderr} stdout=${r.stdout}`
  );
  assert.match(
    combined,
    /\/gemini:result/,
    "Diagnostic should point user at /gemini:result"
  );
});

test("setActiveModel: rejects invalid model ids (defense against config tamper)", () => {
  const bad = [
    "model;rm-rf",
    "model with space",
    "model$(echo)",
    "model/with/slash",
    "../escape",
    "a".repeat(65),
    "",
    null  // null is the legitimate "clear" value, but other falsy types are bugs
  ];
  for (const v of bad) {
    if (v === null) continue;  // null is the documented clear sentinel
    let err;
    try { setActiveModel(process.cwd(), v); } catch (e) { err = e; }
    assert.equal(/invalid model id/.test(err && err.message || ""), true,
      `expected rejection for ${JSON.stringify(v)}`);
  }
});
