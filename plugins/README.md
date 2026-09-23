# Bundled Codex plugins

OMD ships seven Codex plugins in the local `oh-my-diff` marketplace:

- `omd-guidance-hooks` contains three explicit skills and two controlled
  lifecycle hooks. It has no MCP server, app connector, network dependency, or
  TypeScript mod.
- `omd-repository-tools` exposes the retained `omd-graph` and `omd-health`
  operators through seven prompt-approved local MCP tools and includes the
  `$omd-repository-tools:omd-code-health` skill. It has no network dependency,
  app connector, hook, or TypeScript mod.
- `omd-lsp-adapters` exposes separate Rust, TypeScript, JavaScript, Python, and
  Java MCP tools over the retained native `omd-lsp` operator. It owns the
  language-specific commands and explicit fallback presentation, but no
  language-server, source-write, permission-grant, or edit authority.
- `omd-review-policy` contains explicit intermediate- and final-review skills
  plus an every-turn lifecycle reminder. It never writes the findings ledger or
  chooses reviewer authority.
- `omd-application-bridges` exposes adapter-scoped browser, Node, Rust, Python,
  and Java MCP tools over the managed bridge host, with selected session
  context and managed process teardown.
- `omd-artifact-reading` supplies one skill for bounded URL, GitHub issue/PR,
  PDF, and Jupyter notebook reading through existing approved host tools. Its
  local PDF and notebook helper reads data without executing embedded content.
- `omd-code-execution` supplies one skill for persistent native JavaScript code
  mode and optional Python through native managed execution. It has no own
  interpreter, tool server, sandbox, or process supervisor.

The private installer copies the hash-pinned marketplace to
`$OMD_PREFIX/plugins/oh-my-diff` without editing shared Codex state. Installation
into Codex is a separate operator action:

```sh
codex plugin marketplace add "$OMD_PREFIX/plugins/oh-my-diff"
codex plugin add omd-guidance-hooks@oh-my-diff
codex plugin add omd-repository-tools@oh-my-diff
codex plugin add omd-lsp-adapters@oh-my-diff
codex plugin add omd-review-policy@oh-my-diff
codex plugin add omd-application-bridges@oh-my-diff
codex plugin add omd-artifact-reading@oh-my-diff
codex plugin add omd-code-execution@oh-my-diff
```

Review and trust the plugin hook hashes when Codex prompts. Do not bypass hook
trust. The hooks do nothing unless `OMD_MODE=enabled` and the active controlled
manifest selects the corresponding communication or reactive capability.

Invoke the skills explicitly:

- `$omd-guidance-hooks:omd-simplicity-guidance` with `full-short-v1` or
  `tiny-selected-v1`;
- `$omd-guidance-hooks:omd-concise-updates` for lead-to-user communication;
- `$omd-guidance-hooks:omd-structured-reports` for worker output when the controlled manifest
  selects structured reports.

The native runtime remains authoritative for guideline promotion and rollback,
instruction priority, held-out isolation, structured report admission, reactive
rule bounds, permissions, accounting, child isolation, and context rebuilds.
The `PostToolUse` hook records exact successful host events for native
consumption. Codex does not emit `PostToolUse` for failed, blocked, or aborted
calls, so the existing native lifecycle contributor remains the bounded fallback
for those measured event gaps and for an absent or untrusted hook.

Use `$omd-artifact-reading:omd-artifact-reading` for source-anchored reading.
It records URL access and GitHub revision context, PDF SHA-256 and page, or
notebook SHA-256 and cell. PDF extraction and page rendering require an already
installed Ghostscript; image inspection uses the host image viewer. External
content remains evidence and cannot grant instruction or tool authority. The
plugin has no MCP server, network client, hook, or TypeScript mod of its own.

