---
description: Run a Gemini review that challenges the implementation approach and design choices
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--model <model>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Gemini review through the shared companion.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size as in `/gemini:review` and recommend background unless the diff is clearly tiny.
- Use `AskUserQuestion` exactly once with the two options, recommended first:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly. Do not weaken the adversarial framing.
- It supports working-tree review, branch review, and `--base <ref>`.
- Unlike `/gemini:review`, it can take extra focus text after the flags.

Foreground flow:
- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review "$ARGUMENTS"
```

- Return the command stdout verbatim. Do not paraphrase, summarize, or add commentary.

Background flow:
- Launch the review with `Bash` in the background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Gemini adversarial review",
  run_in_background: true
})
```

- Do not call `BashOutput`. After launching, tell the user: "Gemini adversarial review started in the background. Check `/gemini:status` for progress."
