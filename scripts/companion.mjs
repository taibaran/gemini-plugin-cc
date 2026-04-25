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
import { renderJobTable, renderJobDetails, fmtTime, TerminalSanitizer, sanitizeForTerminal } from "./lib/render.mjs";

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
  process.stdout.write(sanitizeForTerminal(r.stdout || ""));
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(sanitizeForTerminal(r.stderr));
    const why = classifyAuthBlob((r.stdout || "") + "\n" + (r.stderr || ""));
    if (why) process.stderr.write(`\n[hint: ${why}. Run /gemini:setup.]\n`);
  }
  process.exit(r.status ?? 0);
}

// ---------- shared job runner ----------

const MAX_JOB_BUF = 256 * 1024;

// Spawn `gemini`, stream output to a job log on disk (and optionally to the
// user's stdout, sanitized), and resolve when the process closes. Used by
// both cmdReview and cmdTask so process-group handling, buffer caps, status
// transitions, and error surfacing live in exactly one place.
//
// Caller fills `meta` with id/kind/task_text/etc. and the stdout_path /
// stderr_path under jobsDir(). This function fills in pid, status,
// ended_at, exit_code, and persists meta on every transition.
function runJob({ args, meta, stdin = null, showStdout = true }) {
  return new Promise((resolve, reject) => {
    ensureDir(jobsDir());
    const stdoutFd = fs.openSync(meta.stdout_path, "w");
    const stderrFd = fs.openSync(meta.stderr_path, "w");

    const stdio = stdin !== null
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];

    const proc = spawn("gemini", args, { stdio, detached: true });
    meta.pid = proc.pid;
    writeJobMeta(meta.id, meta);
    pruneJobs();

    if (stdin !== null) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    let outBuf = "", errBuf = "";
    const sanitizer = new TerminalSanitizer();

    proc.stdout.on("data", d => {
      fs.writeSync(stdoutFd, d);
      if (showStdout) {
        const safe = sanitizer.push(d);
        if (safe) process.stdout.write(safe);
      }
      if (outBuf.length < MAX_JOB_BUF) {
        outBuf += d.toString().slice(0, MAX_JOB_BUF - outBuf.length);
      }
    });
    proc.stderr.on("data", d => {
      fs.writeSync(stderrFd, d);
      if (errBuf.length < MAX_JOB_BUF) {
        errBuf += d.toString().slice(0, MAX_JOB_BUF - errBuf.length);
      }
    });

    proc.on("close", code => {
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      if (showStdout) {
        const tail = sanitizer.flush();
        if (tail) process.stdout.write(tail);
      }

      // killJob (cmdCancel) writes status: cancelled BEFORE this close fires,
      // so re-read meta from disk to avoid race-overwriting "cancelled" with
      // "failed" when a SIGTERM'd Gemini exits non-zero.
      const current = readJobMeta(meta.id) || meta;
      if (current.status === "cancelled") {
        current.exit_code = code;
        writeJobMeta(meta.id, current);
        meta.status = "cancelled";
      } else {
        meta.status = code === 0 ? "completed" : "failed";
        meta.exit_code = code;
        meta.ended_at = new Date().toISOString();
        writeJobMeta(meta.id, meta);
      }

      if (code !== 0 && meta.status !== "cancelled") {
        if (errBuf) process.stderr.write(sanitizeForTerminal(errBuf));
        const why = classifyAuthBlob(outBuf + "\n" + errBuf);
        if (why) process.stderr.write(`\n[hint: ${why}. Run /gemini:setup.]\n`);
      }

      resolve({ code, outBuf, errBuf });
    });

    proc.on("error", err => {
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      meta.status = "failed";
      meta.exit_code = -1;
      meta.error = err.message;
      meta.ended_at = new Date().toISOString();
      writeJobMeta(meta.id, meta);
      reject(err);
    });
  });
}

function buildJobMeta({ kind, args, task_text, extra = {} }) {
  const id = newJobId();
  const dir = jobsDir();
  return {
    version: 1,
    id,
    kind,
    pid: null,
    command: ["gemini", ...args],
    started_at: new Date().toISOString(),
    status: "running",
    stdout_path: path.join(dir, `${id}.stdout.log`),
    stderr_path: path.join(dir, `${id}.stderr.log`),
    task_text,
    ...extra
  };
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

async function cmdReview({ flags, positional }, { adversarial }) {
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

  const meta = buildJobMeta({
    kind: adversarial ? "adversarial-review" : "review",
    args,
    task_text: `${target}${focus ? ` — focus: ${focus}` : ""}`,
    extra: { json_output: jsonOutput, model: flags.model || null }
  });

  let result;
  try {
    result = await runJob({ args, meta, stdin: diffResult.diff, showStdout: !jsonOutput });
  } catch (err) {
    console.error(`Failed to spawn gemini: ${err.message}`);
    process.exit(127);
  }

  if (result.code === 0 && jsonOutput) {
    // Gemini's `-o json` returns: { session_id, response, stats }. Strip the
    // wrapper, strip markdown fences, validate shallow shape, emit clean JSON.
    // We re-read the full stdout file from disk because runJob's outBuf is
    // capped at MAX_JOB_BUF — a JSON payload near that cap would corrupt the
    // parse otherwise. The on-disk file has no cap.
    let fullOut;
    try { fullOut = fs.readFileSync(meta.stdout_path, "utf8"); } catch { fullOut = result.outBuf; }
    try {
      const wrapper = JSON.parse(fullOut);
      let inner = (wrapper.response ?? "").trim();
      const fenced = inner.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (fenced) inner = fenced[1].trim();
      const parsed = JSON.parse(inner);
      const why = validateReviewSchemaShallow(parsed);
      if (why) {
        // Schema mismatch: emit the unwrapped payload anyway (the wrapper is
        // never what a downstream JSON consumer wants), with a stderr warning.
        process.stderr.write(`[gemini-plugin] review --json: schema mismatch (${why}). Returning unwrapped payload.\n`);
      }
      process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
    } catch {
      process.stdout.write(fullOut);
    }
  }

  process.exit(result.code ?? 0);
}

// ---------- subcommand: task ----------

async function cmdTask({ flags, positional }) {
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
  const args = ["-p", taskText, ...geminiBaseArgs({ readOnly: !isWrite, model: flags.model })];
  const meta = buildJobMeta({
    kind: "task",
    args,
    task_text: taskText,
    extra: { write: isWrite, model: flags.model || null }
  });

  let result;
  try {
    result = await runJob({ args, meta, stdin: null, showStdout: true });
  } catch (err) {
    console.error(`Failed to spawn gemini: ${err.message}`);
    process.exit(127);
  }

  process.stdout.write(`\n\n[gemini-plugin] Job ${meta.id} ${meta.status} (exit ${result.code}).\n`);
  process.stdout.write(`[gemini-plugin] /gemini:result ${meta.id}\n`);
  process.exit(result.code ?? 0);
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
      process.stdout.write(sanitizeForTerminal(out || "(no output)\n"));
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
        process.stdout.write(sanitizeForTerminal(err));
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

async function main() {
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
    case "review": return await cmdReview(args, { adversarial: false });
    case "adversarial-review": return await cmdReview(args, { adversarial: true });
    case "task": return await cmdTask(args);
    case "status": return cmdStatus(args);
    case "result": return cmdResult(args);
    case "cancel": return await cmdCancel(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|task|status|result|cancel> [args...]");
      process.exit(2);
  }
}

main().catch(err => {
  console.error(`gemini-plugin fatal: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
