# omd_env_bootstrap

Gives the model a short snapshot of the workspace before its first request, so it doesn't spend its first turns
exploring. Built for headless runs such as `codex exec`. It's experimental, and no install profile includes it.

## Turn it on

```sh
omd install omd_env_bootstrap
omd mods enable omd_env_bootstrap
```

It needs no authority grant. Turn it on in the shell or `/mods` before a `codex exec` run: a headless run can't show the trust dialog, so a mod that
isn't trusted yet stays off.

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

- Capabilities `middleware`, `exec` and `store`. The snapshot is kept in the thread's own state.
- The snapshot runs in the sandbox's private `HOME`, so version managers that need the user's home (mise, rustup,
  pyenv shims) show `?` instead of a version.
- A failed or empty snapshot saves nothing, and the next request tries again; the request that first gets one adds it
  and changes the cached prefix once. A snapshot that runs out of time keeps the lines it printed.
- Each subagent thread takes its own snapshot.
- A thread that already had requests before the mod was turned on gets the snapshot from its next request, which
  changes its cached prefix once.

## More

- [Benchmark](../../../docs/benchmarks/harness-mods.md) of this mod with the other harness mods
