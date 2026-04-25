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
- Node.js 18+ and npm
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

## Install permanently (after publishing to GitHub)

```
/plugin marketplace add taibaran/gemini-plugin-cc
/plugin install gemini@<marketplace-name>
/reload-plugins
```

## License

Apache-2.0 (see `LICENSE`).
