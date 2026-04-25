---
description: Check whether the local Gemini CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate] [--json]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json $ARGUMENTS
```

If the result says Gemini is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Gemini now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Gemini CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @google/gemini-cli
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json $ARGUMENTS
```

If Gemini is already installed or npm is unavailable:
- Do not ask about installation.

If Gemini is installed but not authenticated, the JSON `nextSteps` will spell out the two options. Present them to the user verbatim. The two valid options are:

1. Run `!gemini` once and complete the Google OAuth flow.
2. Set `GEMINI_API_KEY` (free key from https://aistudio.google.com/app/apikey) — either inline (`export GEMINI_API_KEY=...`) or in `~/.claude/settings.json` under `env`.

Output rules:
- Present the parsed setup output as a short status block to the user.
- If `actionsTaken` is non-empty (review gate was toggled), surface that.
- If `nextSteps` is non-empty, surface it.
- If `ready: true` and no actions/steps, just confirm success.
