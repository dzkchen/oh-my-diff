# omd_btw

Replaces Codex's `/btw` with side questions that remember each other. Ask something about the work in progress, and
the answer shows below the conversation without entering it. It's experimental, and no install profile includes it.

## Turn it on

Install it from the Available group in `/mods`, or run:

```sh
omd install omd_btw
omd mods enable omd_btw
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to install and turn on a mod.

The first `/btw` asks to add a helper model: the model you're chatting with, on your ChatGPT plan. Allow it and the
answer follows; later side questions use it without asking. To pick another model, open Btw in `/mods`, then Side
question model. Without a ChatGPT sign-in, pick a model there first.

## Use it

| Command | What it does |
| --- | --- |
| `/btw <question>` | Answers from the whole conversation so far, without tools, and shows your five earlier side questions above the answer. |
| `/btw` | Shows the latest side question and its answer again. |
| `/aside` | The same command under the mod's own name. |

Stock Codex's `/btw` opens a separate side conversation and forgets it when you return. With this mod:

- The side question and answer never enter the main conversation, so the agent doesn't see them and the prompt cache
  isn't touched.
- Each new side question gets your earlier side questions and answers as context (the newest 20, up to 30 KB), so a
  follow-up such as "and the other file?" works.
- The thread keeps its side questions, so they're still there after `codex resume`.
- It works while a turn is running. It sees the conversation up to the last finished step, not the reply being
  written.

`/side` still opens Codex's side conversation, with tools.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `route` | none | The model route side questions run on. The first `/btw` fills it in when you allow a helper model. |

## Needs and limits

- Each side question is one request on the chosen route. A helper model on your ChatGPT plan counts against the plan
  like any other request. The request's prefix differs from the main conversation's, so it may not hit the prompt
  cache.
- The answer has no tools: it can't read files or run commands, and says so instead of guessing.
- A question is cut at 6,000 bytes. An answer is complete when it first shows; the stored copy that a bare `/btw`
  shows and later questions see is cut at 8,000 bytes. An answer the model stopped at its token limit ends with
  "(cut off)".
- It asks to replace `/btw`, read the conversation and call the model. The capabilities are `terminal`, `commands`,
  `builtins`, `agents`, `sessions`, `sessions_tools` and `store` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).

## More

- [Included mods](../../../docs/collection.md)
- [`model.fork`](../../reference/model-calls.md#modelfork) and
  [command routing](../../reference/commands-and-composer.md#builtinsinvoke-key-bindings-and-command-routing) in the
  mod API reference
