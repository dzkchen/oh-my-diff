# omd_observation_mask

Long agent runs resend every earlier tool output with each model request. This mod hides older large outputs from
the requests and keeps the model's reasoning, its tool calls and the newest outputs. Each hidden output becomes a
one-line note: the tool, its size, its exit code, its first line and how to read it in full. It also works in
`codex exec`. It's experimental, and neither OMD+ nor OMD Core installs it.

The idea follows "The Complexity Trap" (JetBrains, arXiv 2508.21433), which reports that on SWE-bench Verified,
replacing old tool outputs with a placeholder cut cost roughly in half while keeping a similar solve rate, and did
about as well as summarizing them with a model. See also this mod's [benchmark](../../../docs/benchmarks/harness-mods.md)
with the other harness mods.

## Turn it on

```sh
omd install omd_observation_mask
omd mods enable omd_observation_mask
```

Turn it on in the shell or `/mods` before a `codex exec` run: a headless run can't show the trust dialog, so a mod that
isn't trusted yet stays off.

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

You don't need to run anything. `/mask` shows how many outputs it hid and in how many batches, about how many tokens
each request no longer resends, how much is waiting for the next batch, and how often something else changed the start of the prompt.

The model reads a hidden output with `mod_omd_observation_mask_recall {call_id}`, 32 KB at a time. If it passes
`pin: true`, the output goes back in place from the next request and is never hidden again.

### What it hides

- Only tool outputs, and only outputs older than the newest `keep_recent`. The calls themselves stay, so the model
  still sees what it ran.
- Never an output under `min_bytes`, a failed edit (`apply_patch`, a mod edit tool, or a shell command that edits
  files in place with `sed -i` or `perl -i`, or copies or moves them), a pinned output, the current input, or anything in a subagent's requests.
- It hides outputs in batches to protect the provider's prompt cache. Hiding an output changes the start of the
  prompt, so the cache misses once for everything after it. Outputs that could be hidden wait until together they
  reach `batch_bytes`, and then all of them are hidden at once. A hidden output keeps the same note on every later
  request, so between batches the start of the prompt stays the same.
- The note's first line skips the command header (chunk id, wall time, exit code, token count).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `keep_recent` | `10` | The newest tool outputs that are always sent in full |
| `min_bytes` | `1024` | Smaller outputs are never hidden |
| `batch_bytes` | `32768` | Hide nothing until the outputs that could be hidden reach this size (about 8,000 tokens); `0` hides each one as soon as it's old enough |

Fractional values are rounded down; a negative or non-number value uses the default.

A larger `batch_bytes` breaks the cache less often and makes each break count for more. Use `0` with a provider
that doesn't cache prompts.

## Needs and limits

- It asks to edit the history sent to the model, see tool results and model requests, add a tool and `/mask`, and
  keep data in thread storage. The capabilities are `history`, `interception`, `middleware`, `tools`, `store` and
  `commands` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- The full text of each output of at least `min_bytes` is kept as the mod's evidence when the call finishes. The host
  keeps the newest 1,024 of these per repository (256 MB at most), so recalling a very old output can fail. The
  model is then told to run the call again. It remembers the newest 400 kept outputs of a thread.
- Code-mode calls inside a cell aren't kept on their own: the whole cell's output is hidden and recalled as one.
- Only one mod can edit model-bound history, so it can't run alongside another mod that does, such as
  `omd_programmable_context`.
- Codex's history view covers the newest 2,048 items. Older hidden outputs past that point are sent in full again.
- The count of other prompt-start changes covers instructions and context, not tool outputs. The mod's own batches
  are counted separately.
- It needs an OMD host with model-bound history and kept tool outputs (host features `history_v1` and
  `tool_original_v1`).

## More

- [Included mods](../../../docs/collection.md)
- [History reference](../../reference/history.md) and [tools reference](../../reference/tools.md)
