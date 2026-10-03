# omd_coordination

Opt-in; needs `omd_workflow`. It prepares delegated work for the workflow mod:
`delegate` builds a worker brief with the selected context (`worker_context`:
a focused brief with declared evidence paths, the shared workflow task packet,
or frozen parent history) and hands it to `omd.workflow`; `investigate` and
`investigation_result` run a read-only investigation on `investigation_route`.
`lead_policy` names a lead route (`sol`, `astra`) or `task_entry` (the default),
which keeps the thread's own route and leaves the exclusive `routing`
replacement to other mods such as `omd_profiles`.

`/omd_coordination:delegation` shows the effective policy and recorded
decisions. Settings: `lead_policy`, `worker_context`, `worker_context_max_bytes`,
`evidence`, `investigation_route`.