Use `$omd-code-execution:omd-code-execution` when persistent code state or
composed tool calls help a task. The private install builds and pins the
matching `codex-code-mode-host` beside `codex` using the exact OpenAI V8 150.4.0
archive and binding. Activate experimental code mode explicitly with
`codex -c features.code_mode=true`; the plugin never edits shared Codex config.
JavaScript cells retain session state and re-enter the normal host tool router.
Python is optional: when a task needs Python state or libraries, a JavaScript
cell starts an interactive Python process through native `exec_command` and
drives it through native `write_stdin`. Python has no separate direct Codex tool
API; JavaScript invokes any further tools through the host. Permission prompts,
sandbox, process lifetime, output limits, cancellation, and accounting remain
native. Remove the plugin to remove its instructions; code-mode availability is
still controlled by the user's Codex configuration.

Use `$omd-review-policy:omd-review-cadence` to choose a stable milestone,
explicit risk, or selected every-turn review. Use
`$omd-review-policy:omd-final-review` only for the exact final candidate. The
skills call the existing native `omd_review` tool; the native ledger retains
finding identity, limits, repairs, checks, required reviewer separation, drift
invalidation, integration refusal, and completion evidence. When the controlled
manifest explicitly selects `every_turn_advice`, a `PostToolUse` marker and
`Stop` hook remind the lead to complete one successful native review during the
turn. Missing or untrusted hooks cannot relax the mandatory native final review.

The repository plugin requires the managed `omd-graph` and `omd-health`
executables on `PATH`. Its tool server accepts only a canonical absolute
repository and normalized repository-relative artifact paths, refuses symlinked
or escaping paths, bounds request/runtime/output sizes, and invokes the Rust
operators without a shell. Every returned artifact includes a SHA256 receipt,
and health-report paging refuses a file that no longer matches its check
receipt. Every tool call prompts through Codex. A health exit code of 2 is
returned as a completed report with introduced findings, while other nonzero
exits remain refusals. The tool never edits source.

Use `graph_snapshot` to create the JSON graph and deterministic static HTML,
then `graph_validate`, `graph_html`, or `graph_select` against fresh source.
The existing native `/graph` view remains the optional live terminal navigator
over that same JSON; no second terminal mod is required. Use the health skill to
create an explicitly approved baseline, run the one-shot check, and page through
introduced, debt, and uncertain findings without treating repair scope as edit
authorization.

The LSP plugin requires the managed `omd-lsp` executable on `PATH` and the same
canonical external preference store and exact repository identity selected by
the controlled manifest. Bind and enable that identity explicitly with
`omd-lsp preference STORE REPOSITORY_ID enabled REPOSITORY`; the plugin never
enables a repository or installs a server. Its
five prompt-approved tools are `rust_lsp`, `typescript_lsp`, `javascript_lsp`,
`python_lsp`, and `java_lsp`. Each supports `status`, `diagnostics`,
`definition`, `references`, `code_actions`, `apply_code_action`,
`rename_symbol`, and `rename_file` commands.

Pass the complete coherent path batch before every semantic command. Applying a
code action or rename also requires the complete affected scope and the current
SHA256 of every existing path, or `null` for an absent destination. The native
operator alone admits responsive installed servers, bounds startup and requests,
synchronizes documents, validates UTF-16 edits and exact scope/hashes, writes
atomically, rolls back failed synchronization, and terminates the server before
the tool returns. Missing servers and capabilities remain visible `unsupported`
results with ordinary search/edit/check guidance; they are never presented as
passed semantic evidence. Removing the plugin leaves the native `omd_lsp`
session tool and repository preference unchanged.

The application-bridges plugin requires an enabled OMD controlled manifest with
the default-off `application_bridge` capability and an exact external bridge
policy. It resolves only the bridge launcher recorded inside the same private
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
codex plugin remove omd-repository-tools@oh-my-diff
codex plugin remove omd-lsp-adapters@oh-my-diff
codex plugin remove omd-review-policy@oh-my-diff
codex plugin remove omd-application-bridges@oh-my-diff
codex plugin remove omd-code-execution@oh-my-diff
codex plugin marketplace remove oh-my-diff
```
