# Changelog

## 0.5.2 — Fix CI smoke test + cmdTask check order

Two bugs surfaced when the v0.5.1 CI run failed on a runner without
`gemini` installed.

- **`cmdTask` now refuses `--write` before checking whether `gemini`
  is installed.** Previously the order was `which("gemini") → exit 127`
  then write-gate check. On a system where the binary is missing and
  the user tries `--write`, that surfaced "Gemini CLI not installed"
  instead of the policy refusal — confusing for a user ("install...
  oh wait, refused for safety") and broken for CI (the smoke test
  could never observe exit 2). The write-mode gate is a policy
  decision about the local environment, not a question of whether
  Gemini is reachable; it should always fire first.
- **CI smoke test fixed.** The previous step piped node's output
  through `tee`, which masked node's exit code with tee's (always 0).
  The check `if [ "$rc" -ne 2 ]` was effectively comparing 0 against
  2 — it would have failed even if the underlying logic were correct.
  Now writes to a file directly, captures `$?` cleanly, and asserts
  there is no "not installed" string in the output (regression test
  for the order-bug above).
- **New unit test pins the order**. Spawns the dispatcher with
  `PATH=/nonexistent` so `which("gemini")` is guaranteed to fail, and
  asserts the write-refusal still wins. 85 tests total.

## 0.5.1 — Polish on the v0.5.0 review (8/10 reviewer follow-ups)

The v0.5.0 audit landed at 8/10 with five concrete polish items.
This release closes them.

- **Model fallback now persists.** Previously `probeWithFallback()` only
  affected setup's own report; later `/gemini:ask` / `/gemini:review` /
  `/gemini:task` calls would still try the unavailable `DEFAULT_MODEL`
  and re-fail. Setup now writes the working fallback to the workspace
  config (`activeModel`) via the new `setActiveModel()`. `effectiveModel()`
  reads it back as a third-priority tier between env and default.
  Precedence is now: caller `--model` → `GEMINI_PLUGIN_MODEL` env →
  `config.activeModel` → `DEFAULT_MODEL`. When the default works again
  on a later setup run, the persisted fallback is automatically cleared.
- **Stop-gate strict mode now covers the fatal catch.** The outer
  `try/catch` in `stop-review-gate-hook.mjs` previously called
  `emitAllow()` even in strict mode, contradicting the documented
  contract. Now routes through `emitInfraFailure()` so strict mode
  blocks here too.
- **Node version aligned across README, package.json, and CI.** README
  said 18+, `package.json` declared `>=20`, CI ran 20/22. Settled on
  Node 20+ everywhere.
- **Skill docs now mention `/gemini:purge` and the write gate.**
  `gemini-cli-runtime` documents that `--write` is gated by
  `GEMINI_PLUGIN_ALLOW_WRITE=1` and tells the rescue subagent to
  surface the refusal verbatim. `gemini-prompting` documents the new
  precedence chain and the write-mode contract.
- **2 new tests (84 total).** `state.test.mjs` covers `setActiveModel`
  roundtrip and rejection of malformed model ids (defense against
  config tampering: shell metacharacters, paths, oversize). The
  `effectiveModel` test in `gemini.test.mjs` is rewritten to verify
  the full four-tier precedence including the new config tier, with
  proper workspace isolation via `CLAUDE_PLUGIN_DATA`.

## 0.5.0 — Product-readiness pass

Closes the gap between "competent code" and "I'd let a teammate install
this." Driven by an external review that scored the plugin 7.5/10 for
architecture and 5.5–6/10 for product readiness — exactly right. This
release closes most of that gap.

### Hardening (P0)

