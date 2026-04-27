---
description: Delete recorded Gemini job metadata and log files (frees disk; removes locally-stored prompts and outputs)
argument-hint: '[--older-than 30d|12h|45m|60s]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Forward to the companion's `purge` subcommand. By default purges every
non-running job; with `--older-than <duration>`, only purges jobs whose
ended (or started) timestamp is older than that.

Raw user input:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" purge "$ARGUMENTS"
```

Output rules:
- Return the companion's stdout verbatim (it prints how many jobs were purged).
- The plugin never deletes job files for still-running jobs — losing the PID
  metadata would orphan the process.
- This deletes locally-stored prompts and Gemini outputs. Use it when those
  may contain sensitive material that should not linger on disk.
