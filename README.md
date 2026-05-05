# gemini-plugin-cc

[![CI](https://github.com/taibaran/gemini-plugin-cc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/taibaran/gemini-plugin-cc/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

Run Google's Gemini from inside a Claude Code session. Get a second-opinion code review, an adversarial pass that *tries* to break the design, or delegate a long-form research task to Gemini's 1M-token window — all without leaving the editor.

## Why this exists

Claude is good at the code in front of it. But the same model has the same blind spots: same training, same style, same assumptions. A second model with different training catches things the first one missed.

Gemini also has a 1M-token context window, so handing it a whole subdirectory and asking *"what's the failure mode here?"* is a real workflow this plugin makes one slash command.

This project's own CHANGELOG records four review rounds where exactly that loop — Claude wrote, Gemini (and Codex) reviewed, real bugs were found — drove the code.

## Quick start

```
/plugin marketplace add https://github.com/taibaran/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/gemini:setup
```

`/gemini:setup` walks you through installing the Gemini CLI (`@google/gemini-cli`) and authenticating. After it reports `✅ ready`, you can use any of the commands below.

> **Note on the install URL.** Use the full HTTPS URL above, not the shorter `<user>/<repo>` form. The shorter form defaults to SSH (`git@github.com:...`) and fails with `Host key verification failed` unless you've already added `github.com` to `~/.ssh/known_hosts`.

## What you get

| Slash command | What it does |
|---|---|
| `/gemini:setup` | Verify the local `gemini` binary, Node, npm, and authentication. Optionally bootstrap install via npm. |
| `/gemini:ask <question>` | Ask Gemini a one-off question (read-only). |
| `/gemini:review` | Review uncommitted changes (working-tree, staged, or branch diff). Foreground or background. |
| `/gemini:adversarial-review` | Like `/gemini:review`, but Gemini is told to challenge the design and surface failure modes. |
| `/gemini:rescue <task>` | Delegate investigation, debugging, or a substantial task to Gemini via the `gemini-rescue` subagent. |
| `/gemini:status [job-id] [--all]` | List active and recent Gemini jobs in this workspace. |
| `/gemini:result [job-id]` | Show the stored output of a finished job. |
| `/gemini:cancel [job-id]` | Cancel an active background job. |
| `/gemini:purge [--older-than 30d]` | Delete recorded job metadata + log files from disk. |

## Example: review vs. adversarial-review

Same diff, two different framings. From this project's own history (v0.5.4 added a `--timeout` flag):

**`/gemini:review`** — reads like a code review:

> The new `--timeout` flag is wired through `cmdAsk`, `cmdReview`, and `cmdTask` consistently. `parseDuration` accepts the documented forms (`s`/`m`/`h`/`d`). Tests cover the typical paths. Looks good.

**`/gemini:adversarial-review`** — reads like an attacker:

> **BLOCKING.** Node's `setTimeout` silently truncates delays exceeding 2³¹−1 ms (~24.85 days) to ~1ms, with only a `TimeoutOverflowWarning`. `parseDuration("30d")` returns 2.59B ms, so a user passing `--timeout 30d` wraps to ~1ms and the timer fires immediately — the job is mislabeled `timed-out` before it could even start. Clamp to `MAX_SETTIMEOUT_MS = 2_147_483_647` in `resolveTimeoutMs` before passing to `setTimeout`.

Both pass through the same plugin. The prompt template frames the model differently — adversarial mode is in `prompts/adversarial-review.md` and explicitly tells Gemini to default to skepticism, prioritize trust-boundary and concurrency failures, and not give credit for partial fixes or good intent.

The bug above was real. v0.5.5 closes it.

## Try it locally before installing

```
git clone https://github.com/taibaran/gemini-plugin-cc.git
claude --plugin-dir ./gemini-plugin-cc/plugins/gemini
```

Note the `/plugins/gemini` suffix — `--plugin-dir` expects the path that
contains `.claude-plugin/plugin.json`, not the repo root.

## Requirements

- macOS or Linux
- Node.js 20+ and npm (matches CI matrix; `package.json` declares `engines.node`)
- Gemini CLI: `npm install -g @google/gemini-cli`
- Authentication, choose one:
  - Run `!gemini` once and complete the Google OAuth flow
  - Set `GEMINI_API_KEY` (free key from https://aistudio.google.com/app/apikey)

## Model

By default the plugin pins every Gemini invocation to `gemini-3.1-pro-preview`
(the strongest Pro tier as of 2026-04). Override precedence (highest wins):

1. `--model <id>` per call: `/gemini:ask --model gemini-2.5-pro <question>`
2. `GEMINI_PLUGIN_MODEL=<id>` env var (set in `~/.claude/settings.json` under `env`)
3. Workspace `config.activeModel` (set automatically by `/gemini:setup` when the default is unavailable for your account, via a fallback chain)
4. `DEFAULT_MODEL` constant in `plugins/gemini/scripts/lib/gemini.mjs`

`/gemini:setup` reports the currently active model and where it came from.

## Timeouts

Every per-call subcommand accepts `--timeout <duration>`:

```
/gemini:ask --timeout 90s explain monads
/gemini:review --timeout 30m
/gemini:rescue --timeout 0 investigate slow build      # disable
```

Defaults: ask = 5 min, review = 20 min, rescue/task = **unbounded** (rescue
work is open-ended; cancel with `/gemini:cancel <job-id>` if it overshoots).
Accepted forms: `300s` / `5m` / `1h` / `500ms` / bare integer (ms).

Exit code on timeout is **124** (matches `timeout(1)`), distinguishable from
policy refusals (2) and missing-binary (127). Durations exceeding Node's max
setTimeout (~24.85 days) are clamped with a stderr warning so the timer
doesn't silently wrap to ~1ms.

## Privacy & security

This plugin runs Gemini against your local code. Be deliberate about what you
send and where it goes.

### What gets sent to Google

- `/gemini:ask` — your literal question text.
- `/gemini:review` and `/gemini:adversarial-review` — the local `git diff`
  (working-tree / staged / branch — depending on `--scope`), capped at 4 MB.
  Whatever is in that diff is what Gemini sees.
- `/gemini:rescue` and `/gemini:task` — your prompt text. Gemini may also
  read files in the workspace itself (it has its own file-tools); the plugin
  does not pre-load files for it.
- The stop-review-gate hook (when enabled) — the working-tree diff plus a
  short summary of Claude's last message.

### What stays local

- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/<id>.{stdout,stderr}.log` —
  full Gemini output for every backgrounded job. These files contain whatever
  Gemini said back, which can include excerpts of your code. Use
  `/gemini:purge` to delete them; `/gemini:purge --older-than 30d` to delete
  only old ones.
- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/<id>.json` — job metadata
  (timestamps, exit codes, the prompt text, the model used).
- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/config.json` — review-gate toggle
  + persisted fallback model (if any).

### Environment scrubbing

The spawned `gemini` process receives an **allowlisted** subset of the
parent environment, not the full env. The allowlist covers `PATH`, `HOME`,
locale, terminal, temp/XDG dirs, Gemini/Google auth vars, proxy settings,
and `NODE_EXTRA_CA_CERTS` (for corporate TLS-intercepting proxies).
Everything else — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`,
`AWS_*`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`, npm internals — is dropped. If
`@google/gemini-cli` (or any of its deps) is ever compromised, the blast
radius is limited to what gemini actually needs.

### Write mode

`--write` (only on `/gemini:rescue` / `task`) runs Gemini in
`--approval-mode yolo` — it can modify files in this workspace without
per-action confirmation. The plugin **refuses** `--write` unless
`GEMINI_PLUGIN_ALLOW_WRITE=1` is set in the environment. Set it
intentionally, ideally per-workspace via `~/.claude/settings.json`'s `env`
field, only in trees where you accept that an agent can edit files.

### Stop-review-gate strict mode

By default the stop hook **fails open** on infrastructure errors (gemini
missing, auth failed, timeout, parse error) so a broken Gemini install does
not strand your session. To make those failures **block** stop instead, set
`GEMINI_REVIEW_GATE_STRICT=1` in the env. Useful for environments where
"the gate could not run" should be treated as "do not stop yet."

The stop-hook timeout uses `terminateProcessTree` (SIGTERM the process
group, escalate to SIGKILL after 2 s) so a Gemini child that ignores
SIGTERM doesn't strand the hook.

### Terminal-output sanitization

Gemini's stdout is piped through a sanitizer that strips ANSI/OSC escape
sequences (cursor moves, OSC title bars, OSC 52 clipboard writes) and
dangerous C0 control bytes before reaching your terminal. The sanitizer is
stream-aware — escape sequences split across chunk boundaries are held back
until they complete. The on-disk log keeps raw bytes for debugging.

### Concurrent config writes

`config.json` (review-gate toggle, persisted active model) is protected by
an `O_EXCL`-based file lock with stale-lock recovery, so two concurrent
`/gemini:setup` invocations from different shells can't lose each other's
updates.

## Architecture

```
gemini-plugin-cc/
├── .claude-plugin/marketplace.json   ← marketplace metadata at repo root
├── plugins/gemini/                   ← the plugin itself
│   ├── .claude-plugin/plugin.json    ← plugin manifest
│   ├── agents/  commands/  hooks/
│   ├── prompts/  schemas/  scripts/
│   └── skills/
├── tests/                            ← unit tests (node:test, no devDeps)
├── .github/workflows/ci.yml          ← CI matrix Node 20/22 + smoke job
├── CHANGELOG.md  CONTRIBUTING.md  SECURITY.md
└── package.json  README.md  LICENSE
```

The two-level layout (marketplace at repo root, plugin in `plugins/gemini/`)
mirrors the convention used by `openai/codex-plugin-cc` and is what Claude
Code's marketplace schema expects.

All slash commands invoke
`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" <subcommand>`.
`${CLAUDE_PLUGIN_ROOT}` resolves to wherever the plugin is installed
(`~/.claude/plugins/<plugin-id>/`), so the path stays consistent across
local-dev and installed setups. The companion handles:

- subprocess management of the `gemini` CLI
- diff capture (working-tree / staged / branch)
- review prompt construction (standard vs adversarial)
- background job tracking under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/`
- auth-failure classification with actionable hints
- timeout management (SIGTERM → SIGKILL escalation)

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run tests locally and the
quick rules for adding a slash command, and [SECURITY.md](SECURITY.md) for
the threat surfaces that have explicit hardening and how to report issues.

## License

Apache-2.0 (see [LICENSE](LICENSE)).
