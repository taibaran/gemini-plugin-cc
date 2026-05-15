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

// v0.5.14 regression guard for the same bug class as #4 but a DIFFERENT cause.
// The v0.5.13 fix only addressed the "-- separator misparsed as pathspec" case.
// `git diff <ref>...HEAD` can ALSO fail with status 128 + stderr when there's
// no merge base (unrelated histories, shallow clones missing history, etc.),
// and the prior code returned `kind: "branch", diff: ""` for that too — same
// silent "Nothing to review" false-negative. The fix introduces a distinct
// `kind: "diff-failed"` so callers exit non-zero with the actual git error.
// Caught by 3/3 reviewer consensus during /grok:aggregate-review of v0.5.13.
test("captureDiff scope=branch surfaces git failure (no merge base) instead of silent empty", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-test-orphan-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const opts = { cwd: repoDir, encoding: "utf8", env };
  const run = (...args) => spawnSync("git", args, opts);

  run("init", "-q", "-b", "main");
  run("commit", "--allow-empty", "-q", "-m", "init");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "alpha\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "alpha");

  // Create an orphan branch — unrelated history from `main`, no merge base.
  run("checkout", "--orphan", "other", "-q");
  // Remove the staged content from the parent index so the orphan commit
  // doesn't share blobs.
  run("rm", "-rf", "--cached", ".");
  fs.writeFileSync(path.join(repoDir, "b.txt"), "beta\n");
  run("add", "b.txt");
  run("commit", "-q", "-m", "beta");

  // `git diff main...HEAD` from the orphan branch: no merge base → exit 128.
  // The legitimate ref passes verify, so we DO reach the diff stage.
  const result = captureDiff({ scope: "branch", base: "main", cwd: repoDir });
  assert.equal(result.kind, "diff-failed",
    `expected kind=diff-failed for orphan-branch diff, got kind=${result.kind} diff.length=${result.diff?.length} (the v0.5.13 fix would have returned kind=branch with diff="")`);
  assert.equal(result.base, "main");
  assert.match(result.error || "", /no merge base/i, "diff-failed result must carry the git error message");
});
