# Live output

`/live_output:run COMMAND` runs `sh -c COMMAND` in the managed-process
sandbox with `framing: "raw"` and `stdin: "null"` and shows its stdout and
stderr above the composer as they are written, keeping the last 48 KiB in one
`code` component. Escape sequences and control characters are stripped, a bare
carriage return rewrites its line as progress bars expect, and an escape
sequence or `\r\n` split across reads is joined first; a chunk that is not
UTF-8 shows as its byte count. Running another command stops the previous one,
and a command still shown as running when OMD starts again shows as stopped.

The slash command publishes to the mod's own channel because commands cannot
start processes; the channel handler starts the process as session `live-N`
(`N` counts runs and is kept in the state) with `notify: ["output", "exit"]`.
Each `process_event` for the current run drains the queue with at most two
`process.exchange` calls, because one call returns up to 48 KiB and a callback's
receipts total 131,072 bytes; when more may be queued (the last page was not
empty, or the process exited and `process_stopped` has not been seen) it
schedules a 50 ms timer that continues until a page comes back empty. Events and
timers of earlier runs are ignored, so the late exit notice of a stopped run
cannot touch the new one. `process_stopped` marks the run exited and
`process_session_unavailable` stopped; any other `process.exchange` error leaves
it running and retries after a second.
