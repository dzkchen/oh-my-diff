# omd_env_bootstrap

Gives the model a short snapshot of the workspace before its first request, so it doesn't spend its first turns
exploring. Built for headless runs such as `codex exec`.

## Use it

On a thread's first model request the mod runs the shell script in `snapshot.ts` once through the session's sandbox (read-only, no
network, at most 3 seconds) and adds about 1.5 KB of context:

```text
os: Linux x86_64
cwd: /app
files (12): pyproject.toml src/ tests/ ...
languages: py 120, toml 2
manifests: pyproject.toml
test: pytest
git: main, 0 changed, last: 1a2b3c4 Fix parser
toolchains: python3 3.11.4; node 20.11.0
tools: pip rg jq git curl
```

The same text goes into every later request of the thread, right after Codex's environment context, so it stays in
the provider's cached prompt prefix. It is never refreshed; the model is told to verify anything its own changes may
affect.

## Needs and limits

- Capabilities `middleware`, `exec` and `store`.
- The snapshot runs in the sandbox's private `HOME`, so version managers that need the user's home (mise, rustup,
  pyenv shims) show `?` instead of a version.
- A failed or empty snapshot is not retried, and that thread gets no snapshot.
- Each subagent thread takes its own snapshot. Snapshots are kept for the 32 most recent threads.
- A thread that already had requests before the mod was turned on gets the snapshot from its next request, which
  changes its cached prefix once.
