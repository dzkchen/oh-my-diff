# Oh My Diff mod preview

A private preview of three first-party TypeScript mods on the pinned Codex 0.155.1
OMD host, Apple Silicon macOS and Node 24.18.0. You can read, edit and reload
all of them without rebuilding Codex.

| Package | Extension type | What it changes and why a mod is required |
| --- | --- | --- |
| `omd_workspace` | mod | Replaces the live terminal workspace: sidebar panels for the task, remaining acceptance criteria, workers and allowance; header, footer and status line; theme; `F6`/`Alt+r`/`Alt+w`/`Alt+s` keys; message and tool rendering |
| `omd_coordination` | mod | Replaces live coordination and context policy: which configured route leads, what operating brief the model receives, and which evidence a delegated worker is given; exports that bounded preparation to recovery |
| `omd_recovery` | mod | Replaces escalation and delegation dispatch policy: failure classification, eligible tools, advisory-route choice, and whether a host-detected Contributor outage pauses or requests the configured opposite lead |

The checked classification for every bundled package, author example, and
retained conformance fixture is in [EXTENSION_TYPES.md](EXTENSION_TYPES.md).

This is a preview slice, not the release bundle. It is API
`0.1.0-experimental.6`, which is experimental and not frozen. Its finite
cross-release policy is published in [COMPATIBILITY.md](COMPATIBILITY.md).

## Install

Install the private build first ([PRIVATE_BUILD.md](../PRIVATE_BUILD.md)), then
provision the preview into a store that lives outside both this repository and
the repository you will work in:

```sh
OMD_PREFIX="$HOME/.local/share/oh-my-diff/private-build"
OMD_BIN_DIR="$HOME/.local/share/oh-my-diff/bin"
OMD_STORE="$HOME/.local/share/oh-my-diff/mods"

python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" --bin-dir "$OMD_BIN_DIR" \
  preview install --store "$OMD_STORE" --node /absolute/node-24.18.0/bin/node
```

The manager verifies that every pinned source still matches its recorded hash,
that the host and the packages agree on the exact mod API version, and that the
store is outside the repository, the install prefix, the launcher and Codex
state. It then copies the sources, the type declarations and this guide into the
store, trusts each package at its displayed digest with exactly its declared
capabilities, and enables it. Nothing is downloaded and no package script runs.

Add the store to the controlled manifest you pass to `activate omd --mode
enabled` — the command above prints the exact line:

```json
"mods": "/absolute/store"
```

Check the result at any time:

```sh
python3 scripts/private_lean_v1.py --prefix "$OMD_PREFIX" --bin-dir "$OMD_BIN_DIR" \
  preview status --store "$OMD_STORE" --manifest /absolute/manifest.json
```

## First useful task

Start `codex` and run an ordinary repository task. Without changing how you
work you now get:

- a sidebar with the task objective, what the host still considers outstanding,
  live and archived workers, and the remaining request/time/spend allowance;
- `F6` to draft a review prompt and `Alt+r` to send it;
- an operating brief in the model's context naming the active coordination
  policy, and `/omd_coordination:policy` to print it with the decisions it made;
- recovery decisions through `/omd_recovery:policy`; exact failure evidence,
  permissions, attempt limits, worker lifecycle, review and integration remain native;
- `/omd_workspace:activity` for the turn and tool history the mod recorded.

Delegation still runs through the native reviewed contribution path, so
permissions, limits, review, cancellation and accounting are unchanged.

## First customization

Both mods read settings, so the smallest change needs no code:

```sh
OMD_MOD="$OMD_PREFIX/artifacts/omd/omd-mod"

"$OMD_MOD" settings "$OMD_STORE" "$OMD_STORE/sources/omd_workspace" '{"density":"compact","side":"right"}'
"$OMD_MOD" settings "$OMD_STORE" "$OMD_STORE/sources/omd_coordination" '{"lead_policy":"astra","worker_context":"shared_task_packet"}'
"$OMD_MOD" settings "$OMD_STORE" "$OMD_STORE/sources/omd_recovery" '{"failure_policy":"lead_asserted","eligible_tools":["direct","delegation","advisory"],"outage_action":"opposite_lead"}'
"$OMD_MOD" reload "$OMD_STORE"
```

