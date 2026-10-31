# Support

The platforms, versions and terminals OMD supports, how long the mod API stays stable, and which releases get
fixes. These docs describe the `main` branch, which can be ahead of the current release.

## Platforms

OMD runs only on Apple Silicon macOS. Linux and Intel Macs are unsupported: the installer refuses them, and the mod
host needs the macOS sandbox (Seatbelt) to run mods.

## Versions

| Tool | Version | Needed for |
| --- | --- | --- |
| Codex | `0.166.x` | Everything. OMD builds on the Codex you install. |
| Python | 3.12 or later | The installer and `omd update` |
| Node | 22.18 or later | The setup and model routing of `omd_profiles`, `omd_claude_cli` and `omd_cursor` |
| Node | 24.18 or a later 24.x | `omd-mod-author`, to write mods |
| pnpm | 11.14 or later | Writing mods. `omd_cursor` setup also needs `pnpm`. |

Mods themselves run in OMD's own runtime, not in Node. A few mods start Node programs, such as `omd_preview`;
their READMEs say so.

Each OMD release supports one Codex version line. Turn off automatic Codex updates, and update Codex only once
`omd update` offers an OMD release that supports the new version. The
[compatibility matrix](../mods/conformance/COMPATIBILITY.md) lists which OMD release supports which Codex version,
and what is tested.

## Terminals

Supported terminals are Kitty, Ghostty, WezTerm and Orca's terminal. Images use Kitty graphics in Kitty and Ghostty,
and inline images in Orca and WezTerm. Other terminals aren't tested; the host falls back to half-block cells or
text.

## Mod API stability

Mod API `1.0.0` is stable and supported through `2027-10-19`. Only this API version loads.

- Every public operation, event, capability and other part of the API is marked frozen or experimental in
  [the conformance registry](../mods/conformance/contract.json).
- A frozen entry keeps its shape through `2027-10-19`. A breaking change needs a new major version and a migration
  note in [Stability and migration](../mods/reference/stability-and-migration.md#migration-notes).
- An experimental entry may change in any release. So may a frozen entry's `experimental_fields`, which are fields
  added after `1.0.0`.

[Stability and migration](../mods/reference/stability-and-migration.md) lists the experimental surfaces and the
migration notes.

## Fixes and security support

Only the current release gets security fixes. Run `omd update` to get it. OMD is a one-person project, so replies
are best effort. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## See also

- [Install](install.md)
- [How OMD works](how-omd-works.md)
