import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isValidGitRef, captureDiff } from "../plugins/gemini/scripts/lib/git.mjs";

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

// Issue #4 regression guard. captureDiff({ scope: "branch", base: <ref> })
// used to call `git diff -- <ref>...HEAD` which interprets the refspec as
// a pathspec (the `--` separator's right-hand side is paths, not refs).
// `git diff -- HEAD~1...HEAD` returns 0 bytes with exit 0, so the fallback
// to the no-`--` form never fired — every branch review silently returned
// "Nothing to review". v0.5.13 moved `--` to come AFTER the refspec.
test("captureDiff scope=branch returns the actual diff (issue #4 regression)", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-test-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const opts = { cwd: repoDir, encoding: "utf8", env };
  const run = (...args) => spawnSync("git", args, opts);
  run("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "version one\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "version two\n");
  run("commit", "-q", "-am", "second");

  const result = captureDiff({ scope: "branch", base: "HEAD~1", cwd: repoDir });
  assert.equal(result.kind, "branch", `expected kind=branch, got ${result.kind}`);
  assert.equal(result.base, "HEAD~1");
  // The whole point of the regression: before the fix, result.diff was "".
  // With the fix, it must contain real diff content (`+version two`).
  assert.ok(result.diff.length > 0, "branch diff must not be empty");
  assert.match(result.diff, /\+version two/, "branch diff must contain the new line");
  assert.match(result.diff, /-version one/, "branch diff must contain the removed line");
});