`density`, `side`, `review_prompt` and `syntax` configure the workspace;
`lead_policy` (`sol`, `astra`, `task_entry`), `worker_context`
(`focused_brief`, `shared_task_packet`, `parent_history`) and `evidence` configure
coordination. The shorter `focused`, `shared` and `inherit` values remain accepted
aliases. Settings and reloads take effect at the next turn boundary; the running
task, transcript and composer are preserved. Lead routing applies when a thread
is created or resumed, while worker-context selection is refreshed at each turn
boundary. Recovery accepts a lead-asserted failure class or a fixed
`environment`, `edit`, `diagnosis` or `model` class; `eligible_tools` controls
whether advisory recovery is permitted, and `outage_action` is
`opposite_lead` or `pause`.

`/omd_workspace:layout compact` and `Alt+w` switch density from inside the TUI
without touching a file.

## A substantial change

Edit the TypeScript instead. The sources in the store are yours:

```sh
$EDITOR "$OMD_STORE/sources/omd_workspace/index.ts"

"$OMD_MOD" inspect "$OMD_STORE/sources/omd_workspace"
"$OMD_MOD" trust "$OMD_STORE" "$OMD_STORE/sources/omd_workspace" NEW_SHA256 terminal,commands,lifecycle,state
"$OMD_MOD" enable "$OMD_STORE" "$OMD_STORE/sources/omd_workspace"
"$OMD_MOD" reload "$OMD_STORE"
```

Read the source and the manifest before approving the digest `inspect` prints —
that digest and the capability list are the whole trust decision. An edited
package is disabled until you enable it again, and its settings and state
survive the edit.

`api.d.ts` sits next to the sources in the store. Everything these packages do
is in it: no private symbol, no Rust patch, no Codex rebuild.

## When something breaks

A mod that throws is disabled until you reload it explicitly, and the error
names the file, line and column you edited:

```
omd_workspace: Error: bad panel
    at /absolute/store/sources/omd_workspace/index.ts:118:11
```

The terminal falls back to a native recovery view listing those errors, and the
transcript, composer, cancellation and every native control keep working. Fix
the source and re-trust it, or step out of the way entirely:

```sh
python3 scripts/private_lean_v1.py --prefix "$OMD_PREFIX" --bin-dir "$OMD_BIN_DIR" \
  preview disable --store "$OMD_STORE" --id omd_workspace
```

`preview disable` without `--id` disables all three. Selecting native direct mode
(`activate omd --mode upstream_direct`) or removing `"mods"` from the manifest
also starts a session with no mods loaded at all.

## Remove it

```sh
python3 scripts/private_lean_v1.py --prefix "$OMD_PREFIX" --bin-dir "$OMD_BIN_DIR" \
  preview uninstall --store "$OMD_STORE"
```

This refuses to delete sources you edited unless you pass `--force`, and never
touches the installed build, your Codex state or your manifests.

## What this preview is not

- It is not the release bundle: the curated catalog, author tooling, package
  installation from registries or repositories, and the cross-release
  compatibility matrix are separate release-integration work.
- The API is experimental and may change. Only the rows and finite windows in
  [COMPATIBILITY.md](COMPATIBILITY.md) are supported; arbitrary-version session
  or state interchange is not promised.
- The coordination migration is complete: the TypeScript mod owns fixed versus
  task-entry routing and the delegated-worker context choice. Rust admits only
  configured routes and bounded context policies, records provenance, and keeps
  the native policy as the disabled, missing or broken-mod fallback. The terminal
  package remains a preview migration and its native driver remains available.
- The recovery migration is complete for task-scoped failure classification,
  eligible-tool and advisory-route choice, plus Contributor-outage pause versus
  opposite-lead choice. Rust still captures exact evidence, validates failure
  classes and routes, enforces permissions and limits, owns worker lifecycle and
  snapshots, performs original-route review and conflict-safe integration, and
  keeps native fallback when the mod is disabled, missing or broken.
- A mod cannot change permissions, spending grants, credentials, cancellation,
  accounting, workspace integrity, evidence or the selected workflow contract.
- There is no cost, quality or savings claim here.

Full API reference: [README.md](README.md) and [COVERAGE.md](COVERAGE.md).
