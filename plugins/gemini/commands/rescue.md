---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Gemini rescue subagent
argument-hint: '[--background|--wait] [--write|--read-only] [--model <model>] [--timeout <duration>] [what Gemini should investigate, solve, or continue]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gemini:gemini-rescue` subagent via the `Agent` tool (`subagent_type: "gemini:gemini-rescue"`), forwarding the raw user request as the prompt.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- **Default: run the `gemini:gemini-rescue` subagent in the foreground.** A parent agent calling rescue expects a real answer, not a "job forwarded" stub. Backgrounding the subagent causes Claude Code's Bash tool to return immediately with a job ID, which the rescue wrapper would then forward verbatim instead of Gemini's actual output — that's the failure mode tracked in issue #3.
- If the request includes `--background`, the user has explicitly opted out of the synchronous contract; honor it and run the subagent in the background. They are responsible for following up with `/gemini:status` and `/gemini:result <id>` themselves.
- `--wait` is accepted for backward compatibility but has no effect under the new default (foreground is already the default).
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to the companion's `task` subcommand, and do not treat them as part of the natural-language task text.
- `--write` and `--read-only` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task ...` and return that command's stdout as-is.
- Default to read-only Gemini behavior. Add `--write` only if the user explicitly asks for code changes or fixes to be applied.
- Return the companion's stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/gemini:status`, fetch `/gemini:result`, call `/gemini:cancel`, summarize output, or do follow-up work of its own.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`. This subagent only forwards to `task`.
- If the helper reports that Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
