#!/usr/bin/env node
// Gemini Companion — slim dispatcher.
// Subcommands: setup | ask | review | adversarial-review | task | status | result | cancel
//
// Heavy lifting lives in scripts/lib/ — this file just routes.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { parseArgs, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS } from "./lib/args.mjs";
import {
  ensureDir, jobsDir, newJobId,
  writeJobMeta, readJobMeta, listJobs, pruneJobs,
  readConfig, setReviewGate
} from "./lib/state.mjs";
import { isAlive, terminateProcessTree } from "./lib/process.mjs";
import { captureDiff } from "./lib/git.mjs";
import {
  which, geminiVersion, authProbe, classifyAuthBlob,
  detectAuthSource, geminiBaseArgs, effectiveModel, DEFAULT_MODEL
} from "./lib/gemini.mjs";
import { buildReviewPrompt } from "./lib/prompts.mjs";
import { renderJobTable, renderJobDetails, fmtTime } from "./lib/render.mjs";

// ---------- subcommand: setup ----------

function cmdSetup({ flags }) {
  const wantJson = !!flags.json;
  const result = {
    ready: false,
    node: { available: !!process.versions.node, detail: `v${process.versions.node}` },
    npm: { available: !!which("npm"), detail: null },
    gemini: { available: false, detail: null },
    auth: { available: false, detail: null, source: null },
    model: { active: effectiveModel(), default: DEFAULT_MODEL, override: process.env.GEMINI_PLUGIN_MODEL || null },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  };

  // Toggle review gate first so the result reflects the new state.
  if (flags["enable-review-gate"]) {
    setReviewGate(process.cwd(), true);
    result.actionsTaken.push("Enabled the stop-time review gate for this workspace.");
  } else if (flags["disable-review-gate"]) {
    setReviewGate(process.cwd(), false);
    result.actionsTaken.push("Disabled the stop-time review gate for this workspace.");
  }
  const cfg = readConfig(process.cwd());
  result.reviewGateEnabled = !!cfg.reviewGateEnabled;

  if (result.npm.available) {
    const r = spawnSync("npm", ["--version"], { encoding: "utf8" });
    result.npm.detail = r.status === 0 ? r.stdout.trim() : "available";
  } else {
    result.npm.detail = "not found";
  }

  const gemBin = which("gemini");
  if (gemBin) {
    result.gemini.available = true;
    result.gemini.detail = geminiVersion() || "installed";
  } else {
    result.gemini.detail = "not installed";
    result.nextSteps.push("Install Gemini CLI: `npm install -g @google/gemini-cli`");
  }

  if (gemBin) {
    const probe = authProbe();
    result.auth.available = probe.ok;
    result.auth.detail = probe.detail;
    // Only claim a specific source when auth actually works. Otherwise
    // detectAuthSource() returns "settings.json (oauth)" as a fallback,
    // which falsely implies oauth is configured when nothing is.
    result.auth.source = probe.ok ? detectAuthSource() : null;
    if (!probe.ok) {
      result.nextSteps.push(
        "Authenticate Gemini. Either:\n  • Run `!gemini` once and complete the Google OAuth flow, OR\n  • Set GEMINI_API_KEY (free key from https://aistudio.google.com/app/apikey)."
      );
    }
  }

  if (result.gemini.available && result.auth.available && !result.reviewGateEnabled) {
    result.nextSteps.push("Optional: run `/gemini:setup --enable-review-gate` to require a fresh review before stop.");
  }

  result.ready = result.gemini.available && result.auth.available;

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.actionsTaken.length) {
      for (const a of result.actionsTaken) console.log(a);
      console.log("");
    }
    console.log(`Node:         ${result.node.detail}`);
    console.log(`npm:          ${result.npm.available ? result.npm.detail : "missing"}`);
    console.log(`Gemini:       ${result.gemini.detail}`);
    console.log(`Auth:         ${result.auth.available ? "✅ working" : "❌ " + result.auth.detail}${result.auth.source ? ` (${result.auth.source})` : ""}`);
    console.log(`Model:        ${result.model.active}${result.model.override ? "  (via GEMINI_PLUGIN_MODEL)" : "  (plugin default)"}`);
    console.log(`Review gate:  ${result.reviewGateEnabled ? "enabled" : "disabled"}`);
    if (result.nextSteps.length) {
      console.log("\nNext steps:");
      for (const step of result.nextSteps) console.log(`- ${step}`);
    } else {
      console.log("\n✅ Gemini plugin is ready.");
    }
  }
  process.exit(result.ready ? 0 : 1);
}

// ---------- subcommand: ask ----------

