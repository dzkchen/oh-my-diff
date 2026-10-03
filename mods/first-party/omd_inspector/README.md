# omd_inspector

Default-active in OMD+. `/inspect` opens a dialog with the session mode, install
profile, mod counts, the selected workflow contract, task and worker limits and
the paid API cost. `/inspect` again refreshes it and `/inspect close` or Alt+i
closes it. The slash command hops to the mod's own channel handler, which reads
task and contract status with the session.

Capabilities: `agents` (`task.status`), `contracts` (`contract.status`),
`commands`, `store`, `terminal`, `events`.
