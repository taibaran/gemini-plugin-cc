---
name: Bug report
about: Report something the plugin does wrong
title: "[bug] "
labels: bug
---

## Versions

- Claude Code: <!-- run `claude --version` or check the IDE plugin -->
- Plugin (`/gemini:setup` reports it): <!-- e.g. 0.5.5 -->
- `gemini --version`:
- Node: <!-- `node --version` — should be ≥ 20 -->
- OS: <!-- macOS 14, Ubuntu 22.04, etc. -->

## What you tried

The exact slash command (or sequence) you ran. Include any flags.

```
/gemini:...
```

## What you expected

…

## What actually happened

Paste the full output, including stderr if any. Redact anything from your
own code or env that you'd rather not share — but don't drop the framing
lines (`[gemini-plugin] ...`) since those tell us which code path fired.

## Reproducer

If the bug only happens in your repo, the smallest delta from a fresh
`git init` that reproduces it. If it doesn't repro on a fresh repo,
that's also useful info — say so.

## Anything else

Logs from `${CLAUDE_PLUGIN_DATA}/state/<workspace>/jobs/<id>.stderr.log`,
screenshots if it's a UI quirk, etc.