function cmdAsk({ flags, positional }) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: ask <question>");
    process.exit(2);
  }
  if (!which("gemini")) {
    console.error("Gemini CLI not installed. Run `/gemini:setup`.");
    process.exit(127);
  }
  const args = ["-p", prompt, ...geminiBaseArgs({ readOnly: true, model: flags.model })];
  const r = spawnSync("gemini", args, { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(r.stderr);
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /gemini:setup.]\n`);
  }
  process.exit(r.status ?? 0);
}

// ---------- subcommand: review / adversarial-review ----------

function validateReviewSchemaShallow(obj) {
  // Minimal shape check (no deps). Catches obvious wrapper-extraction mistakes;
  // does not enforce field types in detail. If the user wants full validation
  // they can run the JSON through ajv themselves.
  if (!obj || typeof obj !== "object") return "not an object";
  for (const key of ["verdict", "summary", "findings", "next_steps"]) {
    if (!(key in obj)) return `missing required key: ${key}`;
  }
  if (!["approve", "needs-attention"].includes(obj.verdict)) return `bad verdict: ${obj.verdict}`;
  if (!Array.isArray(obj.findings)) return "findings is not an array";
  return null;
}

function cmdReview({ flags, positional }, { adversarial }) {
  if (!which("gemini")) {
    console.error("Gemini CLI not installed. Run `/gemini:setup`.");
    process.exit(127);
  }
  const scope = flags.scope || "auto";
  const base = flags.base || null;
  const focus = positional.join(" ").trim();
  const jsonOutput = !!flags.json;
  const diffResult = captureDiff({ scope: scope === "branch" ? "branch" : scope, base });

  if (diffResult.kind === "no-repo") {
    console.log("Not inside a git repository — nothing to review.");
    process.exit(0);
  }
  if (diffResult.kind === "no-base") {
    console.error("Branch review needs a base ref. Pass --base <ref> (no origin/main, origin/master, main, or master found).");
    process.exit(2);
  }
  if (diffResult.kind === "bad-ref") {
    console.error(`Invalid git ref for --base: ${base}`);
    process.exit(2);
  }
  if (!diffResult.diff.trim()) {
    console.log(`Nothing to review (scope: ${diffResult.kind}${diffResult.base ? `, base: ${diffResult.base}` : ""}).`);
    process.exit(0);
  }

  const target = diffResult.kind + (diffResult.base ? ` (base: ${diffResult.base})` : "");
  const prompt = buildReviewPrompt({ adversarial, focus, target, jsonOutput });
  const args = ["-p", prompt, ...geminiBaseArgs({ readOnly: true, model: flags.model, jsonOutput })];

  // Track this review as a job so /gemini:status surfaces it (matches the
  // hint we publish from commands/review.md when running in background mode).
  const jobId = newJobId();
  const dir = jobsDir();
  ensureDir(dir);
  const stdoutPath = path.join(dir, `${jobId}.stdout.log`);
  const stderrPath = path.join(dir, `${jobId}.stderr.log`);

  const meta = {
    version: 1,
    id: jobId,
    kind: adversarial ? "adversarial-review" : "review",
    pid: null,
    command: ["gemini", ...args],
    started_at: new Date().toISOString(),
    status: "running",
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    task_text: `${target}${focus ? ` — focus: ${focus}` : ""}`,
    json_output: jsonOutput,
    model: flags.model || null
  };

  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  const proc = spawn("gemini", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
  meta.pid = proc.pid;
  writeJobMeta(jobId, meta);
  pruneJobs();

  proc.stdin.write(diffResult.diff);
  proc.stdin.end();

  const MAX_BUF = 256 * 1024;
  let outBuf = "", errBuf = "";
  proc.stdout.on("data", d => {
    fs.writeSync(stdoutFd, d);
    if (!jsonOutput) process.stdout.write(d);
    if (outBuf.length < MAX_BUF) outBuf += d.toString().slice(0, MAX_BUF - outBuf.length);
  });
  proc.stderr.on("data", d => {
    fs.writeSync(stderrFd, d);
    if (errBuf.length < MAX_BUF) errBuf += d.toString().slice(0, MAX_BUF - errBuf.length);
  });
  proc.on("close", code => {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    const current = readJobMeta(jobId) || meta;
    if (current.status === "cancelled") {
      current.exit_code = code;
      writeJobMeta(jobId, current);
    } else {
      meta.status = code === 0 ? "completed" : "failed";
      meta.exit_code = code;
      meta.ended_at = new Date().toISOString();
      writeJobMeta(jobId, meta);
    }

    if (code !== 0) {
      if (errBuf) process.stderr.write(errBuf);
      const why = classifyAuthBlob(outBuf + "\n" + errBuf);
      if (why) process.stderr.write(`\n[hint: ${why}. Run /gemini:setup.]\n`);
      process.exit(code ?? 0);
    }
    if (jsonOutput) {
      // Gemini's `-o json` returns: { session_id, response, stats }.
      // Strip the wrapper, strip markdown fences, validate shallow shape,
      // then emit clean JSON. Re-read the full stdout file from disk —
      // outBuf is capped at MAX_BUF and a JSON payload near or past that
      // cap would be corrupted as a parse target. The on-disk file has
      // no cap.
      let fullOut;
      try { fullOut = fs.readFileSync(stdoutPath, "utf8"); } catch { fullOut = outBuf; }
      try {
        const wrapper = JSON.parse(fullOut);
        let inner = (wrapper.response ?? "").trim();
        const fenced = inner.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fenced) inner = fenced[1].trim();
        const parsed = JSON.parse(inner);
        const why = validateReviewSchemaShallow(parsed);
        if (why) {
          // Schema mismatch: still emit the unwrapped payload (not the
          // CLI wrapper). The wrapper is { session_id, response, stats }
          // and is never what a downstream JSON consumer wants.
          process.stderr.write(`[gemini-plugin] review --json: schema mismatch (${why}). Returning unwrapped payload.\n`);
          process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
        } else {
          process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
        }
      } catch {
        // Could not parse as JSON wrapper at all — emit whatever we have.
        process.stdout.write(fullOut);
      }
    }
    process.exit(0);
  });
  proc.on("error", err => {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    meta.status = "failed";
    meta.exit_code = -1;
    meta.error = err.message;
    meta.ended_at = new Date().toISOString();
    writeJobMeta(jobId, meta);
    console.error(`Failed to spawn gemini: ${err.message}`);
    process.exit(127);
  });
}

// ---------- subcommand: task ----------

function cmdTask({ flags, positional }) {
  const taskText = positional.join(" ").trim();
  if (!taskText) {
    console.error("Usage: task <description of what to do>");
    process.exit(2);
  }
  if (!which("gemini")) {
    console.error("Gemini CLI not installed. Run `/gemini:setup`.");
    process.exit(127);
  }

  const isWrite = !!flags.write && !flags["read-only"];
  const jobId = newJobId();
  const dir = jobsDir();
  ensureDir(dir);
  const stdoutPath = path.join(dir, `${jobId}.stdout.log`);
  const stderrPath = path.join(dir, `${jobId}.stderr.log`);

  const args = [
    "-p", taskText,
    ...geminiBaseArgs({ readOnly: !isWrite, model: flags.model })
  ];

  const meta = {
    version: 1,
    id: jobId,
    kind: "task",
    write: isWrite,
    pid: null,
    command: ["gemini", ...args],
    started_at: new Date().toISOString(),
    status: "running",
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    task_text: taskText,
    model: flags.model || null
  };

  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  const proc = spawn("gemini", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  meta.pid = proc.pid;
  writeJobMeta(jobId, meta);
  pruneJobs();

  proc.stdout.on("data", chunk => {
    process.stdout.write(chunk);
    fs.writeSync(stdoutFd, chunk);
  });
  proc.stderr.on("data", chunk => {
    fs.writeSync(stderrFd, chunk);
  });

  proc.on("close", code => {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    const current = readJobMeta(jobId) || meta;
    if (current.status === "cancelled") {
      current.exit_code = code;
      writeJobMeta(jobId, current);
      meta.status = "cancelled";
    } else {
      meta.status = code === 0 ? "completed" : "failed";
      meta.exit_code = code;
      meta.ended_at = new Date().toISOString();
      writeJobMeta(jobId, meta);
    }
    if (code !== 0 && meta.status !== "cancelled") {
      try {
        const errOut = fs.readFileSync(stderrPath, "utf8");
        if (errOut) process.stderr.write(errOut);
      } catch {}
    }
    process.stdout.write(`\n\n[gemini-plugin] Job ${jobId} ${meta.status} (exit ${code}).\n`);
    process.stdout.write(`[gemini-plugin] /gemini:result ${jobId}\n`);
    process.exit(code ?? 0);
  });

  proc.on("error", err => {
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    meta.status = "failed";
    meta.exit_code = -1;
    meta.error = err.message;
    meta.ended_at = new Date().toISOString();
    writeJobMeta(jobId, meta);
    console.error(`Failed to spawn gemini: ${err.message}`);
    process.exit(127);
  });
}

// ---------- subcommand: status ----------

function refreshStatus(meta) {
  if (meta.status === "running" && !isAlive(meta.pid)) {
    meta.status = "ended";
    meta.ended_at = meta.ended_at || new Date().toISOString();
    writeJobMeta(meta.id, meta);
  }
}

function cmdStatus({ flags, positional }) {
  const target = positional[0];
  if (target) {
    const meta = readJobMeta(target);
    if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
    refreshStatus(meta);
    console.log(renderJobDetails(meta));
    process.exit(0);
  }
  const limit = flags.all ? 50 : 10;
  const all = listJobs().slice(0, limit);
  for (const j of all) refreshStatus(j);
  console.log(renderJobTable(all));
  process.exit(0);
}

// ---------- subcommand: result ----------

// Confine log-file reads to the jobs directory. Job metadata is JSON we wrote
// ourselves, but the file can be tampered with on disk by anything that has
// write access to ${CLAUDE_PLUGIN_DATA}. Without confinement, a manipulated
// stdout_path could make /gemini:result read any user-readable file.
function safeJobLogPath(p) {
  if (typeof p !== "string" || !p) return null;
  const dir = path.resolve(jobsDir());
  const resolved = path.resolve(p);
  if (path.dirname(resolved) !== dir) return null;
  return resolved;
}

function cmdResult({ positional }) {
  const target = positional[0];
  let meta;
  if (target) {
    meta = readJobMeta(target);
    if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
    refreshStatus(meta);
  } else {
    const all = listJobs();
    for (const j of all) refreshStatus(j);
    const completed = all.filter(j => j.status !== "running");
    if (completed.length === 0) {
      console.log("No completed Gemini jobs in this workspace.");
      process.exit(0);
    }
    meta = completed[0];
  }
  console.log(`# Job ${meta.id}`);
  console.log(`Kind: ${meta.kind}${meta.write ? " (write)" : ""}`);
  console.log(`Status: ${meta.status}`);
  console.log(`Task: ${meta.task_text || "-"}`);
  console.log(`Started: ${fmtTime(meta.started_at)}${meta.ended_at ? `   Ended: ${fmtTime(meta.ended_at)}` : ""}`);
  if (meta.exit_code !== undefined) console.log(`Exit: ${meta.exit_code}`);
  console.log("\n## Output\n");
  const safeOut = safeJobLogPath(meta.stdout_path);
  if (!safeOut) {
    console.log("(stdout path is outside the jobs directory — refusing to read)");
  } else {
    try {
      const out = fs.readFileSync(safeOut, "utf8");
      process.stdout.write(out || "(no output)\n");
    } catch (e) {
      console.log(`(could not read stdout: ${e.message})`);
    }
  }
  if (meta.exit_code && meta.exit_code !== 0) {
    console.log("\n## Errors\n");
    const safeErr = safeJobLogPath(meta.stderr_path);
    if (safeErr) {
      try {
        const err = fs.readFileSync(safeErr, "utf8");
        process.stdout.write(err);
      } catch {}
    }
  }
  console.log(`\n---\nFollow-up: /gemini:status ${meta.id}`);
  process.exit(0);
}

