# Muse route

`omd_muse` connects OMD+ to a separately installed Muse Code agent over `muse serve` (the MSP host, stdio JSON-RPC). It is installed inactive in OMD+ and can be installed explicitly in OMD Core. Support is experimental: Muse Code 0.2.1 reports that its MSP host is not implemented in that build, so this package is validated against a fake MSP host until a build with `muse serve` is available.

```sh
omd-package muse --setup              # handshake, schema fingerprint, live model list, store grant; enables the mod
omd-package muse                      # an OMD session with Muse as the lead
```

Muse is an agent, not a bare model: it keeps its own context, compaction and tools. The mod therefore uses it in two ways.

- **Research subagent.** The `research` tool (`mod_omd_muse_research`) lets any lead hand a question to Muse and get findings with file paths or URLs back. It runs through `model.complete` on the Muse route, so the host keeps admission and the ledger. Decisions and edits stay with the lead.
- **Lead.** Codex sends only the user and assistant conversation; its own prompt, tools and approvals stay in OMD. The transport reuses the Muse session while the history matches, forks it when a forked OMD thread continues (`/fork`), resumes it after a restart, and starts a fresh session with the transcript when the history diverged. Muse's tool activity appears in the reasoning summary.

Safety posture, fixed for the host's lifetime: `muse serve --trust-workspace --disable-write --sandbox-network restricted`, with Muse's own sandbox on and approvals on request. The host also runs the transport inside the OMD session's sandbox with the repository read-only, so Muse cannot write the workspace even if its own checks allow it. Every Muse approval goes to you through OMD: a lead turn calls the internal `approval` tool, the research tool asks directly, and both show a native confirm prompt. Without a terminal (for example `codex exec`) the request is denied. Setting `auto_approve: true` approves Muse's requests without asking; it is off by default. Clarifying questions are cancelled and Muse is told to state its assumptions.

`/muse doctor` checks the binary, handshake, schema fingerprint against setup, models and sessions; `/muse sessions` lists Muse sessions; `/muse fork` forks this chat so its next Muse turn continues on a fork; `/muse recover [session]` puts the newest completed answer from a session's durable log in the composer. Session state and durable logs live under `/private/tmp/omd-muse-<uid>`; setup and the transport refuse it unless it is a directory you own with mode 0700. A changed schema fingerprint stops the route until setup is rerun.

What differs from Codex models: Muse runs its own tools and context, so OMD tools, Codex compaction and per-tool approvals do not apply inside a Muse turn; context usage reported to `/status` is Muse's own token count; Meta's service terms apply to what Muse sends; and the route can only read the workspace.

## Credits

Ports the `muse serve` client behavior of [pi-muse-msp](https://github.com/jwise7/pi-muse-msp) 0.2.4 by Jesse Wise (MIT), including UUIDv7 command ids, session reuse and durable-log recovery. Unlike the source, it never runs unsandboxed and never auto-approves by default. See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
