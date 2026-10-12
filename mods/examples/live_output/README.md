# Live output

`/live_output:run COMMAND` runs `sh -c COMMAND` in the managed-process
sandbox with `framing: "raw"` and shows its stdout and stderr above the
composer as they are written, keeping the last 48 KiB in one `code` component.
Escape sequences and control characters are stripped; a chunk that is not
UTF-8 shows as its byte count. Running another command stops the previous one.

The slash command publishes to the mod's own channel because commands cannot
start processes; the channel handler starts the process with
`notify: ["output", "exit"]`, and each `process_event` drains the queue with
`process.exchange`.
