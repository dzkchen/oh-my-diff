# omd_observation_mask

Long agent runs resend every earlier tool output with each model request. This mod hides older large outputs from the
requests and keeps the model's reasoning, its tool calls and the newest outputs. Each hidden output becomes a one-line
note: the tool, its size, its exit code, its first line and how to read it in full. It also works in `codex exec`. It's off by default in OMD+. OMD Core doesn't include it.

The idea follows "The Complexity Trap" (JetBrains, arXiv 2508.21433), which reports that on SWE-bench Verified,
replacing old tool outputs with a placeholder cut cost roughly in half while keeping a similar solve rate, and did about
as well as summarizing them with a model. See also this mod's [benchmark](../../../docs/benchmarks/harness-mods.md) with
the other harness mods.

## Turn it on

```sh
omd mods enable omd_observation_mask
```

Turn it on in the shell or `/mods` before a `codex exec` run: a headless run can't show the trust dialog, so a mod that
isn't trusted yet stays off.

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

You don't need to run anything. `/hidden_outputs` shows how many outputs it hid and in how many batches, about how many tokens
each request no longer resends, how much is waiting for the next batch, and how often something else changed the start
of the prompt.

The model reads a hidden output with `mod_omd_observation_mask_recall {call_id}`, 32 KB at a time. If it passes
`pin: true`, the output goes back in place from the next request and is never hidden again.

### Hide outputs only when continuing

Set `mode` to `continue` in `/mods` and enable `omd_continue`; OMD+ doesn't enable it, and without it continue mode hides
nothing. `/hidden_outputs` says so until a `/continue` has run in the thread. Ordinary requests then keep new outputs in full.
A successful `/continue [note]` hides an eligible batch only after the estimated cache lifetime has elapsed.
`/continue --compact [note]` requests the same masking without a cache estimate. It still obeys `keep_recent`,
`min_bytes` and `batch_bytes`; it does not call a summarizing model or native `/compact`.

Only outputs whose saved originals pass a read check during the successful `/continue` command can be newly hidden
in this mode. At most 16 unmasked originals from the latest history view are checked per continuation; the following model request
still applies the history eligibility rules. An original that fails the read check stays visible and is skipped on later continuations.
The model receives guidance to recall a specific missing fact in small pages and verify
current files and processes before repeating actions. User messages, instructions and tool calls stay in context.
The mod sends the same placeholders on later requests; another continuation is needed to hide another batch.
Resuming a thread preserves stored placeholders, but drops a pending continuation that had not
reached its first model request.

Cache lifetime is an estimate, not a cache probe. On a ChatGPT plan, with local providers and when the lifetime is
unknown there is no estimate, so only `/continue --compact` hides outputs, and `/hidden_outputs` says so. `auto` uses a provider-reported lifetime, retaining it on reads
for the same provider, route, credential and model. For OpenAI API responses with cache activity it otherwise uses
30 minutes. OpenAI subscription and unpriced responses, local providers, and unknown lifetimes are skipped.
An explicit `cache_ttl_minutes` overrides the estimate except for local providers. Model/provider/route changes
that differ from the observed response skip automatic masking. Compaction clears the estimate.

Keep `omd_idle_compact` disabled if you want context reduction only through `/continue`: its separate timer can
still compact the conversation. This mode does not prepare a summary in the background or guarantee lower cost.

### What it hides

- Only tool outputs, and only outputs older than the newest `keep_recent`. The calls themselves stay, so the model
  still sees what it ran.
- Never an output whose saved original it can't restore (one from before the mod was enabled, or whose original
  couldn't be saved), in either mode.
- Never an output under `min_bytes`, a failed edit (`apply_patch`, a mod edit tool, or a shell command that edits files
  in place with `sed -i` or `perl -i`, or copies or moves them), a pinned output, the current input, or anything in a
  subagent's requests.
- It hides outputs in batches to protect the provider's prompt cache. Hiding an output changes the start of the
  prompt, so the cache misses once for everything after it. Outputs that could be hidden wait until together they
  reach `batch_bytes`, and then a batch is hidden at once. A hidden output keeps the same note on every later
  request, so between batches the start of the prompt stays the same.
- The note's first line skips the command header (chunk id, wall time, exit code, token count).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `batch` | `batch` hides outputs automatically; `continue` hides a batch only on eligible `/continue` commands. |
| `cache_ttl_minutes` | `auto` | Continue-mode estimate: `auto`, `5`, `10`, `30`, `60` or `120` minutes. Does not configure provider retention. |
| `keep_recent` | `10` | The newest tool outputs that are always sent in full |
| `min_bytes` | `1024` | Smaller outputs are never hidden |
| `batch_bytes` | `32768` | Hide nothing until the outputs that could be hidden reach this size (about 8,000 tokens); `0` hides each one as soon as it's old enough |

Fractional values are rounded down; a negative or non-number value uses the default.

A larger `batch_bytes` changes the cached prefix less often, but removes more output each time it does. Use `0` with a provider
that doesn't cache prompts.

## Needs and limits

- It asks to edit the history sent to the model, see tool results and model requests, add a tool and `/hidden_outputs`, and
  keep data in thread storage. The capabilities are `history`, `interception`, `middleware`, `tools`, `store` and
  `commands`, `model`, `lifecycle` and `inventory` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- The full text of each output of at least `min_bytes` is kept as the mod's evidence when the call finishes. The host
  keeps the newest 1,024 of these per repository (256 MB at most), so recalling a very old output can fail. The
  model receives a `recall_unavailable` error saying the text is gone. Recover needed facts from current state; do not blindly repeat a command with side
  effects. It remembers the newest 400 kept outputs of a thread and those of every hidden output.
- At most 400 outputs of a thread are hidden; later ones are sent in full.
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
