import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS, parseDuration } from "../plugins/gemini/scripts/lib/args.mjs";

test("splitRawArgumentString: simple tokens", () => {
  assert.deepEqual(splitRawArgumentString("a b c"), ["a", "b", "c"]);
});

test("splitRawArgumentString: double-quoted preserves spaces", () => {
  assert.deepEqual(splitRawArgumentString('a "b c" d'), ["a", "b c", "d"]);
});

test("splitRawArgumentString: single-quoted preserves spaces", () => {
  assert.deepEqual(splitRawArgumentString("a 'b c' d"), ["a", "b c", "d"]);
});

test("splitRawArgumentString: backslash escape", () => {
  assert.deepEqual(splitRawArgumentString("a\\ b c"), ["a b", "c"]);
});

test("splitRawArgumentString: empty quoted string is a token", () => {
  assert.deepEqual(splitRawArgumentString('a "" b'), ["a", "", "b"]);
});

test("splitRawArgumentString: quoted token at end-of-string", () => {
  assert.deepEqual(splitRawArgumentString('foo "bar baz"'), ["foo", "bar baz"]);
});

test("parseArgs: positional only", () => {
  const r = parseArgs(["foo", "bar"], { boolFlags: COMMON_BOOL_FLAGS, valueFlags: COMMON_VALUE_FLAGS });
  assert.deepEqual(r.positional, ["foo", "bar"]);
  assert.deepEqual(r.flags, {});
});

test("parseArgs: bool flag", () => {
  const r = parseArgs(["--json", "foo"], { boolFlags: new Set(["json"]), valueFlags: new Set() });
  assert.equal(r.flags.json, true);
  assert.deepEqual(r.positional, ["foo"]);
});

test("parseArgs: value flag with separate token", () => {
  const r = parseArgs(["--model", "gemini-2.5-pro", "question"], { boolFlags: new Set(), valueFlags: new Set(["model"]) });
  assert.equal(r.flags.model, "gemini-2.5-pro");
  assert.deepEqual(r.positional, ["question"]);
});

test("parseArgs: value flag with =", () => {
  const r = parseArgs(["--model=gemini-2.5-pro"], { boolFlags: new Set(), valueFlags: new Set(["model"]) });
  assert.equal(r.flags.model, "gemini-2.5-pro");
});

test("parseArgs: missing value flag throws MISSING_VALUE", () => {
  let err;
  try {
    parseArgs(["--model"], { boolFlags: new Set(), valueFlags: new Set(["model"]) });
  } catch (e) { err = e; }
  assert.equal(err && err.code, "MISSING_VALUE");
});

test("parseArgs: unknown flag becomes positional (not silently dropped)", () => {
  const r = parseArgs(["--unknown-flag", "foo"], { boolFlags: new Set(), valueFlags: new Set() });
  assert.deepEqual(r.positional, ["--unknown-flag", "foo"]);
});

test("parseArgs: handles single-string-argv (Claude Code forwards $ARGUMENTS as one token)", () => {
  const r = parseArgs(['--model gemini-2.5-pro "what is monad"'], { boolFlags: new Set(), valueFlags: new Set(["model"]) });
  assert.equal(r.flags.model, "gemini-2.5-pro");
  assert.deepEqual(r.positional, ["what is monad"]);
});

test("parseArgs: bool with =false sets to false", () => {
  const r = parseArgs(["--json=false"], { boolFlags: new Set(["json"]), valueFlags: new Set() });
  assert.equal(r.flags.json, false);
});

// parseDuration powers both --older-than (purge) and --timeout (ask/review/task).
// Both call sites need the same forms accepted, so the suite below pins the
// contract for any caller adding a duration-flavored flag in the future.
test("parseDuration: accepts s/m/h/d unit suffixes", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("2d"), 172_800_000);
});

test("parseDuration: accepts explicit ms suffix", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("1500ms"), 1500);
});

test("parseDuration: bare integer is ms (back-compat with cmdPurge contract)", () => {
  assert.equal(parseDuration("100"), 100);
  assert.equal(parseDuration("0"), 0);
});

test("parseDuration: zero disables timeout regardless of unit", () => {
  // Callers treat 0 as "no timeout"; the parser must accept all unit forms.
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("0s"), 0);
  assert.equal(parseDuration("0m"), 0);
  assert.equal(parseDuration("0ms"), 0);
});

test("parseDuration: rejects malformed input", () => {
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration("30x"), null);    // unknown unit
  assert.equal(parseDuration("-5s"), null);    // negative
  assert.equal(parseDuration("3.14s"), null);  // float
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration(42), null);       // non-string
});

test("parseDuration: case-insensitive units", () => {
  assert.equal(parseDuration("30S"), 30_000);
  assert.equal(parseDuration("5M"), 300_000);
  assert.equal(parseDuration("1H"), 3_600_000);
});
