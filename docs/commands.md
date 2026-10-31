# Commands

The shell commands OMD installs in `~/.local/bin`, what each is for, and which one to use. Inside `codex`, use
`/mods` to manage mods and `/omd` when `/mods` is broken.

| Command | For | Use it when |
| --- | --- | --- |
| `omd` | Everyone | You install, turn on or off, or remove mods, or update or uninstall OMD |
| `omd-package` | Everyone | You switch install profile, turn a mod that came with your profile on or off, set up accounts, or deploy the broker or a policy |
| `omd-mod` | Repair and administration | You need to change the mod store without running mods, or trust a plugin's mod component |
| `omd-mod-author` | Mod authors | You create, test, run or package your own mod |

`omd mods` and `omd-package mod` both turn mods on and off. Use `omd mods` for mods you installed, and
`omd-package mod` for mods that came with your install profile.

The installer also adds `omd-contract`, which selects workflow contracts, the completion checks `omd_workflow` runs.
`omd-package contract` covers the same steps for most people.

## `omd`

Run `omd` with no arguments for a short summary, or `omd help --all` for every command and flag.

### Mods

| Command | What it does |
| --- | --- |
| `omd install REFERENCE` | Install a mod. `REFERENCE` is `ID[@VERSION]` from the curated directory, `npm:NAME[@VERSION]`, `git+URL[#REF[:DIRECTORY]]` or a folder (`./PATH` or `/PATH`) |
| `omd mods list` | Installed mods and whether each is on |
| `omd mods catalog [QUERY]` | Search the curated directory |
| `omd mods inspect REFERENCE` | Preview a mod without installing it |
| `omd mods enable ID`, `omd mods disable ID` | Turn an installed mod on or off; finds it by id, shows its permissions and asks before turning it on |
| `omd mods update ID` | Update a mod, or review a changed folder mod again |
| `omd mods rollback ID` | Go back to the previous version |
| `omd mods remove ID` | Uninstall a mod; its cache, state and local sources are kept |
| `omd mods quarantine ID REASON` | Turn a mod off and block its installed version |
| `omd mods unblock ID` | Lift a quarantine |
| `omd mods revoke ID` | Turn a mod off and drop its grants; turning it on again needs a new trust |
| `omd mods events` | The store's security events |
| `omd mods sync [--offline\|--rollback]` | Apply, or roll back, the managed deployment from an administrator policy |
| `omd mods reset-lock` | Move the package lock aside; installed mods keep running as trusted selections |

`omd install` and the `omd mods` actions that change a mod take these flags:

| Flag | Effect |
| --- | --- |
| `--scope user\|project` | Install for you (default) or for the current project |
| `--version V` | Install this version |
| `--yes` | Don't ask for confirmation |
| `--store PATH` | Use another mod store |

### Mod data

| Command | What it does |
| --- | --- |
| `omd store export --mod ID` | Print one mod's stored data without running the mod |
| `omd store reset --mod ID` | Delete one mod's stored data without running the mod |

Both take `--repo PATH`, `--store PATH` and `--scope repository|user`. These scopes differ from the `project|user`
scopes of `omd install`. The default scope is `repository`, which needs `--repo PATH`. Without it, the command fails
with `explicit_repository_required`. For data that isn't tied to a repository, pass `--scope user`.

Without `--store`, the command uses `OMD_MOD_STORE`, and fails with `explicit_mod_store_required` if that isn't
set.

### OMD itself

| Command | What it does |
| --- | --- |
| `omd update` | Install the newest release |
| `omd update status` | Show the install and update settings |
| `omd update check` | Check for a release without installing it |
| `omd update rollback` | Undo the last update |
| `omd update enable\|disable` | Install updates automatically, or only when you run `omd update` |
| `omd update checks on\|off` | Turn update checks on or off |
| `omd update cadence daily\|weekly` | How often to check |
| `omd update channel stable\|prerelease\|nightly` | Which releases to follow |
| `omd update pin VERSION\|none` | Stay on one version, or stop pinning |
| `omd uninstall` | Remove OMD; Codex settings and sessions stay |
| `omd mini` | Start Codex in the [scrollback-first interface](../mods/first-party/omd_mini/README.md) (OMD+ with `omd_mini` on) |

### Shell commands from mods

`omd COMMAND --repo PATH [ARGS]` runs a shell command that a mod or mod component exports, if it's on. These commands
can't make model requests or run processes. See
[plugin components](../mods/reference/plugin-components.md).

## `omd-package`

Manages the install profile. It prints JSON, except `status` without `--json`.

