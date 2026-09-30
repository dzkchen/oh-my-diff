# OMD procedures

Optional plugin `0.1.0-preview.1` with the `omd-procedures` skill and a
separately trusted `omd_procedures` component (`tools`, `commands`, `services`,
`store`, `exec`, `fs.read`, `fs.write`; API `0.2.0-experimental.5`). It turns a task that
completed through `omd_workflow` into a reusable procedure skill. Running a
promoted procedure uses `omd_workflow` for checkpoints, evidence, workers and the
user-selected contract; this package adds no scheduler, hook, background work or
publication.

```sh
codex plugin add omd-procedures@oh-my-diff
omd-mod plugin-component PLUGIN_ROOT
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 tools,commands,services,store,exec,fs.read,fs.write
omd-mod enable STORE COMPONENT_PATH
```

`omd_workflow` must be enabled too; drafting reads its `omd.workflow` status
service.

- `mod_omd_procedures_draft` records a draft in repository-scoped mod storage.
  The objective and acceptance criteria are copied from the completed task, with
  each declared input example replaced by `{{input}}`. It records the source
  acceptance, candidate and evidence digests and the task's failed hypotheses.
- `/omd_procedures:promote NAME` is the only write. It creates the package
  directories with a write-mode `mkdir -p` (host transactions do not create
  directories), then writes
  `omd-procedures/NAME/.codex-plugin/plugin.json` and
  `omd-procedures/NAME/skills/NAME/SKILL.md` and lists the plugin in
  `omd-procedures/.agents/plugins/marketplace.json`, in one host transaction
  that fails if any of those files changed since it read them. Versions start at
  `1.0.0` and each promotion takes the next minor version above both the
  recorded and the on-disk version, so a version is never rewritten.
- `/omd_procedures:list` compares promoted files with their recorded digests
  and reports changed, missing or unlisted packages, plus pending drafts.

Names are lowercase, at most 40 characters and never `omd-*`. Promotion refuses
a name listed with another source, a plugin in `omd-procedures/NAME` that it
did not write, and an unreadable marketplace. The generated plugin contains only
a skill, so installing it runs no code. Codex keeps the installed version until
the user updates it; a task already started keeps its recorded acceptance
criteria, because workflow acceptance is immutable.

Offline component tests cover drafting, promotion, conflicts, version order and
broken-package reports. Real-task reuse is not yet qualified.
