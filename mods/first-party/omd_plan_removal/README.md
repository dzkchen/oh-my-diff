# Plan-mode removal

`omd_plan_removal` removes Codex plan mode through public built-in controls. It is enabled by default in OMD+ and can be installed explicitly in OMD Core. Run `omd-package mod disable omd_plan_removal` to restore plan mode in OMD+. The whole mod is one registration, needing only the `builtins` capability:

```ts
api.builtins({ commands: { hide: ['plan'] }, modes: { disable: ['plan'] } });
```

While it is enabled:

- `/plan` is gone from the command popup and typing it reports an unrecognized command.
- Shift+Tab cycles only the default mode, so the Plan indicator never appears.
- A turn that asks for plan mode anyway (a resumed plan-mode thread, an app-server `turn/start` or `thread/settings/update`) runs in the default mode. The host clears the plan instructions and reports a warning, which app-server clients receive as a `warning` notification.
- The Plan-only `request_user_input` tool is no longer offered, because the host drops disabled modes from mode-scoped tools.
- Permissions, approvals, task execution and session data are unchanged.

Built-in controls load at the next turn boundary. If you enable the mod during a plan-mode session, the next turn already runs in the default mode with the warning, the terminal leaves plan mode, and the transcript is kept. Disabling or uninstalling the mod, or a broken copy that fails to activate, restores `/plan`, plan mode and `request_user_input` at the next boundary without rebuilding Codex.

The mod registers no events, so turns and model requests pay no callback cost.

## Remove and restore with the same binary

The same Codex binary can take a built-in feature away and give it back, next to a mod that adds one. With `STORE` set to the host's `OMD_MOD_STORE`:

```sh
omd-mod inspect mods/first-party/omd_plan_removal
omd-mod trust "$STORE" mods/first-party/omd_plan_removal INSPECT_SHA256 builtins
omd-mod enable "$STORE" mods/first-party/omd_plan_removal
omd-mod inspect mods/examples/counter
omd-mod trust "$STORE" mods/examples/counter INSPECT_SHA256 tools,commands,store
omd-mod enable "$STORE" mods/examples/counter
```

In `codex`, `/plan` reports an unrecognized command while the additive example's `/show` prints `Counter is 0`. Run `omd-mod disable "$STORE" mods/first-party/omd_plan_removal`; after the next turn `/plan` switches to Plan mode again. OMD+ already installs and trusts it at `$STORE/sources/omd_plan_removal`, so there `omd-mod enable "$STORE" "$STORE/sources/omd_plan_removal"` and the matching `disable` are enough.
