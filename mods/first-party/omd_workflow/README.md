# omd_workflow

Keeps long tasks on track. The agent saves checkpoints, and a task counts as done only after the checks and reviews
your chosen contract asks for. A contract is a named rule set, such as `reviewed_omd@1`, that says which checks and
reviews a task needs. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_workflow
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

To use it, pick a contract, set the `check` setting to the command that tests your work, then give the agent a task.
Nothing is delegated until you pick a contract and the agent starts a task.

| Command | What it does |
| --- | --- |
| `/omd_workflow:contract` | List the contracts. |
| `/omd_workflow:contract reviewed_omd@1` | Require checks, an independent review and an independent verification. |
| `/omd_workflow:contract solo_evidence@1` | Require checks and a self-review with evidence. No other agents. |
| `/omd_workflow:progress` | Show this thread's task, its status and the work left. |

From a shell:

```sh
omd-package contract list
omd-package contract select reviewed_omd@1
```

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `check` | `{}` | The check to run, as `{ "program": "/absolute/path", "argv": [] }`. The program is at most 1,024 characters and `argv` has at most 64 entries. |
| `worker_route` | `contributor` | Route for agents that do the work. |
| `review_route` | `reviewer` | Route for the independent review. |
| `verify_route` | `verifier` | Route for the independent verification. |
| `fallback_route` | empty (none) | Route for a `delegate` call with `outage_action: 'opposite_lead'`, used after the worker route fails with a transport error and its one retry fails too. |
| `initial_task` | `{}` | Start with a task already recorded: an objective and acceptance criteria. |
| `max_no_progress_calls` | `0` | How many times the lead (the main model you're chatting with) may repeat the same tool call with the same result before the task pauses (0 to 32). `0` means no limit. |

A route is a model setup in `host.json`: provider, model, URL and rates. See [Routes](../../reference/routes.md).

`max_no_progress_calls` counts only while a task is active and its checkpoint is unchanged. A checkpoint with new
remaining work or failed hypotheses resumes a paused task.

Set `worker_route`, `review_route`, `verify_route` or `fallback_route` to `opposite_lead` to use a route with a
different model or provider than your current one, on the same billing as your current route.

## Needs and limits

- It asks to add its commands and the agent's task tools, start worker, review and verification agents on other routes,
  select and enforce the contract, run your `check` program in the sandbox, read the workspace and merge workers'
  changes into it, add the task checkpoint to the model's context, watch model requests and tool calls to spot repeats,
  offer a service to other mods and keep its state. The capabilities are `commands`, `tools`, `agents`, `model`,
  `contracts`, `exec`, `fs.read`, `fs.write`, `context`, `middleware`, `interception`, `lifecycle`, `services` and
  `store` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- Routes must exist in `host.json`. To add one on your ChatGPT plan, open Workflow in `/mods` and choose Add a helper
  model. This mod doesn't grant provider access or turn on paid fallback.
- The final reviewer and verifier must differ from the model you're using.
- A task's objective and criteria together must stay under about 5 KB so the reviewer prompt fits. A larger one is
  refused when the task starts.
- Delegating needs the `check` setting. Without it the delegation is refused before any agent starts. The host stops
  the check after 120 seconds and counts that as a failure.
- `fallback_route` is read only for `outage_action: 'opposite_lead'`. A delegation is refused when the fallback uses
  the same model and provider as the lead or the worker route, or bills differently from the worker route.
- A reviewer reply with no readable JSON verdict, or with two different ones, is reviewed again once on the same
  candidate. A second one leaves the task at `needs_repair` and releases the agents.
- `initial_task` waits until you have picked a contract. One that is invalid or too large stops the mod from
  loading.
- A contract you pick applies to this repository from your next session.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_advisor`](../omd_advisor/README.md), whose `blocking` mode uses these contracts
- [Agents reference](../../reference/agents.md) and [contracts reference](../../reference/contracts.md)
