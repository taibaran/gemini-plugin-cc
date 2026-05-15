#!/usr/bin/env node
// Gemini Companion — slim dispatcher.
// Subcommands: setup | ask | review | adversarial-review | task | status | result | cancel
//
// Heavy lifting lives in scripts/lib/ — this file just routes.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { parseArgs, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS, parseDuration } from "./lib/args.mjs";
import {
  ensureDir, jobsDir, newJobId,
  writeJobMeta, readJobMeta, listJobs, pruneJobs,
  readConfig, setReviewGate, safeJobLogPath, purgeJobs, setActiveModel
} from "./lib/state.mjs";
import { isAlive, terminateProcessTree } from "./lib/process.mjs";
import { captureDiff } from "./lib/git.mjs";
import {
  which, geminiVersion, classifyAuthBlob,
  detectAuthSource, geminiBaseArgs, effectiveModel, DEFAULT_MODEL,
  cleanGeminiEnv, probeWithFallback, checkMinVersion, MIN_GEMINI_VERSION,
  MODEL_FALLBACK_CHAIN
} from "./lib/gemini.mjs";
import { buildReviewPrompt } from "./lib/prompts.mjs";
import { renderJobTable, renderJobDetails, fmtTime, TerminalSanitizer, sanitizeForTerminal } from "./lib/render.mjs";

// Conservative timeouts that protect against indefinite hangs without breaking
// realistic large-diff reviews. Override with `--timeout <duration>`, or pass
// `--timeout 0` to disable. Task has no default — rescue work is open-ended
// by design and the user can always /gemini:cancel a stuck job.
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;       // 5 min
const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;   // 20 min
// Task is normally unbounded — rescue work is open-ended by design. But the
// rescue subagent runs synchronously and would strand the parent agent if
// Gemini hangs. When GEMINI_RESCUE_MODE=1 is set in the env (the rescue
// agent / skill set this when invoking the Bash call), we apply a 15-min
// default. Belt-and-suspenders with the prompt-level rule in
// agents/gemini-rescue.md — if the subagent forgets to pass --timeout the
// runtime still enforces a deadline.
const DEFAULT_TASK_TIMEOUT_MS = process.env.GEMINI_RESCUE_MODE === "1"
  ? 15 * 60 * 1000  // 15 min
  : 0;              // unbounded for direct /gemini:task callers

// Node's setTimeout silently truncates delays exceeding 2^31-1 ms (~24.85d):
// instead of waiting that long, the timer fires at ~1ms and Node prints a
// TimeoutOverflowWarning. So `--timeout 30d` would wrap to "instantly" without
// this clamp. The wrapper passes the cap through to spawnSync's timeout too.
const MAX_SETTIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(rawFlag, defaultMs) {
  if (rawFlag === undefined) return defaultMs;
  const parsed = parseDuration(String(rawFlag));
  if (parsed === null) {
    console.error(`Invalid --timeout value: ${rawFlag}. Use forms like 300s, 20m, or 0 to disable.`);
    process.exit(2);
  }
  if (parsed > MAX_SETTIMEOUT_MS) {
    process.stderr.write(`[gemini-plugin] --timeout ${rawFlag} exceeds Node's max setTimeout delay (${MAX_SETTIMEOUT_MS} ms ≈ 24.85d). Clamping; pass --timeout 0 to disable instead.\n`);
    return MAX_SETTIMEOUT_MS;
  }
  return parsed;
}

// Hard cap on how much of the on-disk review log we will read into memory
// for JSON parsing. The disk log is uncapped (raw bytes kept for debugging),
// but JSON.parse on a multi-GB string would OOM the process.
const MAX_REVIEW_JSON_BYTES = 8 * 1024 * 1024;      // 8 MB

