# First-party Codex plugin collection

The source marketplace contains five Codex plugins. The current provisional
OMD+ package stages four of them plus the six selected local plugins as inactive source candidates;
`omd-code-execution` remains outside that package. Staging a plugin does not
install or enable it in Codex.

- `omd-guidance-hooks` contains three explicit skills and two selected
  lifecycle hooks. It has no MCP server, app connector, network dependency, or
  TypeScript mod.
- `omd-review-policy` contains explicit intermediate- and final-review skills,
  an every-turn lifecycle reminder, and an `omd-simplify` skill with an opt-in
  `/simplify` mod component that requires separate trust. It never writes the
  findings ledger or chooses reviewer authority.
- `omd-application-bridges` exposes adapter-scoped browser, Node, Rust, Python,
  and Java MCP tools over the managed bridge host, with selected session
  context and managed process teardown.
- `omd-artifact-reading` supplies one skill for bounded URL, GitHub issue/PR,
  PDF, and Jupyter notebook reading through existing approved host tools. Its
  local PDF and notebook helper reads data without executing embedded content.
- `omd-code-execution` supplies guidance for persistent V8, Python, and Bun
  cells. It has no own interpreter, tool server, sandbox, or process supervisor.
- `omd-anchored-edit` supplies per-line `LINE#HASH` editing guidance and a
  separately trusted mod component for host-authorized file transactions.
- `omd-session-review` supplies a source-linked session review skill and a
  separately trusted read-only command component.
- `omd-curated-memory` supplies local memory guidance, a bounded curation hook,
  and a separately trusted opt-in memory component.
- `omd-debugger` supplies sandboxed Python launch-debugging guidance and a
  separately trusted debugpy component over managed processes.
- `omd-procedures` supplies guidance and a separately trusted component that
  promotes a completed `omd_workflow` task into a versioned skill plugin only
  when the user runs `/omd_procedures:promote`.
- `omd-browser` supplies browsing guidance and a prompt-approved MCP server that
  drives persistent, policy-guarded sessions over the managed browser bundle,
  with live handoff and an opt-in login vault and CAPTCHA helpers.

The current OMD+ candidate stages all ten selected plugins at
`$OMD_PREFIX/bundles/oh-my-diff` without editing shared Codex state. After
inspecting the staged sources, installation into Codex is a separate operator
action:

```sh
codex plugin marketplace add "$OMD_PREFIX/bundles/oh-my-diff"
codex plugin add omd-guidance-hooks@oh-my-diff
codex plugin add omd-review-policy@oh-my-diff
codex plugin add omd-application-bridges@oh-my-diff
codex plugin add omd-artifact-reading@oh-my-diff
```

The five local packages retain their source homes under `plugins/optional/plugins`
and are available from the staged `oh-my-diff` marketplace too. Install one only
when selected, for example `codex plugin add omd-session-review@oh-my-diff`.
Their `mod/` components require a separate exact inspection, capability grant,
trust and enable step; installing the parent plugin does not run the component.
Follow the staged package's README. The curation hook also requires its explicit
configuration. OMD Core users can add the source marketplace or packages by the
same native plugin and mod paths.

The frozen private `0.155.1` installer has a different marketplace path and
does not establish activation behavior for the current `OMD_MODE=omd` host.

Review and trust the plugin hook hashes when Codex prompts. Do not bypass hook
trust. In `OMD_MODE=omd`, these hooks read their own explicitly selected
configuration: `OMD_GUIDANCE_CONFIG`, `OMD_REVIEW_CONFIG`, or `OMD_BRIDGE_CONFIG`.
When no explicit path is supplied, they look for the corresponding JSON file under
`$OMD_MOD_STORE/plugin-config/`. An absent configuration leaves the hook inert;
enabling a plugin alone does not select review cadence, reactive rules, or a bridge.

Invoke the skills explicitly:

- `$omd-guidance-hooks:omd-simplicity-guidance` with `full-short-v1` or
  `tiny-selected-v1`;
