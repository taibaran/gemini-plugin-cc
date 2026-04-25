// Output rendering helpers for status and result.

export function fmtTime(s) {
  return s ? s.replace("T", " ").replace(/\..*/, "") : "-";
}

// --- Terminal-output sanitization -------------------------------------------
//
// Gemini's stdout is forwarded to the user's terminal. Without sanitization, a
// hostile diff or document fed into Gemini could trick it into emitting ANSI
// escape sequences (color, cursor moves, OSC title-bar updates, OSC 52 clipboard
// writes), or other C0 control bytes that interfere with the terminal. The disk
// logs keep the raw bytes for debugging — only the live stream is filtered.
//
// We strip:
//   - CSI sequences:  ESC [ ... <final byte 0x40-0x7e>
//   - OSC sequences:  ESC ] ... (BEL or ST=ESC \\)
//   - Single-shift / private 2-byte intros: ESC <0x40-0x5F>
//   - Device control / privacy / app program: ESC P/X/^/_ ... ST=ESC \\
//   - Dangerous C0 bytes (NUL, BS, VT, FF, SO/SI, DLE-SUB, FS-US, DEL).
//     We keep \t, \n, \r — \r is borderline (cursor-to-col-0) but plain text
//     output regularly uses CRLF; stripping it would break Windows-style logs.

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
// Dangerous C0 controls. Includes ESC (0x1b) so any orphan ESC byte left over
// after the ANSI pass — e.g. an incomplete escape sequence at end-of-input that
// the streaming sanitizer was forced to flush — gets stripped too.
const DANGEROUS_C0_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitize(s) {
  return s.replace(ANSI_PATTERN, "").replace(DANGEROUS_C0_PATTERN, "");
}

// Stream-friendly sanitizer. ANSI sequences can straddle chunk boundaries —
// if we sanitized each chunk independently, an incomplete sequence at the
// chunk tail would slip through unfiltered. Hold any unfinished tail until
// the next chunk arrives.
export class TerminalSanitizer {
  constructor() { this.pending = ""; }

  push(chunk) {
    const text = this.pending + (typeof chunk === "string" ? chunk : chunk.toString());
    this.pending = "";
    const lastEsc = text.lastIndexOf("\x1b");
    if (lastEsc < 0) return sanitize(text);
    // Determine whether the escape starting at lastEsc is complete.
    const tail = text.slice(lastEsc);
    // Cheap completeness check: a CSI sequence ends with [@-~]; an OSC ends
    // with BEL or ESC \\; a single-shift intro is exactly 2 bytes. If the
    // tail does not contain any of these terminators, hold it back.
    const completedCsi = /\x1b\[[0-?]*[ -/]*[@-~]/.test(tail);
    const completedOsc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(tail);
    const completedDcs = /\x1b[PX^_][^\x1b]*\x1b\\/.test(tail);
    const completedSimple = tail.length >= 2 && /[@-Z\\-_]/.test(tail[1]) &&
      tail[1] !== "[" && tail[1] !== "]" && tail[1] !== "P" && tail[1] !== "X" &&
      tail[1] !== "^" && tail[1] !== "_";
    if (completedCsi || completedOsc || completedDcs || completedSimple) {
      return sanitize(text);
    }
    this.pending = tail;
    return sanitize(text.slice(0, lastEsc));
  }

  flush() {
    const out = sanitize(this.pending);
    this.pending = "";
    return out;
  }
}

export function sanitizeForTerminal(s) { return sanitize(typeof s === "string" ? s : String(s)); }

export function renderJobTable(jobs) {
  if (jobs.length === 0) return "No Gemini jobs in this workspace.";
  const lines = [
    "| Job | Kind | Status | Started | PID | Task |",
    "|-----|------|--------|---------|-----|------|"
  ];
  for (const j of jobs) {
    const task = (j.task_text || "").slice(0, 50).replace(/\|/g, "\\|");
    lines.push(
      `| ${j.id} | ${j.kind}${j.write ? " (w)" : ""} | ${j.status} | ${fmtTime(j.started_at)} | ${j.pid ?? "-"} | ${task} |`
    );
  }
  return lines.join("\n");
}

export function renderJobDetails(meta) {
  const lines = [];
  lines.push(`Job: ${meta.id}`);
  lines.push(`Kind: ${meta.kind}${meta.write ? " (write)" : ""}`);
  lines.push(`Status: ${meta.status}`);
  lines.push(`PID: ${meta.pid ?? "-"}`);
  lines.push(`Started: ${fmtTime(meta.started_at)}`);
  if (meta.ended_at) lines.push(`Ended: ${fmtTime(meta.ended_at)}`);
  if (meta.exit_code !== undefined) lines.push(`Exit: ${meta.exit_code}`);
  lines.push(`Task: ${meta.task_text || "-"}`);
  lines.push("");
  lines.push("Follow-up:");
  lines.push(`- /gemini:result ${meta.id}`);
  lines.push(`- /gemini:cancel ${meta.id}`);
  return lines.join("\n");
}
