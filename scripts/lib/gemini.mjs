// Gemini CLI wrapper — version detection, auth probing, arg construction,
// and a curated environment for the spawned `gemini` process.

import { spawnSync } from "node:child_process";

export const AUTH_PROBE_TIMEOUT_MS = 30_000;

// Defense-in-depth: the `gemini` binary inherits this Node process's full
// environment by default, which inside Claude Code includes ANTHROPIC_API_KEY,
// GITHUB_TOKEN, AWS_*, SSH_AUTH_SOCK, and anything else the user has exported.
// A compromised gemini binary (supply-chain attack on @google/gemini-cli or a
// malicious dep) would exfiltrate every secret. cleanGeminiEnv() returns an
// allowlisted subset that is sufficient for gemini to function — auth, locale,
// terminal, proxy — and nothing else. Adding to the allowlist requires an
// explicit reason in the diff.
const ALLOWED_ENV_KEYS = new Set([
  // Process basics
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  // Terminal
  "TERM", "COLORTERM", "TERM_PROGRAM", "NO_COLOR", "FORCE_COLOR",
  // Temp dirs
  "TMPDIR", "TMP", "TEMP",
  // XDG base dirs (gemini stores state under these)
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Gemini / Google auth
  "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT", "VERTEXAI_PROJECT", "VERTEXAI_LOCATION",
  // Proxy (corporate networks)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy"
]);
// LC_* covers all locale category overrides (LC_NUMERIC, LC_TIME, etc.).
const ALLOWED_PREFIXES = ["LC_"];

export function cleanGeminiEnv(parent = process.env) {
  const out = Object.create(null);
  for (const k of Object.keys(parent)) {
    const v = parent[k];
    if (typeof v !== "string") continue;
    if (ALLOWED_ENV_KEYS.has(k) || ALLOWED_PREFIXES.some(p => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

// The strongest publicly available Gemini Pro model as of 2026-04. Pinning
// the plugin to this id (rather than letting the CLI's rotating default
// pick) keeps results consistent even if Google flips the default. Override
// per-call with --model, or globally via GEMINI_PLUGIN_MODEL env var.
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";

// Fallback chain: tried in order if the default is unavailable for the
// caller's account (rollout, region, quota). A previewing model in tier 1
// may not be enabled for every account; tier 3 is the broadly-available
// floor. Used by setup-time probing only, not by per-call invocations
// (those still use the user's selected model and surface the error).
export const MODEL_FALLBACK_CHAIN = [
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-2.5-pro"
];

// Minimum @google/gemini-cli version we have actually validated. Older
// versions may not support `--approval-mode plan` or our flag set.
export const MIN_GEMINI_VERSION = "0.30.0";

export function effectiveModel(callerModel) {
  if (callerModel) return callerModel;
  if (process.env.GEMINI_PLUGIN_MODEL) return process.env.GEMINI_PLUGIN_MODEL;
  return DEFAULT_MODEL;
}

// Compare two semver-like strings ("0.39.1" vs "0.30.0"). Returns -1 / 0 / 1.
// Tolerates trailing labels ("0.39.1-rc.2" → numeric core only).
export function compareVersions(a, b) {
  const parse = s => String(s || "0.0.0").match(/(\d+)\.(\d+)\.(\d+)/) || [];
  const pa = parse(a), pb = parse(b);
  for (let i = 1; i <= 3; i++) {
    const ai = parseInt(pa[i] || "0", 10);
    const bi = parseInt(pb[i] || "0", 10);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function checkMinVersion(currentRaw) {
  const current = (currentRaw || "").trim();
  const m = current.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { ok: false, reason: "could not parse version", current };
  const cleaned = m[0];
  if (compareVersions(cleaned, MIN_GEMINI_VERSION) < 0) {
    return { ok: false, reason: `installed ${cleaned} < required ${MIN_GEMINI_VERSION}`, current: cleaned };
  }
  return { ok: true, current: cleaned };
}

export function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function geminiVersion() {
  const r = spawnSync("gemini", ["--version"], { encoding: "utf8", env: cleanGeminiEnv() });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function classifyAuthBlob(blob) {
  if (/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|set an Auth method/i.test(blob)) {
    return "no auth method configured";
  }
  if (/quota|RESOURCE_EXHAUSTED/i.test(blob)) return "quota exhausted";
  if (/permission|forbidden|403/i.test(blob)) return "auth rejected (403)";
  if (/ModelNotFoundError|model.*not.*found|model.*not.*available|invalid.*model/i.test(blob)) return "model unavailable";
  return null;
}

export function detectAuthSource() {
  if (process.env.GEMINI_API_KEY) return "GEMINI_API_KEY env";
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI) return "Vertex AI";
  if (process.env.GOOGLE_GENAI_USE_GCA) return "GCA";
  return "settings.json (oauth)";
}

export function authProbe(model) {
  const r = spawnSync(
    "gemini",
    [
      "-p", "Reply with exactly the word: OK",
      "--skip-trust",
      "--approval-mode", "plan",
      "-o", "text",
      "--model", model || effectiveModel()
    ],
    { encoding: "utf8", timeout: AUTH_PROBE_TIMEOUT_MS, env: cleanGeminiEnv() }
  );
  const blob = (r.stdout || "") + "\n" + (r.stderr || "");
  if (r.status === 0 && /\bOK\b/i.test(r.stdout || "")) {
    return { ok: true, detail: "responsive", model: model || effectiveModel() };
  }
  if (r.error?.code === "ETIMEDOUT") {
    return { ok: false, detail: "auth probe timed out", model: model || effectiveModel() };
  }
  const why = classifyAuthBlob(blob);
  return { ok: false, detail: why || "probe failed", raw: blob.slice(0, 400), model: model || effectiveModel() };
}

// Try the configured model; on "model unavailable", walk the fallback chain.
// Returns { ok, model, detail, fallbackUsed }. Only considers fallback when
// the user has not pinned a specific model via --model or GEMINI_PLUGIN_MODEL —
// honoring an explicit override is a stronger signal than the chain.
export function probeWithFallback() {
  const userPinned = !!process.env.GEMINI_PLUGIN_MODEL;
  const first = authProbe();
  if (first.ok) return { ...first, fallbackUsed: null };
  if (userPinned) return { ...first, fallbackUsed: null };
  if (first.detail !== "model unavailable") return { ...first, fallbackUsed: null };
  for (const candidate of MODEL_FALLBACK_CHAIN) {
    if (candidate === first.model) continue;
    const r = authProbe(candidate);
    if (r.ok) return { ...r, fallbackUsed: candidate };
  }
  return { ...first, fallbackUsed: null };
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
