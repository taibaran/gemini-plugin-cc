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
  setActiveModel
} from "../scripts/lib/state.mjs";

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
