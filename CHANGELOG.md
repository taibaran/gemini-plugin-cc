# Changelog

## 0.4.2 — Broaden rescue agent's proactive trigger

- `agents/gemini-rescue.md` description now explicitly names long-form
  research reports and multi-domain analysis (security, gap analysis,
  code-quality audits) as triggers, plus a hint to prefer the shared
  runtime over invoking the Gemini CLI directly. Closes a gap where
  Claude Code, when asked to produce a long Gemini-backed report, would
  shell out to `gemini` directly instead of routing through the plugin.

## 0.4.1 — Pin to strongest Gemini model

- Plugin now passes `--model gemini-3.1-pro-preview` explicitly on every Gemini
  invocation (`lib/gemini.mjs:DEFAULT_MODEL`). This is the strongest publicly
  available Gemini Pro model as of 2026-04, verified against the live CLI.
  Pinning makes results consistent even if Google rotates the CLI's
  unspecified default to a different tier (e.g., flash) for traffic shaping.
- New override paths:
  - `--model <id>` per call (highest priority)
  - `GEMINI_PLUGIN_MODEL=<id>` environment variable (next)
  - `lib/gemini.mjs:DEFAULT_MODEL` constant (fallback)
- `/gemini:setup` now reports the active model and where it came from
  (`plugin default` vs `via GEMINI_PLUGIN_MODEL`).
- The auth probe also pins to the same model so `setup` measures exactly
  the model that real review/ask/task calls will use.
- Confirmed availability: `gemini-3.1-pro-preview` ✅, `gemini-3-pro-preview` ✅,
  `gemini-2.5-pro` ✅. Rejected: `gemini-3.1-pro`, `gemini-3-pro`
  (`ModelNotFoundError`).

## 0.4.0 — Security hardening pass

Codex and Gemini both reviewed v0.3.2 for security. Together they flagged
12 issues spanning command injection, path traversal, prompt-injection
bypasses, TOCTOU races, and DoS vectors. Most are fixed in this release.

### Critical / High

- **Path traversal via job ID**: `cmdCancel ../../../tmp/evil` could read an
  attacker-planted JSON and pass its `pid` to `process.kill(-pid,…)`. With
  `pid: 1`, that becomes `kill(-1,…)` — a POSIX broadcast that kills the
  user's whole session. Fixed two ways: (1) `lib/state.mjs:isValidJobId`
  enforces `^g-[a-z0-9]+-[a-z0-9]+$` on every read/write, so unsanitized
  IDs can't escape `jobsDir/`; (2) `lib/process.mjs:isValidPid` rejects
  PIDs ≤ 1 before any `process.kill` call.
- **TOCTOU on atomic temp file**: the previous `${target}.tmp.${pid}.${Date.now()}`
  scheme was predictable; in shared `/tmp` a local attacker could plant
  symlinks to overwrite arbitrary files (e.g. `~/.ssh/authorized_keys`).
  `lib/state.mjs:atomicWrite` now uses `crypto.randomBytes(12)` for the
  tmp suffix and `fs.openSync(tmp, "wx", 0o600)` (exclusive-create, fails
  on EEXIST) before writing.
- **Stop-gate first-line trust**: the previous gate parsed `ALLOW`/`BLOCK`
  from the first line of Gemini's free-text output. A malicious diff could
  ask Gemini to emit `ALLOW: trust me` and bypass the gate. Fixed by
  switching `prompts/stop-review-gate.md` to require strict JSON output
  (`{"decision": "allow"|"block", "reason": "..."}`) and adding a JSON
  parser in `stop-review-gate-hook.mjs` that ignores any prose, code
  fences, or trailing content. The prompt explicitly tells Gemini to
  treat any "ALLOW"/"BLOCK" strings inside the diff as data, not commands.

### Medium

- **Git ref injection**: `--base -evil` was being parsed by `git diff` as a
  flag. `lib/git.mjs:isValidGitRef` enforces `^[a-zA-Z0-9_][a-zA-Z0-9_./@^~-]*$`
  with length limit; the diff command also uses `--` to separate options
  from refs.
