// Gemini CLI wrapper — version detection, auth probing, and arg construction.

import { spawnSync } from "node:child_process";

export const AUTH_PROBE_TIMEOUT_MS = 30_000;

// The strongest publicly available Gemini Pro model as of 2026-04. Pinning
// the plugin to this id (rather than letting the CLI's rotating default
// pick) keeps results consistent even if Google flips the default. Override
// per-call with --model, or globally via GEMINI_PLUGIN_MODEL env var.
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";

export function effectiveModel(callerModel) {
  if (callerModel) return callerModel;
  if (process.env.GEMINI_PLUGIN_MODEL) return process.env.GEMINI_PLUGIN_MODEL;
  return DEFAULT_MODEL;
}

export function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function geminiVersion() {
  const r = spawnSync("gemini", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function classifyAuthBlob(blob) {
  if (/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|set an Auth method/i.test(blob)) {
    return "no auth method configured";
  }
  if (/quota|RESOURCE_EXHAUSTED/i.test(blob)) return "quota exhausted";
  if (/permission|forbidden|403/i.test(blob)) return "auth rejected (403)";
  return null;
}

export function detectAuthSource() {
  if (process.env.GEMINI_API_KEY) return "GEMINI_API_KEY env";
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI) return "Vertex AI";
  if (process.env.GOOGLE_GENAI_USE_GCA) return "GCA";
  return "settings.json (oauth)";
}

export function authProbe() {
  const r = spawnSync(
    "gemini",
    [
      "-p", "Reply with exactly the word: OK",
      "--skip-trust",
      "--approval-mode", "plan",
      "-o", "text",
      "--model", effectiveModel()
    ],
    { encoding: "utf8", timeout: AUTH_PROBE_TIMEOUT_MS }
  );
  const blob = (r.stdout || "") + "\n" + (r.stderr || "");
  if (r.status === 0 && /\bOK\b/i.test(r.stdout || "")) {
    return { ok: true, detail: "responsive" };
  }
  if (r.error?.code === "ETIMEDOUT") {
    return { ok: false, detail: "auth probe timed out" };
  }
  const why = classifyAuthBlob(blob);
  return { ok: false, detail: why || "probe failed", raw: blob.slice(0, 400) };
}

export function geminiBaseArgs({ readOnly = true, model, jsonOutput = false } = {}) {
  const args = [
    "--skip-trust",
    "--approval-mode", readOnly ? "plan" : "yolo",
    "-o", jsonOutput ? "json" : "text",
    "--model", effectiveModel(model)
  ];
  return args;
}
