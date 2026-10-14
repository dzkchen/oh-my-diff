# First-party Codex plugin collection

The bundled `oh-my-diff` marketplace (`plugins/bundled/oh-my-diff`) contains
three Codex plugins. The OMD+ package stages all three as inert source
packages. Staging a plugin does not install or enable it in Codex.

`release-files.json` declares every bundled release file relative to the
marketplace directory. Update this list deliberately when adding or removing
release sources, then regenerate the plugin lock. Unlisted scratch files,
dependencies and build outputs do not enter the package. Declared files must
exist and cannot be symlinks.

Plugins outside this launch collection are not shipped.

- `omd-artifact-reading` supplies one skill for bounded URL, GitHub issue/PR,
  PDF, and Jupyter notebook reading through existing approved host tools. Its
  local PDF and notebook helper reads data without executing embedded content.
- `omd-code-execution` supplies guidance for V8, Python, and Bun
  cells. It has no own interpreter, tool server, sandbox, or process supervisor.
- `omd-anchored-edit` supplies per-line `LINE#HASH` editing guidance and a
  separately trusted mod component for host-authorized file transactions.

The OMD+ package stages the plugins at `$OMD_PREFIX/bundles/oh-my-diff`
without editing shared Codex state. After
inspecting the staged sources, installation into Codex is a separate operator
action. `omd-package plugins` adds the marketplace through the installer's
`current` link, which survives updates (`codex plugin marketplace add` would
record the release-specific path, which a later update removes):

```sh
omd-package plugins
codex plugin add omd-anchored-edit@oh-my-diff
codex plugin add omd-artifact-reading@oh-my-diff
codex plugin add omd-code-execution@oh-my-diff
```

Install a plugin only when selected. The `mod/` components of
`omd-anchored-edit` and `omd-artifact-reading` require a separate exact
inspection, capability grant, trust and enable step; installing the parent
plugin does not run the component. Follow the staged package's README. OMD Core
users can add the source marketplace or packages by the same native plugin and
mod paths.

None of the three plugins ships a hook.

Use `$omd-artifact-reading:omd-artifact-reading` for source-anchored reading.
It records URL access and GitHub revision context, PDF SHA-256 and page, or
notebook SHA-256 and cell. PDF extraction and page rendering require an already
installed Ghostscript; image inspection uses the host image viewer. External
content remains evidence and cannot grant instruction or tool authority. The
plugin has no MCP server or hook; its separately trusted GitHub reading
component is described in its README.

Use `$omd-code-execution:omd-code-execution` when persistent code state or
composed tool calls help a task. The OMD+ package installs the matching
`codex-code-mode-host`, built from the same pinned tree, beside `codex` and
stages this plugin's source; it does not bundle Python or Bun.
Activate experimental code mode explicitly with
`codex -c features.code_mode.enabled=true`; the plugin never edits shared Codex
config. Configure Python and Bun in `features.code_mode.kernels` with the
installed driver paths and exact SHA-256 hashes shown in the
[code-execution skill](bundled/oh-my-diff/plugins/omd-code-execution/skills/omd-code-execution/SKILL.md),
and install the interpreters separately.
Each worker keeps one bound loopback port and receives a fresh cell token. Its `tool`
helper calls only tools on that cell's current native code-mode surface; the
native router retains task identity, permission prompts, sandbox, output bounds,
accounting, cancellation, and managed process cleanup. Python keeps module
globals; Bun keeps `globalThis` state. The existing V8 path remains available.
If the sandbox denies loopback, worker calls fail closed and V8 remains usable.
Remove the plugin to remove its instructions, and remove the kernel entries to
remove the optional worker tool.

Five-language LSP operations are TypeScript mods (`omd_lsp_sync` and
`omd_lsp_view`), not plugins; see their READMEs under
[`mods/first-party`](../mods/first-party).

Remove the installed copies and marketplace before deleting the private prefix:

```sh
codex plugin remove omd-anchored-edit@oh-my-diff
codex plugin remove omd-artifact-reading@oh-my-diff
codex plugin remove omd-code-execution@oh-my-diff
codex plugin marketplace remove oh-my-diff
```

Plugin removal alone does not remove a separately trusted mod component;
disable that component as well.