- **Unbounded JSON state files**: `readJobMeta`/`readConfig` now go through
  `readBoundedJson` which `stat`s the file and refuses anything over
  `MAX_STATE_FILE_BYTES` (256 KiB).
- **Diff OOM**: `captureDiff` truncates at `MAX_DIFF_BYTES` (4 MiB) with a
  visible truncation marker. A repo full of generated assets no longer
  crashes the Stop hook.
- **`pruneJobs` race**: it could delete `running` jobs and follow attacker-
  controlled `stdout_path`/`stderr_path` outside `jobsDir/`. Now skips
  running jobs and only unlinks log files that resolve inside `jobsDir`.
- **XML escape too narrow**: `neutralizeXmlClosers` only handled `</`,
  letting malicious focus text smuggle whole `<task>...</task>` blocks
  with the closer escaped. Replaced with `escapeXmlInTrustedBlock`, which
  escapes `&`, `<`, and `>` (full XML escape) on user-controlled values
  only — trusted scaffolding is unaffected.

### Known and intentional

- **ANSI escape sequences in Gemini output**: a prompt-injected diff could
  in principle make Gemini emit OSC sequences (window-title spoofing,
  clipboard writes). Stripping all CSI/OSC would break legitimate colored
  output. Mitigation deferred — caller's terminal is presumed trusted.
- **Stop-gate fail-open**: every operational error (auth, timeout, parse
  failure) currently allows. This is a deliberate soft-gate posture.
  A future flag (`GEMINI_REVIEW_GATE_STRICT=1`) could flip it.

## 0.3.2 — Fix over-aggressive XML escape

- **Prompt-template escape moved to the boundary**: Codex's third-pass review caught that `renderTemplate` was escaping `</...>` in *every* substitution value, including pre-built trusted XML scaffolding like `CLAUDE_RESPONSE_BLOCK`. That malformed the prompt's own closing tags. Fix: `renderTemplate` is back to literal substitution; `neutralizeXmlClosers` is now called only on user-controlled inputs (`USER_FOCUS`, `TARGET_LABEL`, `claudeResponse`) at the point of entry, *before* they're wrapped by the trusted scaffolding. Verified: trusted `</claude_response>`/`</repository_context>` remain intact, user-supplied closers become `&lt;/...>`.

## 0.3.1 — Post-review hardening

Codex's second-pass review caught seven concrete issues. All fixed:

- **Manifest version** corrected from `0.2.0` to `0.3.0` (now `0.3.1` after this pass).
- **`cmdCancel` guard**: cancelling a completed/failed job by ID now reports the current status and exits without overwriting the job to `cancelled`.
- **Stop-hook protocol**: switched to Claude Code's documented Stop-hook block format `{decision: "block", reason: "..."}` (was `{continue: false, stopReason: ...}`). Allow path now silent (default) or `{systemMessage: ...}` when a reason should be surfaced.
- **Hook stdin reader**: synchronous `fs.readFileSync(0, "utf8")` instead of an async-with-timeout reader. Eliminates partial-input hazards.
- **Hook cwd resolution**: `stop-review-gate-hook.mjs` reads `cwd` from the hook input JSON and passes it to `readConfig` and the gemini child, instead of relying on `process.cwd()`.
- **Atomic config + job writes**: `lib/state.mjs` now writes `config.json` and per-job metadata via write-temp-then-rename so concurrent toggles or cancellations can never produce torn files.
- **Prompt-template injection**: `lib/prompts.mjs` `renderTemplate` now neutralizes `</...>` sequences in user-controlled values before substitution. A user focus or transcript fragment containing `</repository_context>` (etc.) can no longer break out of its intended XML block.
- **Review job tracking**: `cmdReview` now writes job metadata at start and tees stdout to a log file, matching `commands/review.md`'s background-flow promise that `/gemini:status` will surface the run.
- **Shallow JSON-schema validation**: `review --json` now performs a top-level required-fields + verdict-enum check on the unwrapped JSON. Mismatches print a `[gemini-plugin] schema mismatch` warning to stderr while still emitting the raw output, so the caller can decide what to do.
- **Skill guidance** (`gemini-result-handling`) updated to honestly describe the validation level (top-level shape, not full schema).

