# omd_programmable_context

Opt-in OMD+ mod for programmable context and a continual session harness. Its behavior is inspired by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (`e75f59efc6f7`, read 2026-09-29: `prime-agent-runtime/src/rlm/repl.md` and `skills/refine/SKILL.md`; the roadmap's earlier `docs/rlm.md` links no longer resolve). No code is copied. It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

## Python REPL

The mod builds on the `omd-code-execution` plugin's persistent Python kernel and its authenticated tool bridge; enable that plugin's `python` kernel first. In a code-mode cell the model runs `exec(tool("mod_omd_programmable_context_python_api", {})["source"])` once, then:

- `rlm.load(*paths)` reads up to 8 files (60,000 bytes in total) as `Var` strings carrying `sha256` and `sources`. Larger requests are refused before reading; use `rlm.sh` for line ranges of large files.
- `rlm.keep(name, value, sources)` persists a variable up to 32 KiB with its sources in thread storage; `rlm.vars()` lists kept variables and `rlm.restore(name)` returns one after a kernel restart or compaction. A session keeps at most 32. Text and provenance are stored together under a content digest before the name index is updated, so interrupted publication preserves the prior value. Restore verifies the record and text digests. The complete serialized record must fit 64 KiB.
- `rlm.spawn(prompt, role, spec, route, workspace, tools)` (role, workspace, tools and route default to the stored spec, then `worker` and `read_only`) starts a real child agent through `agents.spawn` and returns an `Agent` with `wait`, `result`, `send`, `cancel` and `integrate`. `rlm.map(prompts)` spawns and waits for several. The host owns admission, allowances, isolation, messages, cancellation, usage and integration conflicts.
- `rlm.complete(prompt)` runs one tool-less `model.complete` call.
- `rlm.sh(cmd)` and the kernel's `tool(name, arguments)` call the tools the current cell may use, under the same permissions.

Without a configured `route`, child agents and completions use the first available worker route that lists this mod. If the kernel, the plugin or this mod is missing, disabled or broken, the model continues with ordinary tools.

## Session harness

Each session keeps versioned notes, memories, skill descriptions and reusable agent specs (`rlm.spawn(..., spec="name")`) as changes over the promoted project and personal harnesses; removing a promoted entry hides it for the session. The mod adds them, with the kept-variable list and usage hint, as a developer message at the start of each lead request. That message is part of the request only: the transcript and the base system prompt are unchanged, and compaction cannot drop it.

The model proposes up to four changes with a reason and evidence references through `rlm.refine`. The `refine` setting selects the policy:

- `manual` (default): the proposal waits; `/refine` shows its diff, `/refine apply` applies it and `/refine reject` drops it.
- `auto`: proposals apply immediately to the session.
- `off`: proposals are refused.

Every applied change creates a new version with before and after snapshots. `/refine rollback [vN]` restores one of the last 16 versions as a new version. `/refine promote project|personal` shows the session's additions, edits and removals against that scope's stored harness, asks for confirmation, then merges them for future sessions in this repository or for this user, keeping other stored entries; `omd store reset --mod omd_programmable_context --scope repository|user` removes it.

Detached or background sessions, heartbeats, schedules and autonomous continuation are out of scope. Kept variables are text only, and importable Python helpers are not stored: the persistent kernel already keeps functions the model defines, and replaying stored model-written code into later kernels would bypass review.
