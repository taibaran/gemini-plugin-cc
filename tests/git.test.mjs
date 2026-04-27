import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidGitRef } from "../plugins/gemini/scripts/lib/git.mjs";

test("isValidGitRef: accepts simple branch names", () => {
  assert.equal(isValidGitRef("main"), true);
  assert.equal(isValidGitRef("master"), true);
  assert.equal(isValidGitRef("feature/foo"), true);
});

test("isValidGitRef: accepts origin-prefixed refs", () => {
  assert.equal(isValidGitRef("origin/main"), true);
  assert.equal(isValidGitRef("origin/feature/x"), true);
});

test("isValidGitRef: accepts tags and refs with dots/dashes", () => {
  assert.equal(isValidGitRef("v1.2.3"), true);
  assert.equal(isValidGitRef("release-1.2"), true);
});

test("isValidGitRef: rejects refs starting with dash (would be parsed as flag)", () => {
  assert.equal(isValidGitRef("-rf"), false);
  assert.equal(isValidGitRef("-something"), false);
});

test("isValidGitRef: rejects empty string", () => {
  assert.equal(isValidGitRef(""), false);
});

test("isValidGitRef: rejects non-string input", () => {
  assert.equal(isValidGitRef(null), false);
  assert.equal(isValidGitRef(undefined), false);
  assert.equal(isValidGitRef(42), false);
  assert.equal(isValidGitRef({}), false);
});

test("isValidGitRef: rejects whitespace and quote metacharacters", () => {
  assert.equal(isValidGitRef("ref with space"), false);
  assert.equal(isValidGitRef('ref"with"quote'), false);
  assert.equal(isValidGitRef("ref'with'quote"), false);
});

test("isValidGitRef: rejects null bytes and shell metacharacters", () => {
  assert.equal(isValidGitRef("ref\x00null"), false);
  assert.equal(isValidGitRef("ref;rm"), false);
  assert.equal(isValidGitRef("ref$(echo)"), false);
  assert.equal(isValidGitRef("ref|pipe"), false);
});

test("isValidGitRef: rejects refs longer than 256 chars", () => {
  assert.equal(isValidGitRef("a".repeat(256)), false);
  assert.equal(isValidGitRef("a".repeat(255)), true);
});
