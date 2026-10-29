# omd_tool_absorb

When the model asks for the same read more than once in one response, this runs it once and answers the repeats
with a pointer to the first output. Distinct reads are left to Codex, which runs them in parallel. Inside a
code-mode cell, a file read that was already done is reused while the file is unchanged.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_tool_absorb
```

## Use it

There is nothing to run, and there are no settings. `/absorb` shows the merged batches in this thread, how many
duplicate reads were skipped and which host call ran each read.

## What it merges

- Only a response whose calls are all reads, and only reads that appear at least twice with the same tool and arguments (up to 32 such reads per response). A response of distinct reads, one write, or any other tool leaves the whole response to Codex.
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
  each at most 1 MB, whose read finished with exit code 0 and at most 16 KB of output, only when every file's
  SHA-256 is the same before and after the read, and only within the same cell of the session's own thread (not in
  sub-agents). The cell gets the same structured
  result the first read got, including its chunk ID and wall time. An identical read started while the first is
  still running, such as inside one `Promise.all`, waits up to about 25 seconds for it and runs on its own after
  that; the first read's result is still kept for later repeats.
- Relative paths resolve against the thread's current working directory.
- Reuse keeps the shared outputs, file contents included, in the thread's store until the turn ends; a later cell
  also clears the thread's older cells, and deleting the thread removes them.

## Needs and limits

- Each read still runs through Codex with its own call ID, permissions, approvals, sandbox, accounting and result
  record, and the model gets each read's own output and success.
- Distinct reads are never merged: merged reads run one after another, so merging them would only add latency.
- A merged step holds about 1 MB of output. A read whose output doesn't fit still runs, and the model is told to
  run it again on its own. A single read's output is cut at 256 KB, and the cut is marked so the model can read the
  rest.
- A duplicate read is answered with a pointer to the first one's output rather than a second copy; a duplicate of a
  read whose output didn't fit or that couldn't run gets that read's note.
- Reads issued one at a time are left alone, and reads inside code-mode cells are never merged, since code mode
  already runs a cell's reads as one step. Models that work through code mode, as current GPT models do, get only
  the code-mode reuse, which added about 14 ms to each code-mode file read it checks in our runs.
- It needs an OMD host with `tool_batch_success_v1` and `code_mode_values_v1`; an older host refuses to turn it on.
