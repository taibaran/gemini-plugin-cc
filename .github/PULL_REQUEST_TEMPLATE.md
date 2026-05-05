## Summary

What changed and why. Two or three sentences is plenty.

## Test plan

- [ ] `npm test` passes (95 tests at time of writing — count goes up if
      this PR adds tests, which most should).
- [ ] Syntax-check passes: `find plugins/gemini/scripts tests -name '*.mjs' -print0 | xargs -0 -n1 node --check`
- [ ] Manual smoke: paste the relevant `/gemini:...` invocation and the
      output you observed.

## Risk

- Anything backward-incompatible? (CLI flag removed, schema changed,
  behavior reordered.)
- Any new external surface? (New file written under
  `${CLAUDE_PLUGIN_DATA}`, new env var read, new spawn call.)
- Security-relevant? (See SECURITY.md for the list of hardened paths
  that need extra scrutiny.)
