# OMD mod authoring

Optional skill-only plugin `0.1.0-preview.1` for public mod API `0.2.0-experimental.5`. It guides an agent through creating a mod in a scratch directory, inspecting it, handing its digest to the user for native approval, and trying it offline with typed host tools. It has no mod component, hook or server, so it adds no authority; the commands it names are the SDK's [author commands](../../../../mods/REFERENCE.md#author-commands).

```sh
codex plugin marketplace add /absolute/path/to/oh-my-diff/plugins/optional
codex plugin add omd-mod-authoring@oh-my-diff-optional
```

Installation does not activate it for any task, and the agent never trusts or enables its own code: approval stays with the user in `/omd` or `omd-mod trust`. The skill's offline proofs use fixture rendering; they are not supported-client evidence.
