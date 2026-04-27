import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString, COMMON_BOOL_FLAGS, COMMON_VALUE_FLAGS } from "../plugins/gemini/scripts/lib/args.mjs";

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