// Standard exit code for "command terminated by timeout" (matches GNU
// timeout(1)). Distinguishable from policy refusals (2) and missing-binary
// (127) so wrappers can tell timeouts apart from other failures.
const EXIT_TIMEOUT = 124;

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
    const rawVer = geminiVersion();
    result.gemini.detail = rawVer || "installed";
    const verCheck = checkMinVersion(rawVer);
    result.gemini.version_ok = verCheck.ok;
    if (!verCheck.ok) {
      result.gemini.version_warning = `${verCheck.reason}`;
      result.nextSteps.push(
        `Upgrade Gemini CLI: \`npm install -g @google/gemini-cli@latest\`. Plugin requires >= ${MIN_GEMINI_VERSION}; detected ${verCheck.current || "unknown"}.`
      );
    }
  } else {
    result.gemini.detail = "not installed";
    result.nextSteps.push("Install Gemini CLI: `npm install -g @google/gemini-cli`");
  }

  if (gemBin) {
    const probe = probeWithFallback();
    result.auth.available = probe.ok;
    result.auth.detail = probe.detail;
    // Only claim a specific source when auth actually works. Otherwise
    // detectAuthSource() returns "settings.json (oauth)" as a fallback,
    // which falsely implies oauth is configured when nothing is.
    result.auth.source = probe.ok ? detectAuthSource() : null;
    if (probe.fallbackUsed) {
      // Persist to workspace config so per-call invocations
      // (/gemini:ask, /gemini:review, /gemini:task, /gemini:rescue)
      // inherit the working model, not just setup's report. effectiveModel()
      // reads this back. --model and GEMINI_PLUGIN_MODEL still win over it.
      setActiveModel(process.cwd(), probe.fallbackUsed);
      result.model.active = probe.fallbackUsed;
      result.model.fallbackUsed = probe.fallbackUsed;
      result.actionsTaken.push(
        `Default model ${result.model.default} unavailable; persisting fallback ${probe.fallbackUsed} for this workspace. Future /gemini:* commands here will use it. Override with --model or GEMINI_PLUGIN_MODEL.`
      );
    } else if (probe.ok) {
      // Default worked — clear any stale fallback we persisted on a previous
      // run when the default was temporarily down.
      const cfg = readConfig(process.cwd());
      if (cfg.activeModel && cfg.activeModel !== result.model.default) {
        setActiveModel(process.cwd(), null);
        result.actionsTaken.push(
          `Default model ${result.model.default} is available again; cleared persisted fallback ${cfg.activeModel}.`
        );
      }
    }
    if (!probe.ok) {
      if (probe.detail === "model unavailable") {
        // Read the candidates from MODEL_FALLBACK_CHAIN so this stays in sync
        // when the chain changes; deduplicate against the default to avoid
        // listing the same id twice.
        const tried = [result.model.default, ...MODEL_FALLBACK_CHAIN.filter(m => m !== result.model.default)];
        result.nextSteps.push(
          `No fallback-chain model is available for this account. Tried: ${tried.join(", ")}. Override with --model or GEMINI_PLUGIN_MODEL.`
        );
      } else {
        result.nextSteps.push(
          "Authenticate Gemini. Either:\n  • Run `!gemini` once and complete the Google OAuth flow, OR\n  • Set GEMINI_API_KEY (free key from https://aistudio.google.com/app/apikey)."
        );
      }
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

async function cmdAsk({ flags, positional }) {
  const prompt = positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: ask <question>");
    process.exit(2);
  }
  // Validate input flags before checking environment availability — a
  // malformed --timeout is the user's typo and should be reported as such,
  // not masked behind a "gemini not installed" failure.
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_ASK_TIMEOUT_MS);
  if (!which("gemini")) {
    console.error("Gemini CLI not installed. Run `/gemini:setup`.");
    process.exit(127);
  }
  const args = ["-p", prompt, ...geminiBaseArgs({ readOnly: true, model: flags.model })];

  // Use async spawn + detached + terminateProcessTree so timeouts get the
  // same SIGTERM-group → SIGKILL-group escalation that review/task/stop-hook
  // use. The previous spawnSync({ timeout }) path could only SIGTERM the
  // direct child and never escalated to SIGKILL, leaving orphan descendants
  // and a non-killable Gemini surviving past the deadline.
  return new Promise(resolve => {
    const proc = spawn("gemini", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: cleanGeminiEnv()
    });

    let outBuf = "";
    let errBuf = "";
    let timedOut = false;
    let killPromise = null;
    const sanitizer = new TerminalSanitizer();
    // Resolves when proc closes — lets terminateProcessTree cancel its
    // SIGKILL grace timer early once the child has actually exited on
    // SIGTERM, instead of always waiting the full 2 s.
    let closedResolve;
    const closedPromise = new Promise(r => { closedResolve = r; });

    proc.stdout.on("data", d => {
      const safe = sanitizer.push(d);
      if (safe) process.stdout.write(safe);
      if (outBuf.length < MAX_JOB_BUF) {
        outBuf += d.toString().slice(0, MAX_JOB_BUF - outBuf.length);
      }
    });
    proc.stderr.on("data", d => {
      if (errBuf.length < MAX_JOB_BUF) {
        errBuf += d.toString().slice(0, MAX_JOB_BUF - errBuf.length);
      }
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        timedOut = true;
        // Emit the timeout message SYNCHRONOUSLY here, not in the close
        // handler. The close handler may take up to graceMs because it
        // awaits killPromise — leaving the user staring at a blank terminal
        // before any feedback. The old spawnSync({timeout}) path returned
        // ETIMEDOUT immediately; matching that UX requires the user-facing
        // message to fire now.
        process.stderr.write(`\n[gemini-plugin] ask timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 15m.\n`);
        killPromise = terminateProcessTree(proc.pid, { closedPromise }).catch(() => {});
      }, timeoutMs);
    }

    proc.on("close", async code => {
      if (timer) clearTimeout(timer);
      // Signal terminateProcessTree that the child has closed so it can
      // cancel its grace timer instead of waiting the full graceMs.
      closedResolve();
      // Await the kill sequence so the inner SIGKILL has a chance to fire
      // before process.exit cancels it. Without this await, a Gemini child
      // that ignores SIGTERM would survive past `ask` returning. With the
      // closedPromise wiring above, this typically returns almost
      // immediately when the child cooperated with SIGTERM.
      if (killPromise) await killPromise;
      const tail = sanitizer.flush();
      if (tail) process.stdout.write(tail);
      if (timedOut) {
        if (errBuf) process.stderr.write(sanitizeForTerminal(errBuf));
        // Message already emitted from the timer callback; just exit.
        resolve();
        process.exit(EXIT_TIMEOUT);
      }
      if (code !== 0) {
        if (errBuf) process.stderr.write(sanitizeForTerminal(errBuf));
        const why = classifyAuthBlob(outBuf + "\n" + errBuf);
        if (why) process.stderr.write(`\n[hint: ${why}. Run /gemini:setup.]\n`);
      }
      resolve();
      process.exit(code ?? 0);
    });

    proc.on("error", err => {
      if (timer) clearTimeout(timer);
      process.stderr.write(`Failed to spawn gemini: ${err.message}\n`);
      resolve();
      process.exit(127);
    });
  });
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
function runJob({ args, meta, stdin = null, showStdout = true, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    ensureDir(jobsDir());
    const stdoutFd = fs.openSync(meta.stdout_path, "w");
    const stderrFd = fs.openSync(meta.stderr_path, "w");

    const stdio = stdin !== null
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];

    const proc = spawn("gemini", args, { stdio, detached: true, env: cleanGeminiEnv() });
    meta.pid = proc.pid;
    if (timeoutMs > 0) meta.timeout_ms = timeoutMs;
    writeJobMeta(meta.id, meta);
    pruneJobs();

    if (stdin !== null) {
      // Without an error handler, an EPIPE that occurs when Gemini exits
      // before reading the stdin payload (auth fail / model unavailable /
      // crash) becomes an unhandled stream error and tears down the whole
      // companion process. The close handler will still see the non-zero
      // exit code and surface the real reason via classifyAuthBlob.
      proc.stdin.on("error", () => {});
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    let outBuf = "", errBuf = "";
    const sanitizer = new TerminalSanitizer();

    let timedOut = false;
    let timeoutTimer = null;
    // Hold the kill Promise so the close handler can await it before
    // exiting. Without this, process.exit cancels the pending SIGKILL
    // timer inside terminateProcessTree and SIGTERM-ignoring descendants
    // survive past the supposed cleanup. Same pattern stop-hook uses.
    let killPromise = null;
    // Resolves on proc close — gives terminateProcessTree a way to skip
    // the full graceMs wait when the child has already exited cleanly.
    let closedResolve;
    const closedPromise = new Promise(r => { closedResolve = r; });
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        // The process may have exited cleanly between when the timer was
        // queued and when this callback runs. clearTimeout is called inside
        // proc.on('close'), but if both events land in the same event-loop
        // turn the timer can fire microseconds before the close handler
        // gets a chance to cancel it. Skipping when the child has already
        // exited prevents mislabeling a successful run as `timed-out`.
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        timedOut = true;
        // Mirror killJob's pattern: write status BEFORE termination so the
        // close handler sees `timed-out` and does not race-overwrite it
        // with `failed` when SIGTERM'd Gemini exits non-zero.
        meta.status = "timed-out";
        meta.ended_at = new Date().toISOString();
        try { writeJobMeta(meta.id, meta); } catch {}
        killPromise = terminateProcessTree(proc.pid, { closedPromise }).catch(() => {});
      }, timeoutMs);
    }

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

    proc.on("close", async code => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Signal terminateProcessTree's closedPromise so it can cancel its
      // SIGKILL grace timer rather than waiting the full graceMs.
      closedResolve();
      // Await SIGKILL escalation BEFORE closing fds / emitting status so
      // that any descendants the leader spawned get fully cleaned up.
      // Same async-close pattern stop-hook and cmdAsk use.
      if (killPromise) await killPromise;
      try { fs.closeSync(stdoutFd); } catch {}
      try { fs.closeSync(stderrFd); } catch {}
      if (showStdout) {
        const tail = sanitizer.flush();
        if (tail) process.stdout.write(tail);
      }

      // killJob (cmdCancel) and the timeout timer both write a sticky status
      // BEFORE this close fires, so re-read meta from disk to avoid
      // race-overwriting "cancelled" or "timed-out" with "failed" when
      // a SIGTERM'd Gemini exits non-zero.
      const current = readJobMeta(meta.id) || meta;
      if (current.status === "cancelled" || current.status === "timed-out") {
        current.exit_code = code;
        writeJobMeta(meta.id, current);
        meta.status = current.status;
      } else {
        meta.status = code === 0 ? "completed" : "failed";
        meta.exit_code = code;
        meta.ended_at = new Date().toISOString();
        writeJobMeta(meta.id, meta);
      }

      if (timedOut) {
        process.stderr.write(`\n[gemini-plugin] Job ${meta.id} timed out after ${timeoutMs}ms. Re-run with --timeout 0 to disable, or pick a longer duration like --timeout 30m.\n`);
      } else if (code !== 0 && meta.status !== "cancelled") {
        if (errBuf) process.stderr.write(sanitizeForTerminal(errBuf));
        const why = classifyAuthBlob(outBuf + "\n" + errBuf);
        if (why) process.stderr.write(`\n[hint: ${why}. Run /gemini:setup.]\n`);
        // Silent-failure diagnostic. Without this, a non-zero exit with empty
        // stdout/stderr AND no auth-blob match used to surface zero output —
        // the user saw a failed job they couldn't debug, and a rescue parent
        // would see "no output" with no clue why. Surface a structured marker
        // so the user knows the process ran, died with no I/O, and where to
        // look. Issue #3's "0-byte log file" failure mode.
        if (!errBuf && !outBuf && !why) {
          process.stderr.write(
            `\n[gemini-plugin] Job ${meta.id} exited ${code} with no stdout/stderr. ` +
            `Likely causes: SIGKILL before any I/O, immediate crash, auth/connectivity ` +
            `error not matched by the classifier, or sandbox restriction. ` +
            `Inspect: /gemini:result ${meta.id}\n`
          );
        }
      }

      resolve({ code, outBuf, errBuf, timedOut });
    });

    proc.on("error", err => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
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
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_REVIEW_TIMEOUT_MS);

  const meta = buildJobMeta({
    kind: adversarial ? "adversarial-review" : "review",
    args,
    task_text: `${target}${focus ? ` — focus: ${focus}` : ""}`,
    extra: { json_output: jsonOutput, model: flags.model || null }
  });

  let result;
  try {
    result = await runJob({ args, meta, stdin: diffResult.diff, showStdout: !jsonOutput, timeoutMs });
  } catch (err) {
    console.error(`Failed to spawn gemini: ${err.message}`);
    process.exit(127);
  }

  if (result.timedOut) process.exit(EXIT_TIMEOUT);

  if (result.code === 0 && jsonOutput) {
    // Gemini's `-o json` returns: { session_id, response, stats }. Strip the
    // wrapper, strip markdown fences, validate shallow shape, emit clean JSON.
    // We re-read the full stdout file from disk because runJob's outBuf is
    // capped at MAX_JOB_BUF — a JSON payload near that cap would corrupt the
    // parse otherwise. The on-disk file has no cap, so size-check first to
    // avoid OOMing on a runaway response.
    let fullOut;
    let stat;
    try { stat = fs.statSync(meta.stdout_path); } catch {}
    if (stat && stat.size > MAX_REVIEW_JSON_BYTES) {
      // Truncating a JSON payload guarantees JSON.parse fails, and the
      // 256 KB outBuf is itself a truncated prefix of the real response.
      // Emitting it as a "successful review" with exit 0 would mislead
      // downstream consumers into trusting partial data. Refuse explicitly
      // so the caller can branch; the full bytes remain on disk.
      process.stderr.write(
        `[gemini-plugin] review --json: output is ${stat.size} bytes, > ${MAX_REVIEW_JSON_BYTES} cap. Refusing to parse a truncated payload.\n` +
        `Full output preserved at ${meta.stdout_path} (also reachable via /gemini:result ${meta.id}).\n`
      );
      process.exit(1);
    }
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

  // The write-mode gate runs BEFORE the gemini-installed check intentionally:
  // the gate is a policy decision about the local environment, not about
  // whether Gemini is reachable. If we deferred the gate until after `which`
  // succeeded, a CI runner without gemini would mask this refusal with a
  // generic "not installed" error — and worse, a real user would see
  // contradictory feedback ("install gemini... oh wait, refused for safety").
  // Refusing first means the user always sees the policy reason.
  const isWrite = !!flags.write && !flags["read-only"];
  if (isWrite && process.env.GEMINI_PLUGIN_ALLOW_WRITE !== "1") {
    // Hardening: --write puts Gemini in --approval-mode yolo, which means it
    // can modify files in this workspace without further confirmation. The
    // env-var gate forces the user to make an explicit, durable decision
    // before granting that authority. Defense-in-depth — also surfaces the
    // risk in the error message rather than silently letting yolo through.
    console.error("--write refused: GEMINI_PLUGIN_ALLOW_WRITE is not set to 1.");
    console.error("");
    console.error("--write puts Gemini in approval-mode=yolo, which lets it modify files");
    console.error("in this workspace without per-action confirmation. Only enable in a");
    console.error("workspace where you already trust running an unattended agent.");
    console.error("");
    console.error("To enable for this session:    export GEMINI_PLUGIN_ALLOW_WRITE=1");
    console.error("To enable persistently:        add it to ~/.claude/settings.json env.");
    process.exit(2);
  }

  // Validate the timeout flag before binary discovery — a typo is a user
  // error and should be reported as such, not masked by "not installed".
  // The write-gate above still fires first by design (policy > config).
  const timeoutMs = resolveTimeoutMs(flags.timeout, DEFAULT_TASK_TIMEOUT_MS);

  if (!which("gemini")) {
    console.error("Gemini CLI not installed. Run `/gemini:setup`.");
    process.exit(127);
  }

  if (isWrite) {
    process.stderr.write("[gemini-plugin] WRITE MODE ACTIVE — Gemini may modify files in this workspace.\n");
  }
  const args = ["-p", taskText, ...geminiBaseArgs({ readOnly: !isWrite, model: flags.model })];
  const meta = buildJobMeta({
    kind: "task",
    args,
    task_text: taskText,
    extra: { write: isWrite, model: flags.model || null }
  });

  let result;
  try {
    result = await runJob({ args, meta, stdin: null, showStdout: true, timeoutMs });
  } catch (err) {
    console.error(`Failed to spawn gemini: ${err.message}`);
    process.exit(127);
  }

  process.stdout.write(`\n\n[gemini-plugin] Job ${meta.id} ${meta.status} (exit ${result.code}).\n`);
  process.stdout.write(`[gemini-plugin] /gemini:result ${meta.id}\n`);
  if (result.timedOut) process.exit(EXIT_TIMEOUT);
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

// ---------- subcommand: purge ----------

function cmdPurge({ flags }) {
  const ageRaw = flags["older-than"] || null;
  const maxAgeMs = ageRaw ? parseDuration(ageRaw) : null;
  if (ageRaw && !maxAgeMs) {
    console.error(`Invalid --older-than value: ${ageRaw}. Use forms like 30d, 12h, 45m, 60s.`);
    process.exit(2);
  }
  const purged = purgeJobs({ maxAgeMs });
  if (maxAgeMs) {
    console.log(`Purged ${purged} job(s) older than ${ageRaw}.`);
  } else {
    console.log(`Purged ${purged} job(s).`);
  }
  process.exit(0);
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
    console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|task|status|result|cancel|purge> [args...]");
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
    case "ask": return await cmdAsk(args);
    case "review": return await cmdReview(args, { adversarial: false });
    case "adversarial-review": return await cmdReview(args, { adversarial: true });
    case "task": return await cmdTask(args);
    case "status": return cmdStatus(args);
    case "result": return cmdResult(args);
    case "cancel": return await cmdCancel(args);
    case "purge": return cmdPurge(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.error("Usage: companion.mjs <setup|ask|review|adversarial-review|task|status|result|cancel|purge> [args...]");
      process.exit(2);
  }
}

main().catch(err => {
  console.error(`gemini-plugin fatal: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
