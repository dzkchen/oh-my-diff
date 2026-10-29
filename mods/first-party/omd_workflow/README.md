# omd_workflow

Keeps long tasks on track: the agent saves a checkpoint, and a task counts as done only after the checks and reviews your chosen contract asks for.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_workflow
```

## Use it

| Command | What it does |
| --- | --- |
| `/omd_workflow:contract` | List the contracts. |
| `/omd_workflow:contract reviewed_omd@1` | Require checks, an independent review and an independent verification. |
| `/omd_workflow:contract solo_evidence@1` | Require checks and a self-review with evidence. No other agents. |
| `/omd_workflow:progress` | Show this thread's task, its status and the work left. |

From a shell, `omd-package contract select ID@VERSION` picks a contract too.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `check` | `{}` | The check to run, as `{ "program": "/absolute/path", "argv": [] }`. |
| `worker_route` | `contributor` | Route for agents that do the work. |
| `review_route` | `reviewer` | Route for the independent review. |
| `verify_route` | `verifier` | Route for the independent verification. |
| `fallback_route` | empty (none) | Route to use if the first one is down. |
| `initial_task` | `{}` | Start with a task already recorded: an objective and acceptance criteria. |
| `max_no_progress_calls` | `0` | How many times the lead may repeat the same tool call with the same result, while a task is active and its checkpoint is unchanged, before the task pauses (0 to 32). A checkpoint with new remaining work or failed hypotheses resumes it. `0` means no limit. |

Set `review_route`, `verify_route` or `fallback_route` to `opposite_lead` to use a route with a different model or provider than your current one.

## Needs and limits

- Nothing is delegated until you pick a contract and the agent starts a task.
- Routes must exist in `host.json`; Add a helper model in `/mods` (Workflow) adds one on your ChatGPT plan. This mod doesn't grant provider access or turn on paid fallback.
- The final reviewer and verifier must differ from the model you are using.
- A task's objective and criteria together must stay under about 5 KB so the reviewer prompt fits; a larger one is refused when the task starts.
- Delegating needs the `check` setting; without it the delegation is refused before any agent starts.
- A reviewer reply with no readable JSON verdict, or with two different ones, is reviewed again once on the same candidate; a second one leaves the task at `needs_repair` and releases the agents.
- `initial_task` waits until you have picked a contract. One that is invalid or too large stops the mod from loading.
- A contract you pick applies to this repository from your next session.
