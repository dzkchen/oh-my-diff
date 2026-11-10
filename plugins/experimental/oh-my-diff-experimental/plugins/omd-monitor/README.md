# OMD Monitor

Agent guidance for natural requests such as “Watch CI for PR 123 in acme/app and continue the other work.”
The skill calls the first-party `omd_monitor` tools. The mod stores watches, restores them after a restart, enforces
timeouts and delivers results.

Register the experimental marketplace from a checkout as described in [Plugins](../../../../README.md), then install:

```sh
codex plugin add omd-monitor@oh-my-diff-experimental
omd mods enable omd_monitor
```

Enable the mod with its declared grants. There is no repository allowlist or additional approval prompt.
GitHub watches require a logged-in `gh`. See the [mod guide](../../../../../mods/first-party/omd_monitor/README.md)
for source limits and delivery behavior. This plugin contains guidance only; it has no mod component.