- **`--write` requires explicit opt-in.** Previously `--write` flipped
  Gemini into `--approval-mode yolo` (it can modify files without
  per-action confirmation) on a single flag. Now refused unless
  `GEMINI_PLUGIN_ALLOW_WRITE=1` is set. The refusal message explains
  exactly what's at stake. When write mode is active, `[gemini-plugin]
  WRITE MODE ACTIVE` is emitted to stderr.
- **Stop-review-gate strict mode.** New `GEMINI_REVIEW_GATE_STRICT=1`
  flips the gate from fail-open (the default — a broken Gemini install
  must not strand the user mid-session) to fail-closed for
  infrastructure errors. Useful where "gate couldn't run" should mean
  "don't stop yet."
- **`safeJobLogPath` moved to `lib/state.mjs`** so it can be unit-tested
  in isolation, and now consistently used by `pruneJobs` too (was
  inlined there).

### Robustness (P1)

- **Model fallback chain.** New `MODEL_FALLBACK_CHAIN` and
  `probeWithFallback()`: at setup, if the pinned default
  (`gemini-3.1-pro-preview`) is not available for the user's account,
  the plugin probes `gemini-3-pro-preview` then `gemini-2.5-pro` and
  reports which one ended up working. An explicit `--model` or
  `GEMINI_PLUGIN_MODEL` always wins over the chain. `classifyAuthBlob`
  now detects `model unavailable` as its own category.
- **CLI version check.** Setup now compares the local `gemini --version`
  against `MIN_GEMINI_VERSION = 0.30.0` and surfaces an actionable
  upgrade message when the installed version is too old.
- **Real test suite.** 82 unit tests using Node's built-in
  `node:test` runner — zero external dev dependencies. Coverage:
  `args.mjs` (parsing, quoting, missing-value), `git.mjs`
  (`isValidGitRef` rejection cases), `state.mjs`
  (`isValidJobId`, `safeJobLogPath`, `purgeJobs` age filtering, atomic
  write, config persistence), `process.mjs` (`isValidPid` boundaries,
  `isAlive` for current/dead pids), `render.mjs` (`TerminalSanitizer`
  including streaming split-CSI / split-OSC and incomplete-tail
  drop-on-flush), `gemini.mjs` (`cleanGeminiEnv` dropping every secret
  category, `compareVersions`, `checkMinVersion`, `effectiveModel`
  precedence, expanded `classifyAuthBlob`), and the stop-gate verdict
  parser (prompt-injection guard, brace-in-reason handling, fenced
  JSON, malformed input).
- **GitHub Actions CI.** `.github/workflows/ci.yml` runs on Node 20 and
  22: syntax check on every `.mjs`, full test suite, plus a smoke job
  that verifies the dispatcher, status command, and the new
  write-refusal contract end-to-end.
- **`flush()` of `TerminalSanitizer` now drops the held tail entirely**
  (testing turned up that sanitizing-only would leak the bytes after an
  ESC byte from an incomplete sequence). Partial sequences are unsafe
  to emit at all.

### New (P2)

- **`/gemini:purge` subcommand.** Deletes recorded job metadata and log
  files from disk. Optional `--older-than <duration>` filter
  (`30d` / `12h` / `45m` / `60s`). Never touches still-running jobs.
  Useful when local logs may contain sensitive code excerpts.
- **Privacy / security section in the README.** Spells out exactly what
  is sent to Google, what stays local, the env-scrubbing allowlist,
  the write-mode gate, and the strict-mode toggle. The README was
  previously written for "developer who already knows what they're
  doing"; now it's also legible for someone deciding whether to install.

### Removed

- `--effort`, `--timeout-ms` and `lastTurnDiff()` were finally cleared
  out in 0.4.3 — listed here only because the audit reraised them.

### Known follow-ups

- A "previous turn" snapshot for the stop-review-gate. The hook still
  uses the working-tree diff as a proxy; faithfully limiting Gemini to
  files touched in the last Claude turn requires a UserPromptSubmit
  hook that snapshots HEAD/index state, which is real engineering work.
- Skill-doc parity with the v0.5.0 changes (the `gemini-prompting` and
  `gemini-cli-runtime` SKILLs do not yet mention `/gemini:purge` or the
  write gate).

## 0.4.5 — Marketplace manifest + env scrubbing

Closes the two issues a real install attempt surfaced:

- **`.claude-plugin/marketplace.json` added.** Without it, the install
  path advertised in the README (`/plugin marketplace add` →
  `/plugin install`) fails because Claude Code has no marketplace
  metadata to register. The new manifest declares this repo as a
  single-plugin marketplace named `gemini-plugin-cc` containing the
  plugin `gemini`. The README now spells out the exact install
  invocation: `/plugin install gemini@gemini-plugin-cc`.

- **Spawned `gemini` process gets a curated environment.**
  `lib/gemini.mjs:cleanGeminiEnv()` returns an allowlisted subset of
  env vars and is now passed to every `spawn`/`spawnSync` call that
  starts `gemini` (cmdAsk, runJob, authProbe, geminiVersion, the
  stop-review-gate hook). The allowlist covers exactly what gemini
  needs: `PATH`, `HOME`, `USER`, locale, terminal, temp dirs,
  XDG state dirs, Gemini/Google auth env vars, and proxy settings.
  Everything else — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
  `OPENAI_API_KEY`, `AWS_*`, `SSH_AUTH_SOCK`, npm internals,
  arbitrary user secrets — is dropped. This narrows the blast radius
  if `@google/gemini-cli` (or any of its deps) is ever compromised by
  a supply-chain attack: the process still works, but secrets
  unrelated to its task no longer travel with it. Verified the
  existing OAuth flow still authenticates after scrubbing — gemini's
  config under `~/.gemini` is reachable via `HOME` alone.

## 0.4.4 — Refactor + ANSI/OSC sanitization

Closes the two follow-ups left over from v0.4.3 — the duplicated job-running
boilerplate and the deferred terminal-injection hardening.

- **Shared `runJob()` helper.** `cmdReview` and `cmdTask` used to duplicate
  ~40 lines of intricate background-job plumbing (fd setup, spawn,
  streaming, status transitions, cancellation race handling, error
  surfacing). The shared helper makes it impossible for one to drift
  away from the other in subtle ways — the missing `detached: true` on
  cmdReview that we fixed in v0.4.3 was a direct symptom of that drift.
  Both commands now delegate to one place. Callers receive `{ code,
  outBuf, errBuf }` and own only their own post-processing (JSON
  unwrapping for review, footer for task).
- **ANSI / OSC sanitization on terminal output.** A hostile diff or
  document fed into Gemini could trick it into echoing terminal control
  sequences — color codes, cursor moves, OSC title-bar updates, OSC 52
  clipboard writes — into the user's terminal. New
  `lib/render.mjs:TerminalSanitizer` strips:
    - CSI sequences (`ESC [ ... <0x40-0x7e>`)
    - OSC sequences (`ESC ] ... BEL` or `ESC \\`)
    - DCS / PM / APC / SOS strings
    - Single-shift / private 2-byte intros
    - Dangerous C0 control bytes (NUL, BS, BEL, VT, FF, SO/SI, DLE-SUB,
      ESC, FS-US, DEL). Tab, newline, and CR are kept.
  The sanitizer is **stream-aware** — it holds back any incomplete
  escape sequence at a chunk boundary and resumes parsing on the next
  chunk, so a sequence split across two reads cannot leak through.
  Wired into:
    - `cmdAsk` stdout/stderr (`spawnSync` result)
    - `runJob` live stdout streaming (review, task)
    - `cmdResult` stdout/stderr read-from-disk path
  Disk logs are **not** sanitized — raw bytes are kept for debugging.
  Only the live streams that hit the terminal are filtered.
- **Async dispatch.** `main()` is async and awaits the new
  `cmdReview` / `cmdTask` / `cmdCancel` promises so unhandled-promise
  warnings (or premature exits) cannot occur on subcommand failure.

## 0.4.3 — Bug-fix pass after dual Codex+Gemini review

Both Codex (via `codex:codex-rescue`) and Gemini (via this plugin's own
`task` runtime, dogfooded) produced independent reviews and converged on
the same top-3 high-impact bugs. This release fixes those plus a handful
of P1s caught by one or the other:

- **Cancel race fixed.** `terminateProcessTree` now returns a Promise that
  resolves only after the SIGKILL escalation step. `killJob` is async and
  awaited from `cmdCancel`; previously `process.exit(0)` was called
  synchronously after scheduling SIGKILL via `setTimeout`, so a Gemini
  process that ignored SIGTERM survived as an orphan while the job state
  was written as "cancelled". Also: `killJob` now writes the cancelled
  status BEFORE the kill so the close handler does not race-overwrite it
  with "failed". (`scripts/lib/process.mjs`, `scripts/companion.mjs`)
- **Review jobs now spawn detached.** `cmdReview` was missing
  `detached: true`, which made `process.kill(-pid)` fail with ESRCH on
  cancellation and orphan any grandchildren the Gemini CLI spawned. Now
  matches `cmdTask`. (`scripts/companion.mjs`)
- **JSON schema-mismatch fallback emits unwrapped payload.** When
  `validateReviewSchemaShallow` rejected Gemini's output, the previous
  code wrote the raw CLI wrapper `{ session_id, response, stats }` to
  stdout — guaranteed to break any downstream consumer that expected
  the review schema. Now writes the unwrapped `parsed` object. Also: the
  JSON path re-reads the full stdout from disk before parsing, so a
  payload near the in-memory 256KB cap no longer corrupts the parse.
  (`scripts/companion.mjs`)
- **Branch-review base errors now hard-fail.** A typo in `--base <ref>`
  used to silently produce a clean-review message. `cmdReview` now
  surfaces `no-base` and `bad-ref` as exit-2 errors with actionable
  messages. (`scripts/companion.mjs`)
- **`/gemini:result` confines log reads to the jobs directory.**
  New `safeJobLogPath()` helper rejects any `stdout_path`/`stderr_path`
  that resolves outside the workspace's jobs dir. Defense-in-depth
  against tampered job metadata.
- **`isAlive` distinguishes EPERM from ESRCH.** A process owned by a
  different uid no longer registers as dead, so the session-lifecycle
  hook stops reaping legitimate jobs in shared-fs setups.
  (`scripts/lib/process.mjs`)
- **Stop-review-gate hook caps its buffers.** Previously
  `stop-review-gate-hook.mjs` accumulated Gemini's stdout/stderr without
  a cap inside a 12-minute window — a runaway Gemini process could OOM
  the hook. Now capped at 256KB per stream.
- **Setup auth source no longer lies on failure.** `detectAuthSource()`
  used to claim `settings.json (oauth)` as a default whenever no env
  vars were set, even when no auth was configured at all. The setup
  output now omits the source when the probe fails.
- **Removed dead/misleading flags.** `--effort` and `--timeout-ms` were
  parsed but never forwarded to Gemini. Removed from `COMMON_VALUE_FLAGS`
  along with the corresponding paragraph in `gemini-prompting/SKILL.md`.
  Also removed `lastTurnDiff()` (exported but unused).
- **Quoting fix in `commands/setup.md`.** Was the only command file with
  unquoted `$ARGUMENTS`; brought into line with the others.
- **Argument hints updated.** `/gemini:review` now lists `--json` and
  `--wait`/`--background`; `/gemini:adversarial-review` now lists
  `staged`/`unstaged` scopes and `--wait`/`--background`.
- **Skill doc model guidance corrected.** `gemini-prompting/SKILL.md`
  used to tell rescue subagents "the CLI's default is fine" for model
  selection. The plugin actually pins `gemini-3.1-pro-preview` on every
  call. Updated to match reality.

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
