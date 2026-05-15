// Git helpers for review scope detection and diff capture.

import { spawnSync } from "node:child_process";

// Hard cap on diff bytes piped to Gemini. A massive working-tree diff (e.g.
// from accidentally-tracked binaries or generated assets) would otherwise
// OOM Node before Gemini even sees it. 4 MB is generous for code review;
// anything larger is truncated with a marker so the reviewer knows.
export const MAX_DIFF_BYTES = 4 * 1024 * 1024;

// Node's spawnSync default maxBuffer is 1 MB. Without raising it explicitly,
// any `git diff` between 1 MB and `MAX_DIFF_BYTES` exceeds Node's child-stdout
// buffer and the call returns ENOBUFS with the stdout truncated to the cap —
// our own `truncateDiff` logic never runs and no truncation marker is added.
// Set maxBuffer above MAX_DIFF_BYTES with slack so truncation is always our
// decision, not Node's silent default. (v0.5.14: caught by Codex during
// /grok:aggregate-review against the full robustness arc.)
const GIT_SPAWN_MAX_BUFFER = MAX_DIFF_BYTES + 64 * 1024;
const GIT_DIFF_SPAWN = { encoding: "utf8", maxBuffer: GIT_SPAWN_MAX_BUFFER };

// Refs we accept on the command line. Forbids anything starting with `-`
// (would be parsed as a git option), null bytes, whitespace, and quote
// metacharacters. Permits the standard `[a-zA-Z0-9_./-]` plus refspec syntax.
const REF_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_./@^~-]*$/;
export function isValidGitRef(ref) {
  return typeof ref === "string" && REF_PATTERN.test(ref) && ref.length < 256;
}

export function isInsideRepo(cwd) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", cwd });
  return r.status === 0;
}

export function guessBaseRef(cwd) {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = spawnSync("git", ["rev-parse", "--verify", ref], { encoding: "utf8", cwd });
    if (r.status === 0) return ref;
  }
  return null;
}

function truncateDiff(diff) {
  if (diff.length <= MAX_DIFF_BYTES) return diff;
  const head = diff.slice(0, MAX_DIFF_BYTES);
  return head + `\n\n[... diff truncated by gemini-plugin: ${diff.length - MAX_DIFF_BYTES} bytes omitted to stay under ${MAX_DIFF_BYTES} bytes]\n`;
}

export function captureDiff({ scope, base, cwd } = {}) {
  if (!isInsideRepo(cwd)) return { kind: "no-repo", diff: "" };

  if (scope === "branch") {
    const ref = base || guessBaseRef(cwd);
    if (!ref) return { kind: "no-base", diff: "" };
    if (!isValidGitRef(ref)) return { kind: "bad-ref", diff: "", base: ref };
    // Verify the ref actually resolves before diffing. Without this, a typo
    // like `--base mian` produces an empty diff and the caller cannot tell
    // it apart from a clean branch.
    const verify = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8", cwd });
    if (verify.status !== 0) return { kind: "bad-ref", diff: "", base: ref };
    // `--` separates options from PATHSPECS, not refspecs. Issue #4: the
    // previous form `git diff -- <ref>...HEAD` made git treat the refspec
    // as a path named "<ref>...HEAD", which matched nothing → empty diff
    // with exit 0 (so the fallback below never fired). The refspec must
    // come BEFORE `--`. The trailing `--` still terminates option parsing
    // for any future arg the caller might add, preserving the defense
    // intent of the original code.
    const r = spawnSync("git", ["diff", `${ref}...HEAD`, "--"], { ...GIT_DIFF_SPAWN, cwd });
    let out = "";
    let diffError = null;
    if (r.status === 0) {
      out = r.stdout || "";
    } else {
      // Older git versions (<2.5) may not accept the trailing `--` after a
      // refspec form `A...B`. Fall back to the plain refspec form.
      const fb = spawnSync("git", ["diff", `${ref}...HEAD`], { ...GIT_DIFF_SPAWN, cwd });
      if (fb.status === 0) {
        out = fb.stdout || "";
      } else {
        // BOTH forms failed. This is NOT a clean branch — it's a real diff
        // failure (no merge base under unrelated histories, shallow clone
        // that's missing the base ref's history, ambiguous ref, etc.).
        // Returning `kind: "branch", diff: ""` here would let cmdReview
        // print "Nothing to review" — the same false-negative that issue
        // #4 reported under a different cause. Surface the failure
        // explicitly so callers can exit non-zero with the git error.
        // (v0.5.14: 3/3 reviewer consensus during the aggregate-review of
        // the v0.5.13 fix.)
        diffError = (fb.stderr || r.stderr || "git diff exited non-zero with no stderr").trim();
      }
    }
    if (diffError !== null) {
      return { kind: "diff-failed", diff: "", base: ref, error: diffError };
    }
    return { kind: "branch", diff: truncateDiff(out), base: ref };
  }
  if (scope === "staged") {
    const r = spawnSync("git", ["diff", "--cached"], { ...GIT_DIFF_SPAWN, cwd });
    return { kind: "staged", diff: truncateDiff(r.stdout || "") };
  }
  if (scope === "unstaged") {
    const r = spawnSync("git", ["diff"], { ...GIT_DIFF_SPAWN, cwd });
    return { kind: "unstaged", diff: truncateDiff(r.stdout || "") };
  }
  // auto / working-tree
  const cached = spawnSync("git", ["diff", "--cached"], { ...GIT_DIFF_SPAWN, cwd }).stdout || "";
  const unstaged = spawnSync("git", ["diff"], { ...GIT_DIFF_SPAWN, cwd }).stdout || "";
  return { kind: "working-tree", diff: truncateDiff(cached + unstaged) };
}

