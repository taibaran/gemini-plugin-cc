import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForTerminal, TerminalSanitizer } from "../plugins/gemini/scripts/lib/render.mjs";

test("sanitize: plain text passthrough", () => {
  assert.equal(sanitizeForTerminal("hello world"), "hello world");
});

test("sanitize: strips CSI color sequences", () => {
  assert.equal(sanitizeForTerminal("\x1b[31mred\x1b[0m"), "red");
});

test("sanitize: strips OSC title-bar updates", () => {
  assert.equal(sanitizeForTerminal("a\x1b]0;evil title\x07b"), "ab");
});

test("sanitize: strips OSC 52 clipboard hijack", () => {
  // OSC 52 (Bc) is the clipboard-write escape — a real attack surface.
  // A malicious diff that gets echoed must not silently overwrite clipboard.
  assert.equal(sanitizeForTerminal("clipboard\x1b]52;c;hax\x07yo"), "clipboardyo");
});

test("sanitize: strips orphan ESC byte", () => {
  // An incomplete escape sequence with no terminator must still not leak the
  // ESC byte to the terminal — the streaming sanitizer's flush() relies on
  // the C0 pass cleaning up these orphans.
  assert.equal(sanitizeForTerminal("orphan\x1bend"), "orphanend");
});

test("sanitize: strips dangerous C0 controls (BEL, BS, FF, etc.)", () => {
  assert.equal(sanitizeForTerminal("a\x07b"), "ab");      // BEL
  assert.equal(sanitizeForTerminal("a\x08b"), "ab");      // BS
  assert.equal(sanitizeForTerminal("a\x0cb"), "ab");      // FF
  assert.equal(sanitizeForTerminal("a\x7fb"), "ab");      // DEL
});

test("sanitize: keeps tab, newline, CR (safe text whitespace)", () => {
  assert.equal(sanitizeForTerminal("a\tb"), "a\tb");
  assert.equal(sanitizeForTerminal("a\nb"), "a\nb");
  assert.equal(sanitizeForTerminal("a\rb"), "a\rb");
});

test("TerminalSanitizer: streaming split CSI is held until complete", () => {
  const s = new TerminalSanitizer();
  // ESC [ 3 split here — first chunk ends mid-sequence, sanitizer must hold.
  const out1 = s.push("hello\x1b[3");
  // The completing chunk arrives; the full sequence is now stripped.
  const out2 = s.push("1mRED\x1b[0m");
  const out3 = s.flush();
  assert.equal(out1 + out2 + out3, "helloRED");
});

test("TerminalSanitizer: streaming split OSC is held until complete", () => {
  const s = new TerminalSanitizer();
  const out1 = s.push("a\x1b]0;t");
  const out2 = s.push("itle\x07b");
  const out3 = s.flush();
  assert.equal(out1 + out2 + out3, "ab");
});

test("TerminalSanitizer: incomplete sequence at flush time is dropped entirely", () => {
  const s = new TerminalSanitizer();
  const out1 = s.push("ok\x1b[3");  // never completes
  const out2 = s.flush();
  // The held tail "\x1b[3" cannot complete; flush drops the whole tail
  // because partial sequences cannot be safely emitted — the visible "[3"
  // after the ESC strip would be junk and, worse, could prefix a real
  // sequence in whatever the next write produces.
  assert.equal(out1 + out2, "ok");
});

test("TerminalSanitizer: handles non-string input via toString", () => {
  const s = new TerminalSanitizer();
  // Buffer-style chunk with one ANSI sequence
  const buf = Buffer.from("hi \x1b[31mthere\x1b[0m", "utf8");
  const out = s.push(buf) + s.flush();
  assert.equal(out, "hi there");
});
