# Full-API conformance exercise

Two outside-author packages written against the published `@oh-my-diff/mod-api`
SDK and nothing else. `atlas_policy` replaces the host's coordination and
context decisions; `atlas_console` replaces the terminal and its interactions.
Both are kept at two versions so the supported compatibility path can be
replayed: `1.0.0` on mod API `0.1.0-experimental.5` with state version 1, and
`2.0.0` on `0.1.0-experimental.6` with state version 2 and an explicit `migrate`
handler.

`python3 scripts/mod_full_api_exercise.py` was the historical API 0.1 replay;
the current API 0.2 host rejects these packages. The active authoring gate is
`mise run mods:author-acceptance`.
replays the whole exercise from a clean root: it packs the SDK, scaffolds both
packages with `omd-mod-author create`, copies these sources in, checks, tests,
debugs and packages them, installs them next to the repository-only `counter`
and `service-provider` conformance fixtures as four separate managed packages, runs
`combined-v1.test.json`, upgrades both authored packages through
`package-plan`/`package-apply`, migrates their state, runs
`combined-v2.test.json`, rolls `atlas_console` back in both package and state
form, runs `combined-restored.test.json`, and re-upgrades. It writes a machine-readable
summary, the author identity, the recorded API and documentation gaps, and every
command it ran to the maintainer's retained audit evidence directory.

These packages are exercise artifacts, not part of the shipped SDK or the
release bundle.

## Task and session author exercise

`task_scope` and `session_anchor` target mod API `0.1.0-experimental.8`.
The first selects optional Python and TypeScript checks from host checkpoint
work; the second provides bounded compaction and checkpoint context across
reload. They compose through `task_scope/mod.test.json` without provider calls:

```sh
OMD_MOD_BIN=runtime/omd/target/debug/omd-mod OMD_MOD_NODE="$(mise which node)" node mods/author/cli.mjs test mods/exercise/task_scope
python3 scripts/mod_author_surface_measure.py
python3 scripts/mod_author_surface_upgrade.py
```

The [dated audit](../../.docs/audits/first-class-author-surface-20260922.md)
records the pinned source comparison, exact host checks and measured cost.
These packages remain inactive internal exercises and do not count as
supported first-party mods.
