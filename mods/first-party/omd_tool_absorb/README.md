# omd_tool_absorb

When the model asks for several reads at once, such as a few `sed -n`, `cat` and `rg` commands in one response,
this runs them as one merged step. A read that appears twice in the response runs once.

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
- `read_file`, `list_dir` and `grep_files`, and `exec_command` running `cat`, `head`, `tail`, `wc`, `ls`, `grep`,
  `rg`, `sed -n N,Mp`, or `git status`, `diff`, `log`, `show`, `blame`, `ls-files` or `rev-parse`. Each command
  has a short list of allowed options: `tail -f`, `rg --pre`, `git --output` and every unlisted option keep the
  call out.
- File readers need a named file, `grep` and `rg` a pattern and a path, and `-` or `/dev/` operands are refused, so
  a merged read never waits on input.
- Commands with pipes, redirects, `;`, `&&`, line breaks, variables, substitutions, globs or `~`, and calls that
  choose a shell, ask for a terminal or ask for more permissions, are never merged.
- Git still runs any external diff or text conversion program your repository configures, as it would without
  this mod.

## Needs and limits

- Each read still runs through Codex with its own call ID, permissions, approvals, sandbox, accounting and result
  record, and the model gets each read's own output. Codex marks the merged step itself as one success.
- Merged reads run one after another, not in parallel, so a merged step can take longer than the same reads run
  directly. It saves repeated work and context, not time.
- A merged step holds about 128 KB of output and at most 8 distinct reads. A read whose output doesn't fit still
  runs, and the model is told to run it again on its own.
- A duplicate read is answered with a pointer to the first one's output rather than a second copy.
- Reads issued one at a time, or inside code-mode cells, are left alone. Code mode already runs a cell's reads as
  one step, and a reused read there can't return the structured result code mode gives the cell.
