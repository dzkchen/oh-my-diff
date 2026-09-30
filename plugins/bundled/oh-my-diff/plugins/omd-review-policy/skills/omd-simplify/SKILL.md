---
name: omd-simplify
description: Simplify only changed lines (uncommitted, staged, since a branch, or named files) into smaller, clearer code with identical behavior, then run the relevant checks.
---

# OMD simplify

Work only on changed lines. Use the scope list from `/simplify` when the request has one. Otherwise derive it from what the user asked for: uncommitted changes (`git diff -U0 HEAD` plus untracked files), staged changes (`git diff -U0 --cached`), changes since a branch (`git diff -U0 --merge-base <branch>` plus untracked files) or the named files. New files are in scope entirely; renamed and modified files only in their changed lines. Read surrounding code for context but leave it unedited; mention worthwhile changes outside the scope in the summary instead.

Aim for the smallest, clearest code with exactly the same behavior:

- Keep outputs, errors, side effects, public interfaces and ordering identical. Skip any simplification that might change behavior and say why.
- Follow the repository's agent instructions (`AGENTS.md`, `CLAUDE.md` and similar) and its existing conventions.
- Remove dead code, redundant branches and conditions, needless nesting, duplicated logic and abstractions that earn nothing; reuse existing helpers; use clear names. Keep comments that explain intent.
- Prefer readable code to fewer lines: no clever one-liners or nested ternaries.

Process:

1. Read each file in scope and its changed lines.
2. Apply improvements one file at a time.
3. Run the checks relevant to the changed files: their tests, type checker or linter.
4. If a check fails because of a simplification, undo that simplification. If it already failed before your edits, leave it and report it.
5. Summarize each change and why behavior is unchanged, plus anything you skipped.

Do not add features, fix unrelated bugs or reformat untouched code. If nothing is worth simplifying, change nothing and say so.
