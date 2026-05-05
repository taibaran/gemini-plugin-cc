# Contributing to gemini-plugin-cc

Thanks for considering a contribution. The plugin's surface is small, the
test suite is fast, and the bar for review quality is high — your patch
will get attention.

## Quick start

```bash
git clone https://github.com/taibaran/gemini-plugin-cc.git
cd gemini-plugin-cc
npm test       # 95 tests, ~0.3s, no devDeps required
```

To try the plugin locally without installing into Claude Code's marketplace:

```bash
claude --plugin-dir ./plugins/gemini
```

## Before opening a PR

The CI matrix runs Node 20 and 22 plus a smoke test of the dispatcher.
Reproduce it locally:

```bash
# 1. Syntax-check every module the way CI does.
find plugins/gemini/scripts tests -name '*.mjs' -print0 | xargs -0 -n1 node --check

# 2. Run the full suite.
npm test

# 3. Smoke-check the dispatcher directly.
node plugins/gemini/scripts/companion.mjs nonexistent              # exit 2
node plugins/gemini/scripts/companion.mjs status                    # exit 0
node plugins/gemini/scripts/companion.mjs task --write "demo" \
  > /tmp/out.txt 2>&1 ; echo "rc=$?"                                # exit 2 + GEMINI_PLUGIN_ALLOW_WRITE message
```

All three must pass.

## Code conventions

- ESM only (`import` / `export`, `.mjs` extensions). No CommonJS, no
  Babel, no transpile step.
- No external runtime deps. Test deps stay zero too — we use the
  built-in `node:test` runner.
- Prefer adding to `lib/` over expanding `companion.mjs`. The dispatcher
  routes; everything else lives in modules.
- Comments explain **why**, not what. The codebase doesn't carry
  doc-comments on obvious behavior, but unusual decisions get a one- or
  two-line comment with the reasoning.
- New behavior comes with a unit test in `tests/`. The existing tests
  are short, isolated, and use `freshDataDir()` (or equivalent) to
  avoid bleeding state between runs.

## Adding a slash command

1. Add a new file under `plugins/gemini/commands/<name>.md` with
   frontmatter (`description`, `argument-hint`, `allowed-tools`).
2. Add a `cmd<Name>` function in `companion.mjs`.
3. Wire it into the `switch` in `main()`.
4. Update README's command table.
5. Add a unit test if the command has parseable input or a flag-validation path.

## Security-sensitive changes

If your patch touches any of:
- `lib/gemini.mjs` env scrub
- Any path that reads/writes outside `${CLAUDE_PLUGIN_DATA}`
- Any `spawn` call (especially `--approval-mode yolo`)
- Prompt-template substitution (`lib/prompts.mjs`)
- Stop-gate verdict parsing (`lib/verdict.mjs`)

…please describe the threat model in the PR. The CHANGELOG entries for
v0.4.0 and v0.5.0 are good references for the level of detail.

## Commit / release convention

Subject line: `vX.Y.Z: <one-line summary>` for release commits, plain
prose for ordinary commits. Keep history forward-only on `main` (no
amends after push, no force-push). New releases get a Git tag and a
GitHub Release with the matching CHANGELOG section as the body.

## License

By contributing, you agree your work will be released under the
[Apache 2.0 license](LICENSE) that covers the rest of the project.
