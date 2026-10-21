# omd_tool_absorb

When the model asks for several reads at once, such as a few `sed -n`, `cat` and `rg` commands in one response,
this runs them as one merged step. A read that appears twice in the response runs once. Inside a code-mode cell, a
file read that was already done is reused while the file is unchanged.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_tool_absorb
```

## Use it

There is nothing to run. `/absorb` shows the merged batches in this thread, how many duplicate reads were skipped
and which host call ran each read.

| Setting | Default | What it does |
| --- | --- | --- |
| `max_calls` | `4` | Distinct reads in one merged step (2 to 8). A larger response is split into several steps. |

## What it merges

- Only a response whose calls are all reads. One write, or any other tool, leaves the whole response to Codex.
- `exec_command` running `cat`, `head`, `tail`, `wc`, `ls`, `grep`, `rg`, `sed -n N,Mp`, or `git status`, `diff`, `log`, `show`, `blame`, `ls-files` or `rev-parse`. Each command
  has a short list of allowed options: `tail -f`, `rg --pre`, `git --output` and every unlisted option keep the
  call out.
- File readers need a named file, `grep` and `rg` a pattern and a path, and `-` or `/dev/` operands are refused, so
  a merged read never waits on input.
- Commands with pipes, redirects, `;`, `&&`, line breaks, variables, substitutions, globs or `~`, and calls that
  choose a shell, ask for a terminal or ask for more permissions, are never merged.
- Git still runs any external diff or text conversion program your repository configures, as it would without
  this mod.
- In a code-mode cell it reuses only `cat`, `head`, `tail`, `wc` or `sed -n` on named files inside the repository,
  each at most 1 MB, that finished with exit code 0, up to 32 KB per read, only when every file's SHA-256 is
  unchanged and only within the same cell. The cell gets the same structured result the first read got, including
  its chunk ID and wall time. An identical read started while the first is still running, such as inside one
  `Promise.all`, waits up to 2.4 seconds for it and runs on its own after that.
- Reuse keeps short-lived entries in the mod's repository store; it clears them when the next cell starts and
  drops other sessions' entries after a minute.

## Needs and limits

- Each read still runs through Codex with its own call ID, permissions, approvals, sandbox, accounting and result
  record, and the model gets each read's own output and success.
- Merged reads run one after another, not in parallel, so a merged step can take longer than the same reads run
  directly. It saves repeated work and context, not time.
- A merged step holds about 128 KB of output and at most 8 distinct reads. A read whose output doesn't fit still
  runs, and the model is told to run it again on its own.
- A duplicate read is answered with a pointer to the first one's output rather than a second copy.
- Reads issued one at a time are left alone, and reads inside code-mode cells are never merged, since code mode
  already runs a cell's reads as one step. Models that work through code mode, as current GPT models do, get only
  the code-mode reuse, which adds about 25 ms to each code-mode file read it checks.
- It needs an OMD host with `tool_batch_success_v1` and `code_mode_values_v1`; an older host refuses to turn it on.
