# Bundle a mod in a plugin

How to ship skills and a mod together as one Codex plugin. Use a plugin when your feature needs both a procedure
the model follows (a skill) and a change to `codex` itself (a mod). The mod inside a plugin is called a mod
component. [`omd-anchored-edit`](../../plugins/bundled/oh-my-diff/plugins/omd-anchored-edit) is a complete example.

## Lay out the plugin

```text
my-plugin/
  .codex-plugin/plugin.json    the Codex plugin manifest
  .codex-plugin/omd.json       points OMD at the mod component
  skills/my-skill/SKILL.md
  mod/mod.json
  mod/index.ts
```

`mod/` is an ordinary mod. Create it with `omd-mod-author create ./my-plugin/mod my_mod`, write and test it as in
[Write your first mod](first-mod.md).

## Write the manifests

1. In `.codex-plugin/plugin.json`, name the plugin and its skills folder:

   ```json
   {
     "name": "my-plugin",
     "version": "0.1.0",
     "description": "What the plugin adds",
     "skills": "./skills/"
   }
   ```

2. Get the mod component's digest:

   ```sh
   omd-mod inspect ./my-plugin/mod
   ```

   The output has a `sha256` field.

3. Write `.codex-plugin/omd.json` with that digest:

   ```json
   {"schema": 1, "component": "mod", "sha256": "SHA256_FROM_OMD_MOD_INSPECT"}
   ```

4. Check that the descriptor matches the folder:

   ```sh
   omd-mod plugin-component ./my-plugin
   ```

   It prints the component's path. After any change to the mod, it fails with `plugin_component_hash_mismatch`
   until you repeat steps 2 and 3.

## Tell users how to turn the mod on

Adding the plugin with `codex plugin add` installs its skills but doesn't run its mod. Each user inspects, trusts
and turns on the component in their mod store. The steps are in
[Turn on a component](../../plugins/README.md#turn-on-a-component). In your plugin's README, list the capabilities
from `mod/mod.json` so users know what they grant.

## See also

- [Plugin components reference](../../mods/reference/plugin-components.md)
- [How OMD works](../how-omd-works.md#mods-plugins-skills-and-hooks): when to write a skill, hook, plugin or mod
