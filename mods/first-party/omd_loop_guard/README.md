# omd_loop_guard

Stops the agent from looping on a call that keeps giving the same answer. When the same tool call with the same
arguments returns the same error three times, or the same output four times, it adds one note to that result telling
the model that repeating it won't help and to change the command or the approach. Neither OMD+ nor OMD Core installs
it.

## Turn it on

```sh
omd install omd_loop_guard
omd mods enable omd_loop_guard
```

It needs no authority grant and works in `codex exec`.

## Use it

- Calls count as the same when the tool and its arguments match, ignoring whitespace. Results count as the same when
  their first 1 KiB and last 512 bytes match, ignoring wall times, chunk ids, durations and `omd-output-budget`
  markers, so a budget excerpt of the same output still counts.
- A different result restarts that call's count. An edit (`apply_patch`, a mod edit tool, a redirect, heredoc, `tee`,
  `cp`, `mv`, `sed -i` or a file write in a command) restarts every count, so rerunning a test after changing code is
  never a loop.
- Each repeated result gets one note, at the third identical error or the fourth identical output.
- `write_stdin`, `wait` and `update_plan` are never counted, since polling the same way is expected, but a held note
  is still added to their output.

## Needs and limits

- It tracks the last 64 distinct calls of a thread. Subagent calls aren't counted.
- In code mode a cell receives its tool's own result, so a note for a call inside a cell is added to the output of the
  cell or the next tool call the model sees.
- It only adds notes; it never refuses a call.

## More

- [Interceptors](../../reference/interceptors.md) in the mod API reference
- [`omd_verify_stop`](../omd_verify_stop/README.md), which asks for tests before the agent finishes
