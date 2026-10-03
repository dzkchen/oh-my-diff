# omd_shared_checkout

Opt-in first-party mod (`0.1.0-preview.1`, API `0.2.0-experimental.5`) for
several OMD sessions or agents working in one checkout. Parallel write tasks
are safest in their own worktree; this mod coordinates the cases where they
share a checkout anyway.

```text
/share                                   show or hide the panel
/share write PATH... -- TASK [@SESSION]  reserve paths and become a writer
/share read                              back to read-only, releasing the paths
/share handoff SESSION [PATH...] [-- NOTE]   offer reserved paths to a session
/share accept N | decline N              answer a pending handoff
/share release SESSION                   remove an abandoned registration
/share dismiss | worktree                clear warnings | start upstream /worktree
```

`SESSION` is the eight-character prefix shown in the panel.

**Read-only by default.** Every session registers in its checkout as a
read-only participant when it starts or resumes. Agent threads (sub-agents)
are read-only until the user names them with `/share write ... @THREAD`. The
mod's `approval` middleware sees every patch and command before automatic
review: a read-only participant's patches and Git writes are denied with the
command that grants write access, and its recognizable shell writes pause for
approval.

**Writers.** A writer reserves files or folders with a task name. Its patches
inside the reservation continue; a patch outside it, or into another writer's
reservation, pauses for the user's native approval with the reason. Shell
commands are checked the same way for the files they recognizably write:
redirections (`>`, `>>`) and the operands of `rm`, `rmdir`, `unlink`, `shred`,
`touch`, `mkdir`, `truncate`, `tee`, `mv`, the target of `cp`, `ln` and
`install`, and the files of `sed -i`, including inside `sh -c` scripts.
Reserving paths another writer holds asks first; declining suggests a worktree
or a handoff. `/share worktree` starts upstream `/worktree`; with
[`omd_worktree`](../omd_worktree/README.md) enabled, `/omd_worktree:task TASK`
makes a named task branch checkout instead. Overlapping reservations stay
visible as warnings to both sessions.

**Git.** Git writes (`add`, `commit`, `checkout`, `stash`, `reset`, branch and
tag changes and so on) from coordinated sessions, including ones behind
environment assignments, wrappers such as `command` or `env`, and `sh -c`
scripts, take a two-minute lease that the tool result releases. A Git write
while another session holds the lease, or while other writers are active,
pauses for approval. The mod itself never stashes, resets, commits, discards,
merges or rewrites anything.

**Panel and recovery.** The panel (`/share`, or `omd_shared_checkout/checkout`
in `omd_panes`) and a sidebar summary list each session with its task, paths
and last heartbeat, pending handoffs, warnings and the advisory label. Sessions
heartbeat every four minutes and are shown stale after ten; a stale
reservation still pauses overlapping edits, and `release` removes it after a
confirmation. Stopping a session removes its registration; registrations
unseen for a day, and Git leases older than two minutes, are dropped. At most
sixteen sessions, sixteen paths each and eight handoffs are kept per checkout.

**What is enforced.** Reservations are advisory: agent patches, Git commands
and recognizable shell writes in sessions running this mod are checked. Writes
a command makes indirectly (build tools, package managers, scripts), mod
writes such as `omd_editor` or `omd_panes`, and programs outside OMD (editors,
Claude Code) are not blocked. A writer watches its reserved paths, ignored
files included (a reservation of the whole checkout watches each top-level
entry), and is warned when one changes outside its session: a change is
checked three seconds after it is seen, or after the writer's running command
finishes, against the session's own patches, commands and mod writes, and a
warning is withdrawn if the session later reports the change as its own. Edits
are not conflict-free and nothing is snapshot-isolated.
The registry is checkout-scoped mod state (`state_scope: "checkout"`), kept in
the checkout's Git directory, so every OMD session working in that checkout
coordinates whatever its mod store or profile; a linked worktree has its own
registry, and a directory outside Git keeps it in `.omd/state/`, which agent
commands cannot write. Paths are relative to the checkout root (the Git top
level, or the launch directory), whichever subdirectory a session runs in.
Each session keeps its own permissions and allowances.

Capabilities: `commands`, `terminal`, `store` (the registry and the thread
store that identifies the session), `lifecycle`, `events` (heartbeat and settle
timers, the watch hop), `exec` (`pwd` and `git rev-parse --show-toplevel`), `fs.read`
(watches and the session's own change notices), `middleware` and `approvals`
(the gate) and `builtins` (`/worktree`).
