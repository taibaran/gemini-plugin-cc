import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPid, isAlive } from "../scripts/lib/process.mjs";

test("isValidPid: accepts positive integers > 1", () => {
  assert.equal(isValidPid(2), true);
  assert.equal(isValidPid(12345), true);
  assert.equal(isValidPid(99999), true);
});

test("isValidPid: rejects 0 and 1 (broadcast / init)", () => {
  // kill(0, sig) signals process group of caller — never useful.
  // kill(1, sig) targets init/launchd OR (when negated) broadcasts.
  // Both are dangerous footguns; the validator must reject both.
  assert.equal(isValidPid(0), false);
  assert.equal(isValidPid(1), false);
});

test("isValidPid: rejects negative numbers", () => {
  assert.equal(isValidPid(-1), false);
  assert.equal(isValidPid(-12345), false);
});

test("isValidPid: rejects non-integers", () => {
  assert.equal(isValidPid(1.5), false);
  assert.equal(isValidPid(NaN), false);
  assert.equal(isValidPid(Infinity), false);
});

test("isValidPid: rejects non-numbers", () => {
  assert.equal(isValidPid("123"), false);
  assert.equal(isValidPid(null), false);
  assert.equal(isValidPid(undefined), false);
  assert.equal(isValidPid({}), false);
});

test("isAlive: false for invalid pids", () => {
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(1), false);
  assert.equal(isAlive(-5), false);
  assert.equal(isAlive("foo"), false);
});

test("isAlive: true for the current process", () => {
  assert.equal(isAlive(process.pid), true);
});

test("isAlive: false for a definitely-dead pid", () => {
  // PIDs above 4_000_000 are extremely unlikely to be in use on most systems.
  // If this test ever flakes, raise the constant. The point is to verify
  // ESRCH (no such process) is handled as "not alive".
  assert.equal(isAlive(3_999_999), false);
});