// ---------- subcommand: cancel ----------

// Mark cancelled BEFORE the SIGTERM/SIGKILL escalation so the close handler
// in cmdReview/cmdTask sees `status: "cancelled"` and does not overwrite it
// with "failed" when the process exits non-zero. Then await the kill-tree
// promise so SIGKILL has a chance to fire — if we exited synchronously,
// the setTimeout for SIGKILL would be cleared by process.exit and a Gemini
// process that ignores SIGTERM would survive.
async function killJob(meta) {
  meta.status = "cancelled";
  meta.ended_at = new Date().toISOString();
  writeJobMeta(meta.id, meta);
  await terminateProcessTree(meta.pid);
}

async function cmdCancel({ positional }) {
  const target = positional[0];
  if (!target) {
    const running = listJobs().filter(j => j.status === "running" && isAlive(j.pid));
    if (running.length === 0) {
      console.log("No running Gemini jobs to cancel.");
      process.exit(0);
    }
    await Promise.all(running.map(j => killJob(j)));
    console.log(`Cancelled ${running.length} job(s).`);
    process.exit(0);
  }
  const meta = readJobMeta(target);
  if (!meta) { console.log(`No job ${target}.`); process.exit(1); }
  if (meta.status !== "running" || !isAlive(meta.pid)) {
    console.log(`Job ${meta.id} is not running (status: ${meta.status}). Nothing to cancel.`);
    process.exit(0);
  }
  await killJob(meta);
  console.log(`Cancelled ${meta.id}.`);
  process.exit(0);
}

// ---------- main ----------

function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub) {
    console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|task|status|result|cancel> [args...]");
    process.exit(2);
  }
  let args;
  try {
    args = parseArgs(rest, { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS });
  } catch (e) {
    if (e.code === "MISSING_VALUE") { console.error(e.message); process.exit(2); }
    throw e;
  }
  switch (sub) {
    case "setup": return cmdSetup(args);
    case "ask": return cmdAsk(args);
    case "review": return cmdReview(args, { adversarial: false });
    case "adversarial-review": return cmdReview(args, { adversarial: true });
    case "task": return cmdTask(args);
    case "status": return cmdStatus(args);
    case "result": return cmdResult(args);
    case "cancel": return cmdCancel(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|task|status|result|cancel> [args...]");
      process.exit(2);
  }
}

main();
