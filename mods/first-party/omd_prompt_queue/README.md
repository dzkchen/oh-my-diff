# omd_prompt_queue

`/queue` keeps a queue of your prompts for the current thread and sends them as
your messages, one at a time, when the session is idle.

- Alt+q moves the composer draft (text and images) into the queue; `/queue add TEXT` queues text.
- `/queue` lists the queue; `edit N TEXT`, `move N M`, `remove N` and `join N M` manage entries.
- Joining preserves every image. If the combined prompt exceeds eight images, both entries are kept and the join is refused.
- `/queue send N` sends an entry now: a new turn when idle, steering the running turn otherwise.
- `/queue pause` and `/queue resume` stop and restart draining. Stopping a turn (Esc) pauses the queue until you resume it.
- `/queue retry N` sends a failed or unconfirmed entry again after you confirm it.

Each capture, edit, join and retry is your consent for exactly that content:
the host records a single-use consent (`prompts.consent`), and the queue can
submit only that content, once (`prompts.submit`). Entries go through the normal
permission, model and spending path as your own messages; the mod never submits
anything you did not queue. An entry leaves the queue only after the host has
seen the message committed to the thread; an entry whose delivery cannot be
confirmed (for example after a crash) is kept and shown as failed instead of
being sent twice. The status line shows how many entries are queued, whether
the queue is paused and how many need you.

An unconfirmed delivery blocks automatic draining until it is acknowledged,
removed or explicitly retried. A late acknowledgement still removes it.
Retry, edit and join wait if the host cannot check an uncertain delivery's status.

The queue is stored per thread and is copied when a thread is forked, but
consents are not: entries in a fork wait for `/queue retry`. Disabling the mod
stops draining; its pending consents are dropped.
Captured images survive configuration revisions and forks while the mod's source
and repository remain the same; retry in a fork grants fresh consent for those images.

Requires `composer_v2` and `user_submissions_v1`; installed inactive in OMD+
(`omd-package mod enable omd_prompt_queue`).
