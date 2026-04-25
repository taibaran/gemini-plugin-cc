// Argument parsing for the Gemini companion.
// Mirrors codex-plugin-cc's args.mjs in shape, plus shell-style splitting for
// $ARGUMENTS forwarded as a single quoted string.

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  let inToken = false;
  for (const ch of raw) {
    if (escaping) { current += ch; escaping = false; inToken = true; continue; }
    if (ch === "\\") { escaping = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ""; inToken = false; }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (escaping) current += "\\";
  if (inToken) tokens.push(current);
  return tokens;
}

export function tokenize(argv) {
  // Claude Code typically forwards $ARGUMENTS as a single string. If we got
  // exactly one positional that contains spaces or quote chars, split it shell-style.
  if (argv.length === 1 && /[\s"']/.test(argv[0])) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

export function parseArgs(argv, { boolFlags = new Set(), valueFlags = new Set() } = {}) {
  const tokens = tokenize(argv);
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) { positional.push(t); continue; }
    const [rawKey, inline] = t.slice(2).split("=", 2);
    if (boolFlags.has(rawKey)) {
      flags[rawKey] = inline === undefined ? true : inline !== "false";
      continue;
    }
    if (valueFlags.has(rawKey)) {
      const v = inline ?? tokens[i + 1];
      if (v === undefined) {
        const err = new Error(`Missing value for --${rawKey}`);
        err.code = "MISSING_VALUE";
        throw err;
      }
      flags[rawKey] = v;
      if (inline === undefined) i++;
      continue;
    }
    // Unknown flag — keep as positional for downstream handling.
    positional.push(t);
  }
  return { flags, positional };
}

export const COMMON_BOOL_FLAGS = new Set([
  "json", "wait", "background", "all", "write", "read-only",
  "resume", "fresh", "resume-last",
  "enable-review-gate", "disable-review-gate"
]);

export const COMMON_VALUE_FLAGS = new Set([
  "base", "scope", "model"
]);