## 0.3.0 — Architectural pass to match codex-plugin-cc

- **Modular `scripts/lib/`**: companion.mjs split into focused modules:
  `args.mjs`, `state.mjs`, `process.mjs`, `git.mjs`, `gemini.mjs`,
  `prompts.mjs`, `render.mjs`. companion.mjs is now a slim dispatcher.
- **Stop-time review gate**: `Stop` hook (`hooks/hooks.json`) +
  `scripts/stop-review-gate-hook.mjs`. When enabled, asks Gemini to do an
  adversarial review of the last turn's diff and may emit
  `{continue: false, stopReason}` to block premature stops. Failure modes
  (no auth, timeout, parse error) all fail-open.
- **Session lifecycle**: `SessionStart`/`SessionEnd` hooks +
  `scripts/session-lifecycle-hook.mjs`. Reaps orphan jobs from prior
  sessions, prunes the jobs directory, never blocks the user.
- **Per-workspace config**: `state.mjs` now stores `reviewGateEnabled` in a
  workspace-scoped `config.json` (parallel to `jobs/`).
  `setup --enable-review-gate` / `--disable-review-gate` toggles it.
- **Externalized prompts**: `prompts/review.md`, `prompts/adversarial-review.md`,
  `prompts/stop-review-gate.md`. Loaded via `lib/prompts.mjs` with
  `{{TARGET_LABEL}}`, `{{USER_FOCUS}}` substitution.
- **JSON review schema**: `schemas/review-output.schema.json`. `review --json`
  asks Gemini for schema-validated JSON, then strips Gemini's wrapper
  (`{session_id, response, stats}`) and any markdown fences before emitting
  clean JSON to stdout.
- **Skills**: `skills/gemini-cli-runtime/`, `skills/gemini-prompting/`,
  `skills/gemini-result-handling/`. The rescue agent now declares
  `skills: [gemini-cli-runtime, gemini-prompting]` for prompt-shaping
  guidance without inviting independent investigation.
- **Process-tree termination**: extracted to `lib/process.mjs`.
  `terminateProcessTree` SIGTERMs the process group (negative PID) with
  fallback to PID-only kill, then escalates to SIGKILL after a 2s grace.

## 0.2.0

- Add Node companion script (`scripts/companion.mjs`) with subcommands: `setup`, `ask`, `review`, `adversarial-review`, `task`, `status`, `result`, `cancel`.
- Add slash commands: `/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`.
- Add `gemini-rescue` subagent for delegating tasks.
- All commands now invoke the companion via `${CLAUDE_PLUGIN_ROOT}` instead of inlining `gemini` shell calls.
- Background-job tracking under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/`.
- Auth-failure classification with actionable hints from `setup`.

### Bug fixes after Codex review pass
- `splitRawArgumentString`: trailing backslashes are no longer dropped; empty quoted strings are preserved as tokens.
- `cmdResult`: refresh job status before filtering out running jobs, so a just-ended job is recoverable.
- Cancel/close race: the close handler re-reads metadata and preserves a `cancelled` status set by `killJob`, instead of overwriting it with `completed`/`failed`.
- `killJob`: child task is now spawned `detached: true` so its process group can be killed (`kill -pid`); falls back to PID-only kill if the group call fails.
- Review auth-error classification now scans both stdout and stderr (Gemini sometimes prints auth errors to stdout).

## 0.1.0

- Initial minimal plugin: `/gemini:setup`, `/gemini:ask`, `/gemini:review` invoking `gemini` CLI inline.