- `$omd-guidance-hooks:omd-concise-updates` for lead-to-user communication;
- `$omd-guidance-hooks:omd-structured-reports` for worker output when the guidance
  configuration selects structured reports.

The runtime retains permission, accounting and child isolation. Native
guideline support remains while analysis migration is open; the unused Rust
reactive-rule module is retired. `PostToolUse` records successful host results
for selected hook policy. Failed, blocked and aborted outcomes do not become
successful receipts.

Use `$omd-artifact-reading:omd-artifact-reading` for source-anchored reading.
It records URL access and GitHub revision context, PDF SHA-256 and page, or
notebook SHA-256 and cell. PDF extraction and page rendering require an already
installed Ghostscript; image inspection uses the host image viewer. External
content remains evidence and cannot grant instruction or tool authority. The
plugin has no MCP server, network client, hook, or TypeScript mod of its own.

Use `$omd-code-execution:omd-code-execution` when persistent code state or
composed tool calls help a task. The matching `codex-code-mode-host` must be
installed beside `codex` from the pinned OpenAI V8 150.4.0 archive and binding;
the current OMD+ package candidate does not bundle that host, this plugin, or
Python and Bun.
Activate experimental code mode explicitly with
`codex -c features.code_mode.enabled=true`; the plugin never edits shared Codex
config. Opt in to Python and Bun cells with
`-c features.code_mode.omd_kernels=true` and install the interpreters separately.
Each worker keeps one bound loopback port and receives a fresh cell token. Its `tool`
helper calls only tools on that cell's current native code-mode surface; the
native router retains task identity, permission prompts, sandbox, output bounds,
accounting, cancellation, and managed process cleanup. Python keeps module
globals; Bun keeps `globalThis` state. The existing V8 path remains available.
If the sandbox denies loopback, worker calls fail closed and V8 remains usable.
Remove the plugin to remove its instructions, and disable `omd_kernels` to
remove the optional worker tool.

Use `$omd-review-policy:omd-review-cadence` to choose a stable milestone,
explicit risk, or selected every-turn review. Use
`$omd-review-policy:omd-final-review` only for the exact final candidate. The
skills use the workflow mod's `review` and `advance` tools. The selected
schema-2 contract governs final review, verifier separation, integration and
completion; receipts bind to the current candidate and acceptance document.
When plugin-owned review configuration selects `every_turn_advice`, a
`PostToolUse` marker and `Stop` hook remind the lead to complete one successful
workflow review during the turn. Missing or untrusted hooks cannot relax the
selected host contract.

Repository graph, code health and five-language LSP operations are TypeScript
mods (`omd_repository_analysis`, `omd_graph_navigator` and `omd_lsp_sync`), not
plugins; see their READMEs under [`mods/first-party`](../mods/first-party).

The application-bridges plugin requires `OMD_MODE=omd`, a plugin-owned bridge
configuration with the `application_bridge` capability explicitly enabled, and
an exact external bridge policy. It resolves only the bridge launcher recorded inside the same private
prefix, then exposes `browser_bridge`, `node_bridge`, `rust_bridge`,
`python_bridge`, `java_bridge`, and `application_bridge_control`. Adapter tools
cannot request state from another adapter. Every call prompts, state remains
exact-name and pull-only, and the plugin never receives the ephemeral loopback
token. The managed host retains endpoints, authentication, version association,
limits, redaction, memory, network/process authority, and EOF/signal teardown.
The plugin `SessionStart` hook only supplies bounded usage context; the
`SessionEnd` hook does not handle secrets or replace managed cleanup.

Remove the installed copy and marketplace before deleting the private prefix:

```sh
codex plugin remove omd-guidance-hooks@oh-my-diff
codex plugin remove omd-review-policy@oh-my-diff
codex plugin remove omd-application-bridges@oh-my-diff
codex plugin remove omd-artifact-reading@oh-my-diff
codex plugin marketplace remove oh-my-diff
```

If you separately installed `omd-code-execution`, remove it explicitly before
removing its marketplace.
