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
start processes; the channel handler starts the process with
`notify: ["output", "exit"]`, and each `process_event` drains the queue with
`process.exchange`.
