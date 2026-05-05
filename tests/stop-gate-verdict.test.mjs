// The Stop-review-gate hook parses Gemini's JSON verdict. The parser is the
// last line of defense against prompt-injection (a malicious diff cannot
// trick Gemini into emitting a free-form "ALLOW" — it must produce a
// strictly-shaped JSON). These tests pin the parser's contract by importing
// the production implementation directly, so a regression in lib/verdict.mjs
// fails the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../plugins/gemini/scripts/lib/verdict.mjs";

test("parseVerdict: clean allow", () => {
  const r = parseVerdict('{"decision":"allow","reason":"all green"}');
  assert.deepEqual(r, { decision: "allow", reason: "all green" });
});

test("parseVerdict: clean block", () => {
  const r = parseVerdict('{"decision":"block","reason":"missing tests"}');
  assert.deepEqual(r, { decision: "block", reason: "missing tests" });
});

test("parseVerdict: handles ```json fenced wrapping", () => {
  const r = parseVerdict('```json\n{"decision":"allow","reason":"ok"}\n```');
  assert.equal(r.decision, "allow");
});

test("parseVerdict: rejects free-form ALLOW (prompt-injection guard)", () => {
  // The whole point of the JSON contract: a malicious diff cannot bypass the
  // gate by tricking Gemini into emitting a literal word.
  assert.equal(parseVerdict("ALLOW"), null);
  assert.equal(parseVerdict("BLOCK because"), null);
});

test("parseVerdict: rejects unknown decision values", () => {
  assert.equal(parseVerdict('{"decision":"yolo","reason":"no"}'), null);
  assert.equal(parseVerdict('{"decision":true}'), null);
});

test("parseVerdict: handles braces inside reason string (string-aware balance)", () => {
  // Without string-aware balanced-brace tracking, the inner } would be
  // treated as the end of the JSON object and parsing would fail.
  const r = parseVerdict('{"decision":"block","reason":"got } unexpected token"}');
  assert.equal(r.decision, "block");
  assert.equal(r.reason, "got } unexpected token");
});

test("parseVerdict: rejects missing reason field gracefully (reason becomes empty)", () => {
  const r = parseVerdict('{"decision":"allow"}');
  assert.equal(r.decision, "allow");
  assert.equal(r.reason, "");
});

test("parseVerdict: rejects malformed JSON", () => {
  assert.equal(parseVerdict('{"decision":"allow",reason:"missing-quote"}'), null);
  assert.equal(parseVerdict("not json at all"), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict(null), null);
});

test("parseVerdict: extracts first JSON object from leading prose", () => {
  // Gemini sometimes prefixes its verdict with a sentence even when asked not to.
  const r = parseVerdict('Here is my verdict: {"decision":"allow","reason":"clean"}');
  assert.equal(r.decision, "allow");
});
