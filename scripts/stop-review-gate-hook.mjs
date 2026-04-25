#!/usr/bin/env node
// Stop-time review gate for Gemini Companion.
//
// Activated only when /gemini:setup --enable-review-gate has been run for
// the workspace identified by the hook's `cwd` field. On Stop, it asks
// Gemini whether the previous Claude turn actually shipped code changes
// and, if so, whether they should ship.
//
// Returns hook JSON in Claude Code's Stop-hook format:
//   (no output / empty)              → allow stop (default)
//   { "decision": "block", "reason": "..." } → block stop; reason shown to model
//
// Failure modes (gemini missing, auth missing, parse error, timeout) all
// fall through as "allow" — the review gate is a soft suggestion gate, not
// a CI blocker. A broken Gemini install must not strand the user.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { readConfig } from "./lib/state.mjs";
import { which, classifyAuthBlob, geminiBaseArgs } from "./lib/gemini.mjs";
import { captureDiff } from "./lib/git.mjs";
import { buildStopGatePrompt } from "./lib/prompts.mjs";

const HOOK_TIMEOUT_MS = 12 * 60 * 1000;

function emitAllow(reason = "") {
  if (reason) {
    process.stdout.write(JSON.stringify({ systemMessage: `gemini-plugin: ${reason}` }) + "\n");
  }
  process.exit(0);
}

function emitBlock(reason) {
  // Stop-hook block contract: { decision: "block", reason: "<text>" }.
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

// Find the end-index of the first balanced JSON object starting at `start`,
// taking string boundaries into account. Without string-awareness, a `}`
// inside a `reason` value (e.g. "closes block}") causes a premature match
// and fail-open in the caller.
function findBalancedJsonEnd(s, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Extract the first JSON object from Gemini's output and validate it has
// our expected shape. Returns null if the output is not parseable as our
// verdict format — caller treats that as fail-open "allow".
function parseVerdict(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Allow Gemini to wrap in ```json fences even though we asked it not to.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  const end = findBalancedJsonEnd(candidate, start);
  if (end < 0) return null;
  let parsed;
  try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.decision !== "allow" && parsed.decision !== "block") return null;
  return {
    decision: parsed.decision,
    reason: typeof parsed.reason === "string" ? parsed.reason : ""
  };
}

function readStdinSync() {
  // Synchronously read all of fd 0. Claude Code closes stdin after writing
  // the hook input JSON, so this returns promptly on EOF.
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveHookCwd(hookInput) {
  try {
    const parsed = JSON.parse(hookInput || "{}");
    if (typeof parsed.cwd === "string" && parsed.cwd) return parsed.cwd;
  } catch {}
  return process.cwd();
}

function extractClaudeResponse(hookInput) {
  try {
    const parsed = JSON.parse(hookInput || "{}");
    return parsed.last_message || parsed.transcript_snippet || "";
  } catch {
    return "";
  }
}

function main() {
  const hookInput = readStdinSync();
  const cwd = resolveHookCwd(hookInput);

  const cfg = readConfig(cwd);
  if (!cfg.reviewGateEnabled) {
    emitAllow();
  }
  if (!which("gemini")) {
    emitAllow("gemini not installed — review gate skipped");
  }

  const claudeResponse = extractClaudeResponse(hookInput);

  const diffResult = captureDiff({ scope: "auto", cwd });
  if (!diffResult.diff || !diffResult.diff.trim()) {
    emitAllow("no code changes detected in last turn");
  }

  const prompt = buildStopGatePrompt({ claudeResponse });

  let outBuf = "";
  let errBuf = "";
  let timedOut = false;

  const proc = spawn("gemini", ["-p", prompt, ...geminiBaseArgs({ readOnly: true })], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd
  });

  proc.stdin.write(diffResult.diff);
  proc.stdin.end();

  proc.stdout.on("data", d => { outBuf += d.toString(); });
  proc.stderr.on("data", d => { errBuf += d.toString(); });

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGTERM"); } catch {}
  }, HOOK_TIMEOUT_MS);

  proc.on("close", code => {
    clearTimeout(timer);
    if (timedOut) {
      emitAllow("review gate timed out — allowed");
    }
    const why = classifyAuthBlob(outBuf + "\n" + errBuf);
    if (why) {
      emitAllow(`review gate skipped (${why})`);
    }
    if (code !== 0) {
      emitAllow(`review gate skipped (gemini exit ${code})`);
    }
    // Parse the verdict as strict JSON, not as a free-form first line. This
    // closes a prompt-injection bypass where a malicious diff could ask
    // Gemini to emit `ALLOW` / `BLOCK` directly. The model is now required
    // to produce a structured verdict JSON; anything else is "unparseable".
    const verdict = parseVerdict(outBuf);
    if (!verdict) {
      emitAllow(`review gate verdict unparseable — allowed (raw: ${(outBuf || "").trim().slice(0, 80)})`);
    }
    if (verdict.decision === "block") {
      emitBlock(`Gemini review gate blocked stop: ${verdict.reason || "(no reason supplied)"}`);
    }
    emitAllow(verdict.reason || "review gate allowed");
  });

  proc.on("error", err => {
    clearTimeout(timer);
    emitAllow(`review gate error: ${err.message}`);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`stop-review-gate-hook fatal: ${err.message}\n`);
  emitAllow("review gate fatal error");
}
