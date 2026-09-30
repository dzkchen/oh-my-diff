---
name: omd-procedures
description: Turn a completed OMD workflow task into an explicitly promoted, versioned procedure skill packaged as a repository plugin.
---

# OMD procedures

Use this skill only when the user asks to reuse a procedure that just succeeded.
It needs the separately trusted `omd_procedures` component and the `omd_workflow`
mod, and the task in this thread must have completed through `mod_omd_workflow_complete`.

1. Call `mod_omd_procedures_draft` with a short lowercase `name`, a one-line
   `description`, the ordered `checkpoints` that produced the result,
   `worker_guidance` (scope, paths and brief for delegated work, or `""` when
   no worker is needed; the solo contract allows none), `recovery` steps that
   fixed problems in the source task, and `inputs`. Each input names a value
   that changes between uses and gives its literal `example` from the task
   objective or acceptance criteria; the draft replaces it with `{{name}}`.
   The objective and acceptance criteria always come from the completed task.
2. Show the user the draft and ask them to run `/omd_procedures:promote NAME`.
   Never promote on the user's behalf. Promotion writes a skill-only plugin to
   `omd-procedures/NAME` and lists it in `omd-procedures/.agents/plugins/marketplace.json`.
   It installs, trusts and enables nothing.
3. The user installs it explicitly with `codex plugin marketplace add` and
   `codex plugin add NAME@omd-procedures`. The installed version stays pinned;
   promoting again writes the next version.

`/omd_procedures:list` reports each promoted version and whether its files
changed, disappeared or left the marketplace. Re-promoting the draft repairs a
broken package under a new version. A name held by another plugin or
marketplace entry is refused.
