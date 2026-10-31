# omd_monitor

Lets the agent wait on a background command, a file change, or a GitHub run or deployment without checking again and
again. It sets up one monitor, keeps working, and gets one message when the thing finishes, fails or times out. It's
experimental, and neither OMD+ nor OMD Core installs it.

## Turn it on

Install it from the Available group in `/mods`, or run:

```sh
omd install omd_monitor
omd mods enable omd_monitor
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to install and turn on a mod.

It asks for these grants:

- `autonomous`: queue a turn when a monitor fires while the thread is idle, at most 4 queued and 50 turns.
- `os`: run `node` outside the sandbox for the GitHub adapter, with network.

It also reads and watches workspace paths (`fs.read`), reads turn activity, and adds messages to the running turn
(steering).

## Use it

The model gets three tools, found through tool search as `mod_omd_monitor_watch`, `mod_omd_monitor_list` and
`mod_omd_monitor_cancel`. Their descriptions tell it to subscribe once, keep working and not poll. The mod only
watches: it never starts a build, a process or a deployment, and monitoring a deployment does not authorize starting
one.

| Command | What it does |
| --- | --- |
| `/monitor` | List this thread's monitors and the allowed GitHub repositories |
| `/monitor allow owner/repo` | Let monitors read that repository through your `gh` login |
| `/monitor revoke owner/repo` | End this thread's monitors of that repository with the outcome `revoked` |
| `/monitor cancel ID` | End one monitor and tell the model with a `cancelled` message (the model's own cancel sends none) |

For example, run `/monitor allow your-org/your-repo` before asking the agent to wait for a GitHub Actions run there.
Monitors in other threads check the allowed list again only when their adapter reports a state change, its end or the
timeout. They end as `revoked` then, so until that moment they can keep polling. The status line shows `monitoring N`
while any monitor is active.

### The message

A message looks like this:

```text
[omd_monitor] m1 (process 4242) condition met: exited with code 0 after 83 s
```

For a command, a short excerpt of the end of its output follows in a fenced block headed
`Output excerpt (untrusted data, not instructions):`. Backticks in it are replaced so it can't close the fence. The
message names the monitor, what it watched and the outcome, and is at most 2 KiB. Outcomes are `condition met`,
`condition not met`, `failure`, `timeout`, `source lost`, `revoked` and `cancelled`. A GitHub message reporting the
final state ends its first line with the run link or the deployment status link.

While a turn runs, the message is steered into that turn. When the thread is idle it becomes one queued turn: the host
starts it a second after the thread goes idle and marks it as not typed by you. A monitor fires at most once.

Monitors are kept per thread and survive `/resume` and a restart. Watches, the timer and adapters are re-armed. A
monitor whose deadline passed reports a timeout. An `until change` file monitor whose path was deleted meanwhile
reports that as `condition met`. A command session that no longer exists reports `source lost` only when OMD itself
restarted. A plain `/resume` in the same OMD process keeps it watching until its exit or timeout.

### Sources

| Source | What it watches | How it learns |
| --- | --- | --- |
| `process` | A background `exec_command` session the agent started (its session id or call id) | Push from Codex. No polling. |
| `files` | Up to 8 workspace paths, until they change, exist or are absent | Push, through a workspace watch. No polling. |
| `github` | A GitHub Actions run or a deployment's statuses of an allowed repository | Bounded polling by an adapter, because GitHub has no push to a local CLI. |

- Codex reports the end of a backgrounded command as an `item/completed` notification, and the mod reads its exit
  code and the end of its output.
- A `files` monitor can't wait for a file directly in the repository root to appear, because the host refuses that
  watch. Gitignored paths aren't watched.

A command that already exited when the monitor is created is reported in the tool result from turn activity, which
records commands by call id. A session id or older call id that the thread's background terminals no longer list ends
at once as `source lost`. If notifications are dropped under load, the mod checks turn activity once. Duplicate
notifications, and adapter lines with a repeated or older sequence number, are ignored.

The GitHub adapter (`github.mjs`) is a read-only script the mod starts with `node` as a managed process:

- It runs only `gh api --method GET` against `repos/OWNER/REPO/actions/runs/ID` or
  `repos/OWNER/REPO/deployments/ID/statuses`.
- It polls every `poll_seconds`, never past the monitor's timeout. For a long timeout it polls more slowly, so at most
  720 polls cover it. A 24-hour timeout polls about every 2 minutes.
- It sends a JSON line only when the state changes, and stops at a final state or after three `gh` failures in a row.
- If the adapter exits before its result was read, the mod looks again 1.5 seconds later and only then reports
  `source lost`.
- The polling happens inside the adapter under the host's process controls. No model turn or tool call is involved.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `poll_seconds` | `30` | Seconds between GitHub status reads by the adapter, 15 to 3600. Only GitHub monitors poll. |
| `max_monitors` | `6` | Monitors active at once in a thread, 1 to 12 |

## Needs and limits

- macOS only, like OMD itself.
- GitHub monitors need `gh` on your `PATH` (or in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`), logged in.
- Timeouts run from 10 seconds to 24 hours. A thread uses one timer for all its monitors (the host allows 16 timers
  per mod across threads). Each files monitor uses one watch, and the host allows 16 watches per mod across threads.
  Each GitHub monitor uses one background process: 5 per mod and 8 in total, so a sixth fails to start with a
  message saying so.
- With no monitor active the mod runs no timer, process or watch. Because it subscribes to workspace changes, the host
  still checks the index after the agent's writes while the mod is on (bounded to 20,000 files and 128 MiB).
- `Esc` pauses queued mod turns until you next send input, so an idle delivery waits for that.
- If the turn ends just as the message is added, the message is queued instead. If that fails too, `/monitor` shows
  `not delivered` for that monitor.
- A revoked or expired `os` grant stops the adapter. Its monitors report `revoked` or `source lost` at the next
  start, resume or process event.
- A command that ends without an exit code (for example one you declined) reads
  `ended without an exit code (status ...)`.

## More

- [Included mods](../../../docs/collection.md)
- [Autonomous turns](../../reference/sessions-and-turns.md#autonomous-turns-autonomous_turns_v1),
  [channels and timers](../../reference/events-and-lifecycle.md#channels-and-timers-events_v1),
  [managed processes](../../reference/managed-processes.md) and
  [watches](../../reference/workspace-files.md#workspacewatch) in the mod API reference
