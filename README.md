# gemini-plugin-cc

Claude Code plugin that lets you call Google's Gemini from inside a Claude Code session — for code review, adversarial review, and task delegation. Modeled on `openai/codex-plugin-cc`.

## What you get

| Slash command | What it does |
|---|---|
| `/gemini:setup` | Verify the local `gemini` binary, Node, npm, and authentication. Optionally bootstrap install via npm. |
| `/gemini:ask <question>` | Ask Gemini a one-off question (read-only). |
| `/gemini:review` | Review uncommitted changes (working-tree, staged, or branch diff). Foreground or background. |
| `/gemini:adversarial-review` | Like `/gemini:review` but Gemini is told to challenge the design and surface failure modes. |
| `/gemini:rescue <task>` | Delegate investigation, debugging, or a substantial task to Gemini via the `gemini-rescue` subagent. |
| `/gemini:status [job-id] [--all]` | List active and recent Gemini jobs in this workspace. |
| `/gemini:result [job-id]` | Show the stored output of a finished job. |
| `/gemini:cancel [job-id]` | Cancel an active background job. |
| `/gemini:purge [--older-than 30d]` | Delete recorded job metadata + log files from disk. |

## Architecture

```
gemini-plugin-cc/
├── .claude-plugin/plugin.json     ← manifest (name, version, author)
├── agents/
│   └── gemini-rescue.md           ← thin forwarding subagent for /gemini:rescue
├── commands/                      ← slash command frontmatter + Claude instructions
│   ├── setup.md  ask.md  review.md
│   ├── adversarial-review.md  rescue.md
│   └── status.md  result.md  cancel.md
└── scripts/
    └── companion.mjs              ← single Node entrypoint, all subcommands
```

All slash commands invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" <subcommand>`. The companion handles:

- subprocess management of the `gemini` CLI
- diff capture (working-tree / staged / branch)
- review prompt construction (standard vs adversarial)
- background job tracking under `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/`
- auth-failure classification with actionable hints

## Requirements

- macOS or Linux
- Node.js 20+ and npm (matches CI matrix; `package.json` declares `engines.node`)
- Gemini CLI: `npm install -g @google/gemini-cli`
- Authentication, choose one:
  - Run `!gemini` once and complete the Google OAuth flow
  - Set `GEMINI_API_KEY` (free key from https://aistudio.google.com/app/apikey)

## Model

By default the plugin pins every Gemini invocation to `gemini-3.1-pro-preview`
(the strongest Pro tier as of 2026-04). To override:
- `--model <id>` per call: `/gemini:ask --model gemini-2.5-pro <question>`
- `GEMINI_PLUGIN_MODEL=<id>` env var (in `~/.claude/settings.json` under `env`)
- Edit `DEFAULT_MODEL` in `scripts/lib/gemini.mjs`

`/gemini:setup` reports the currently active model.

## Try it without installing

```
git clone https://github.com/taibaran/gemini-plugin-cc.git
claude --plugin-dir ./gemini-plugin-cc
```

Then inside Claude Code:

```
/gemini:setup
/gemini:ask explain monads in three sentences
/gemini:review
/gemini:rescue investigate why the build is slow
/gemini:status
```

## Install permanently from GitHub

```
/plugin marketplace add taibaran/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/reload-plugins
```

The repo's `.claude-plugin/marketplace.json` declares this as a single-plugin
marketplace named `gemini-plugin-cc`, hence the `gemini@gemini-plugin-cc`
reference above. The first command pulls the marketplace metadata; the second
installs the plugin into `~/.claude/plugins/`.

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
- `${CLAUDE_PLUGIN_DATA}/state/<workspace>/config.json` — review-gate toggle.

### Environment scrubbing

The spawned `gemini` process receives an **allowlisted** subset of the
parent environment, not the full env. The allowlist covers `PATH`, `HOME`,
locale, terminal, temp/XDG dirs, Gemini/Google auth vars, and proxy
settings. Everything else — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
`OPENAI_API_KEY`, `AWS_*`, `SSH_AUTH_SOCK`, npm internals — is dropped. If
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

### Terminal-output sanitization

Gemini's stdout is piped through a sanitizer that strips ANSI/OSC escape
sequences (cursor moves, OSC title bars, OSC 52 clipboard writes) and
dangerous C0 control bytes before reaching your terminal. The on-disk log
keeps raw bytes for debugging.

## License

Apache-2.0 (see `LICENSE`).
