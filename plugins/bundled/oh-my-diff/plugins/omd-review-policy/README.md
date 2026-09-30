# OMD Review Policy

Codex plugin with review skills, a manifest-gated every-turn review reminder hook and an opt-in `/simplify` command component.

- `omd-review-cadence` and `omd-final-review` choose review cadence and run the final review under the selected contract.
- `omd-simplify` simplifies only changed lines into smaller, clearer code with the same behavior, follows the repository's agent instructions, applies changes file by file and runs the relevant checks, undoing any simplification that breaks them. Use it directly (`$omd-review-policy:omd-simplify`) or through `/simplify`.

## `/simplify`

The `mod/` component (`omd_simplify`, capabilities `commands,exec`) adds the command. Installing the plugin does not run it; inspect, trust and enable it in the mod store you use:

```sh
omd-mod plugin-component PLUGIN_ROOT
omd-mod trust STORE PLUGIN_ROOT/mod INSPECT_SHA256 commands,exec
omd-mod enable STORE PLUGIN_ROOT/mod
```

```text
/simplify                   uncommitted changes, including untracked files
/simplify --staged          staged changes only
/simplify --ref=main        changes since the merge base with main, including untracked files
/simplify src/a.ts src/b.ts only the named files
```

The command runs `git diff -U0` read-only in the session sandbox and submits one turn that names the skill and lists each file's changed line ranges. New and untracked files are in scope entirely; renames follow the new path; deleted files and deletion-only hunks are skipped. With no changes it shows a note and submits nothing; git errors, such as an unknown branch, are shown instead of a turn. Disable with `omd-mod disable STORE PLUGIN_ROOT/mod`.

Ported from [pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) 0.2.3 by Matt Devy (MIT); see [THIRD_PARTY_NOTICES.md](../../../../../THIRD_PARTY_NOTICES.md). Differences: no fallback to the previous commit when nothing changed, untracked files are included, `--ref` compares with the merge base, and the review principles live in the skill rather than the command prompt.