| Command | What it does |
| --- | --- |
| `omd-package status [--json]` | The install profile and its mods |
| `omd-package activate full\|platform\|direct` | Switch to OMD+ or OMD Core, or to `direct`, the recovery state that runs plain Codex behavior with no mods |
| `omd-package mod enable\|disable ID` | Turn a mod your profile installed on or off, without asking. It changes the trusted selection, reloads the mods and restores the previous state if the mod fails to load |
| `omd-package profiles [--setup] [--model NAME]` | Set up `omd_profiles` or start a session on an account profile; `--help` lists the other flags |
| `omd-package mini` | The same as `omd mini` |
| `omd-package contract list\|status\|plan\|select\|clear [ID@VERSION]` | List, show or select the workflow contract for this repository |
| `omd-package plugins` | Register the OMD+ plugin marketplace with Codex ([plugins](../plugins/README.md)) |
| `omd-package broker install\|pin\|status\|reset\|uninstall` | Deploy or manage the authority broker (needs `sudo`) |
| `omd-package policy install\|rollback\|remove\|explain [FILE]` | Manage the administrator policy file (needs `sudo`) |
| `omd-package uninstall [--keep-broker]` | Remove this installation |

The installer uses `omd-package install` and `omd-package reconcile`; you don't run them yourself.

## `omd-mod`

The low-level tool for a mod store. Most commands take the store path (`~/.local/share/oh-my-diff/stores/full` for
OMD+, `.../stores/platform` for OMD Core) as `STORE` and work without running any mod. Run `omd-mod` with no arguments
to print its full usage.

| Group | Commands |
| --- | --- |
| Look | `status`, `selection-status`, `report`, `events`, `declarations`, `security-events` (each `STORE`) |
| Turn on and off | `package-enable`, `package-disable`, `package-unblock STORE ID`; `package-quarantine STORE ID REASON`; `enable`, `disable STORE PACKAGE` for a mod trusted by its folder |
| Trust | `inspect PACKAGE`, `trust STORE PACKAGE SHA256 CAPABILITIES_CSV [user\|project] [--allow-secret-env NAME]... [--expires SECONDS]`, `revoke STORE MOD_ID_OR_PACKAGE` |
| Plugins | `plugin-component PLUGIN_ROOT`, `plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE` |
| State | `migrate STORE MOD_ID_OR_PACKAGE`, `rollback STORE MOD_ID_OR_PACKAGE BACKUP`, `reset STORE host.json\|mods.json\|packages.lock.json\|managed.json` |
| Credentials | `credentials STORE`, `credentials STORE add-secret MOD_ID LABEL ORIGIN` |
| Policy | `policy show\|clear\|rollback`, `policy check\|set FILE`, `policy explain STORE [PROJECT_DIR]`, `package-sync STORE` |
| Debug | `reload STORE`, `diagnostics STORE OUTPUT_JSON`, `explain DENIAL`, `test STORE SCENARIO_JSON` |

The [packaging reference](../mods/reference/packaging.md) and the
[administrator policy reference](../mods/reference/administrator-policy.md) describe these commands in full.

## `omd-mod-author`

Creates, tests and packages your own mods. It needs Node on your `PATH`; [support](support.md) lists the version.

| Command | What it does |
| --- | --- |
| `omd-mod-author create DIR [ID]` | Start a new mod |
| `omd-mod-author example DIR NAME`, `examples DIR` | Copy one or every public example |
| `omd-mod-author check DIR`, `test DIR` | Type-check, or run the mod's tests |
| `omd-mod-author run DIR`, `debug DIR` | Run `mod.test.json` or `debug.test.json` |
| `omd-mod-author package DIR` | Build a release copy |
| `omd-mod-author cost DIR [COMMAND [ARGS_JSON]] [--runs N]` | Activation, first render and callback time, runner count and footprint of one package |
| `omd-mod-author watch DIR STORE [--once]` | Reload the mod into a store on every change |
| `omd-mod-author report STORE` | Declared versus used capabilities, services, operations and environment |
| `omd-mod-author events STORE` | Composition order, scope precedence, events, replacements and conflicts |
| `omd-mod-author diagnostics STORE [OUTPUT]` | Write a diagnostics file |
| `omd-mod-author explain DENIAL` | Explain a denial code and its safe remedy |

A new mod's `package.json` wraps these as `pnpm test`, `pnpm check`, `pnpm watch STORE` and others. The
[authoring reference](../mods/reference/authoring.md) has every author command, and
[write your first mod](mod-authors/first-mod.md) walks through them.

## Installer (`install.sh`)

The install command in [Install Oh My Diff](install.md#install) runs `install.sh`, which takes these options:

| Option | Default | Effect |
| --- | --- | --- |
| `--profile full\|platform` | asked in a terminal | The OMD+ or OMD Core install profile |
| `--channel stable\|prerelease\|nightly` | `stable` | Which release to install |
| `--root DIR` | `~/.local/share/oh-my-diff` | Where OMD keeps releases and mod stores |
| `--bin-dir DIR` | `~/.local/bin` | Where the `codex`, `omd` and other commands go |
| `--upstream PATH` | `codex` on your `PATH` | The Codex `0.166.x` executable OMD builds on |

An existing command in the bin folder is renamed to `NAME.before-omd` and comes back on uninstall.

### Where OMD keeps files

Under the root folder:

- `releases/` contains the current and the previous release.
- `stores/` contains your mod choices and mod data, one store per install profile (`stores/full`, `stores/platform`).
- `objects/` contains one copy of each package source and management file, hard-linked into `catalog/` and every
  release.
- `sessions/` contains one marker per open `codex`, cleared at the next launch after that session exits.
