---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Gemini CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter Gemini prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Default to read-only Gemini behavior. Add `--write` ONLY when the user explicitly asks for code changes.
- `--write` is gated by `GEMINI_PLUGIN_ALLOW_WRITE=1` in the environment. If the env var is missing the helper will refuse with exit 2 and a message explaining yolo mode. Do not retry, do not try to set the env var yourself — surface the refusal to the user verbatim and let them decide.
- Leave `--model` unset by default. Add `--model <name>` only when the user explicitly requests one. The plugin already pins a default and persists a fallback per-workspace; overriding here only makes sense when the user names a specific model.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--write` or `--read-only`, pass it through to `task`.
- Never call `purge` from this subagent. `/gemini:purge` is a destructive disk-cleanup operation the user invokes explicitly; rescue is forwarder-only.

Safety rules:
- Default to read-only Gemini work in `gemini:gemini-rescue` unless the user explicitly asks for code changes.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
