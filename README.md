# mend

`mend` applies an edit that an AI model wrote to a tree of text files. It reads four
formats — a unified diff, SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON — and it either applies the whole patch to every file or writes
nothing at all.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ayoobekerja8-sys/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ayoobekerja8-sys/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

## Running it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is a path relative to the working directory; when it is absent or `-`, the
  patch comes from standard input.
- `--format=NAME` picks one of `unified`, `search-replace`, `v4a` or `json`; the default
  `auto` detects the format from the patch text.
- `--check` reports what would change and writes nothing.
- `--strict` matches lines exactly, with no tolerance for trailing or leading whitespace.

Options and the patch path may come in any order, and `--` ends option parsing.

## What it guarantees

Every path an edit names is checked before anything else, and a path that escapes the
tree, starts with `/`, or holds a backslash is refused. Edits run in the order the patch
gave them, each seeing the tree as the earlier ones left it. A failed edit changes
nothing and never stops the edits after it, so one run reports every failure. If any
edit fails, no file is written at all.

Exit codes: `2` for a usage, patch-read, format-detection or parse problem, `1` when an
edit fails, `0` when the tree is written.

## Layout

- `main.ts` — the whole CLI, Node 22 and the standard library alone.
- `runner.ts` — the kit's trial runner, unchanged.
- `check.ts` — runs the local practice set against `main.ts`.
- `SPEC.md` — the contract this program implements.

Licensed under the MIT license; see `LICENSE`.
