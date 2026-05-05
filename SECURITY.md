# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue in `gemini-plugin-cc`, please
**do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/taibaran/gemini-plugin-cc/security/advisories/new)
instead. That keeps the report private until a fix is ready.

You should expect an initial response within **7 days**. If you don't hear
back, ping again in the same private advisory thread.

## In scope

This plugin runs Gemini against your local working tree. The threat surfaces
that have explicit hardening (and where reports are most welcome) include:

- **Env-var leak** to the spawned `gemini` process. Allowlist lives in
  `lib/gemini.mjs:cleanGeminiEnv()`. New entries that should be added
  (e.g., for corporate-proxy support) are normal feature requests; entries
  that should *not* have been added are security issues.
- **Path traversal / log confinement.** Job IDs are validated by
  `lib/state.mjs:isValidJobId`; on-disk log paths are confined to
  `jobsDir/` by `safeJobLogPath`. A path that escapes either is a
  security bug.
- **Prompt injection through user input.** User-controlled strings
  (review focus, transcript snippets) are XML-escaped via
  `lib/prompts.mjs:escapeXmlInTrustedBlock` before they reach a trusted
  prompt block. The stop-gate verdict is parsed as strict JSON
  (`lib/verdict.mjs:parseVerdict`) so a malicious diff cannot fake an
  `ALLOW`/`BLOCK` verdict in free text.
- **Process-tree termination & PID safety.** `lib/process.mjs:isValidPid`
  rejects PID 0/1 (broadcast/init); `terminateProcessTree` always
  signals a process group, never a bare PID.
- **Write-mode gate.** `--write` puts Gemini in `--approval-mode yolo`
  (it can edit files unattended). Refused unless
  `GEMINI_PLUGIN_ALLOW_WRITE=1` is set in the env. Bypassing this gate
  is a security issue.
- **Atomic state writes.** `lib/state.mjs:atomicWrite` uses
  `crypto.randomBytes(12)` + `O_EXCL` to defeat predictable-tmpname
  symlink attacks in shared `/tmp`.
- **Terminal-output sanitization.** ANSI/OSC sequences in Gemini output
  (clipboard hijack, title-bar spoofing, cursor-control attacks) are
  stripped by `lib/render.mjs:TerminalSanitizer` before reaching the
  user's terminal.

## Out of scope

- Issues in the upstream `@google/gemini-cli` or in Google's Gemini API.
  Report those to Google directly.
- Issues in Claude Code itself. Report those to Anthropic.
- Generic CVEs in transitive dev tooling (`node:test`, npm) when no
  exploit path through this plugin exists.

## Disclosure timeline

- Day 0: report received.
- Day ≤7: initial reply with assessment.
- Day ≤30: fix targeted (or status update if more time is needed).
- After fix: coordinated disclosure via GitHub Security Advisory.

## Past security work

The CHANGELOG has the full record. Notable rounds:

- v0.4.0: 12 issues closed across command injection, path traversal,
  prompt-injection bypass, TOCTOU, and DoS vectors.
- v0.5.0: write-mode gate, stop-gate strict mode, env-scrub allowlist.
- v0.5.5: config-write race lock, lifecycle-hook cwd, stop-hook
  process-group termination.
