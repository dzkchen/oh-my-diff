# Oh My Diff

Oh My Diff (`oh-my-diff`, identifier prefix `omd`) is a focused patch set for
the open-source Codex CLI/runtime. It keeps `codex` as the launch command and
shares Codex configuration, authentication, instructions, and compatible
sessions.

The target product makes Codex deeply moddable in TypeScript and ships a curated
set of useful, replaceable mods. Users should be able to reshape coordination,
context, tools, and the terminal experience without maintaining their own Codex
fork. The intended lasting advantage is a useful mod ecosystem, dependable API
compatibility, good author tools, and integrations maintained across upgrades.

The native foundation, [experimental TypeScript mod API and author tools](mods/README.md),
and a [reviewed extension candidate index](extensions/README.md) are implemented.
Public release qualification and curated distribution remain in progress. Cost reduction is
one intended benefit of bundled policies, not an established performance claim
or the entire product promise.

The initial audience is Codex CLI power users who have hit a concrete
customization limit. The public release includes the curated first-party
bundle, polished setup, and mod controls.

The two install choices are **OMD Core**, the modding ecosystem with user-selected
extensions, and **OMD+**, the selected first-party collection. Installed packages
and active behavior are separate; opt-in packages stay inactive until selected.

[Maintained integration coverage for this release](INTEGRATION.md)

[Installing OMD Core and OMD+](INSTALL.md)
