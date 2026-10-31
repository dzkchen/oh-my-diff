# omd_programmable_context

Gives the model a Python workspace that lasts through the session, where it can load files, keep results and hand work
to child agents. It also stores a versioned set of notes, memories, skills and agent specs (the session harness) that
the model can propose changes to. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_programmable_context
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

It needs the `omd-code-execution` plugin's `python` kernel. Set that up first, as its
[README](../../../plugins/bundled/oh-my-diff/plugins/omd-code-execution/README.md) describes.

## Use it

| Command | What it does |
| --- | --- |
| `/refine` | Show the pending harness proposal's diff |
| `/refine apply` | Apply the pending proposal |
| `/refine reject` | Drop the pending proposal |
| `/refine rollback [vN]` | Restore one of the last 16 versions as a new version |
| `/refine promote project\|personal` | Merge the session's harness changes into the project or personal harness for future sessions, after you confirm |

The model uses everything else itself, from code-mode cells (Python it runs through the `omd-code-execution` plugin).
You don't run it.

### Python REPL

This section describes what the model can call. You don't need it to use the mod.

The mod builds on the `omd-code-execution` plugin's persistent Python kernel and its authenticated tool bridge. In a
code-mode cell the model runs `exec(tool("mod_omd_programmable_context_python_api", {})["source"])` once, then:

- `rlm.load(*paths)` reads up to 8 files (60,000 bytes in total) as `Var` strings carrying `sha256` and `sources`.
  Larger requests are refused before reading. Use `rlm.sh` for line ranges of large files.
- `rlm.keep(name, value, sources)` saves a text variable of up to 32 KiB in thread storage, with up to 8 distinct
  sources. A loaded `Var`'s own `path@sha256` counts as one. `rlm.vars()` lists kept variables, and
  `rlm.restore(name)` returns one after a kernel restart or compaction.
- `rlm.spawn(prompt, role, spec, route, workspace, tools)` starts a real child agent through `agents.spawn` and returns
  an `Agent` with `wait`, `result`, `send`, `cancel` and `integrate`. Role, workspace, tools and route default to the
  stored spec, then `worker` and `read_only`. `rlm.map(prompts)` spawns and waits for several. The host handles
  admission, allowances, isolation, messages, cancellation, usage and integration conflicts.
- `rlm.complete(prompt)` runs one tool-less `model.complete` call.
- `rlm.sh(cmd)` and the kernel's `tool(name, arguments)` call the tools the current cell may use, under the same
  permissions.

Without a configured `route`, child agents and completions use the first available worker route that lists this mod.
If the kernel, the plugin or this mod is missing, turned off or broken, the model continues with ordinary tools.

### Session harness

Each session keeps versioned notes, memories, skill descriptions and reusable agent specs
(`rlm.spawn(..., spec="name")`) as changes over the promoted project and personal harnesses. Removing a promoted entry
hides it for the session. The mod adds them, with a usage hint, as a developer message at the start of each lead
request. It adds the kept-variable list (name, size and digest; `rlm.vars()` returns sources) as a short developer
message just before the newest item, so keeping a variable doesn't change the cached prefix. These messages are part
of the request only: the transcript and the base system prompt are unchanged, and compaction can't drop them.

The model proposes up to four changes with a reason and evidence references through `rlm.refine`. The `refine`
setting decides what happens to a proposal. Every applied change creates a new version with before and after
snapshots. `/refine promote project|personal` shows the session's additions, edits and removals against that scope's
stored harness, asks for confirmation, then merges them for future sessions in this repository or for this user,
keeping other stored entries. To remove a promoted harness, run:

```sh
omd store reset --mod omd_programmable_context --scope repository
```

Use `--scope user` for the personal harness.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `refine` | `manual` | `manual`: a proposal waits for `/refine apply` or `/refine reject`. `auto`: proposals apply to the session immediately. `off`: proposals are refused. |
| `route` | empty | Worker route for child agents and completions. Empty uses the first available worker route that lists this mod. |

## Needs and limits

- It asks to add `/refine` and a tool the model calls from code cells, read workspace files, start child agents and
  model calls on a worker route, add its harness and variable list to each model request, show proposals and ask you to
  confirm, and keep its state. The capabilities are `commands`, `tools`, `fs.read`, `agents`, `model`, `history`,
  `terminal`, `lifecycle`, `inventory` and `store` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- It needs the `omd-code-execution` plugin with its `python` kernel configured, and code mode on.
- Detached or background sessions, heartbeats, schedules and autonomous continuation are out of scope.
- A session stores at most 32 kept variables. Their index must fit in 48 KiB, and each complete serialized record in
  64 KiB.
- Text and provenance are stored together under a content digest before the name index is updated, so an interrupted
  save preserves the earlier value. Keeping a name again deletes its old record unless another name shares it. Restore
  verifies the record and text digests.
- Kept variables are text only, and importable Python helpers aren't stored. The persistent kernel already keeps
  functions the model defines, and replaying stored model-written code into later kernels would bypass review.

## More

- [`omd-code-execution` plugin](../../../plugins/bundled/oh-my-diff/plugins/omd-code-execution/README.md)
- [Plugins](../../../plugins/README.md)
- [Included mods](../../../docs/collection.md)
- Credit: behavior inspired by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (`e75f59efc6f7`,
  `prime-agent-runtime/src/rlm/repl.md` and `skills/refine/SKILL.md`). No code is copied.
