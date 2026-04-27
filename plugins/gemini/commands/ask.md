---
description: Ask Gemini a one-off question (read-only)
argument-hint: '[--model <model>] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Forward the user's question to the Gemini companion in read-only mode and return the answer verbatim.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" ask "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim. Do not paraphrase or summarize.
- If stderr contains a `[hint: ...]` line about auth, also surface that hint and suggest `/gemini:setup`.
- If `$ARGUMENTS` is empty, ask the user what they want Gemini to answer instead of running the command.
