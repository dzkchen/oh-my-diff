# Terminal UI

Use it when a mod draws in the terminal. This page defines the terms the terminal pages share, lists every view
field, describes the two screen modes and how the patches of several mods compose, and lists the experimental
terminal entries. The details are on these pages:

| Page | Covers |
| --- | --- |
| [Render hooks](render-hooks.md) | `render` interceptors over native components, `tool_call` props, list rows |
| [Layout and styling](layout-and-styling.md) | Startup presentation, layouts, component types, region sizing, overlays, the box model, text styles, surface paint, view limits |
| [Terminal input](terminal-input.md) | Focus, key and paste input, keybindings, focus regions and key contexts, pointer events, `component_event`, `component_change`, component modules |
| [Graphics](graphics.md) | `image`, `terminal.image_sample`, rasters, `terminal.blit`, the underlay, process-fed rasters and pixel buffers |
| [Terminal operations](terminal-operations.md) | `terminal.*` operations, selection and clipboard, terminal identity, the `client` facts |
| [External clients](external-clients.md) | Renderers other than the terminal that draw the same view |

## Views, sites, layouts and components

A mod's `terminal` handler receives the `terminal` event, `{event, ledger, identity?, presentation?, client?,
clients?}`, and returns a `TerminalPatch` (the same type as `TerminalView`) or null. The host composes every mod's
patch into one view. The terminal surface's host features are `terminal_surface_v1`, `terminal_media_v1`,
`terminal_prompt_v1` and `terminal_pty_v1`.

| Term | Type in `api.d.ts` | Meaning | Details |
| --- | --- | --- | --- |
| View | `TerminalView` | The fields listed in [View fields](#view-fields) | this page |
| Site | `TerminalSiteName`, `TerminalRenderSite` | A named place a view fills: `sidebar`, `header`, `above_composer`, `below_composer`, `dialog`, `welcome` or a mod site `owner/name`, each with `mode` (`replace` or `wrap`), `components` and `overlay` | [Terminal patch composition](#terminal-patch-composition-ui_composition_v1) |
| Layout | `LayoutNode` | A tree of `split` and `tabs` nodes over `transcript`, `composer` and `site:` leaves | [Layouts and component types](layout-and-styling.md#layouts-and-component-types) |
| Component | `TerminalComponent` | One of 20 node types, such as `box`, `list` or `raster` | [Component types](layout-and-styling.md#component-types) |
| Region | none | A focus region: the chat or one drawn `site:` leaf | [Focus regions](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |

The `identity`, `client` and `clients` inputs are described in
[Terminal operations](terminal-operations.md#terminal-identity-terminal_identity_v1), the `presentation` input in
[Startup presentation](layout-and-styling.md#startup-presentation-terminal_welcome_v1).

## View fields

Every field of `TerminalView` in [`api.d.ts`](../api.d.ts), with its status in the conformance registry. "Type
only" means no page describes the field beyond its type.

| Field | Type | Status | Details |
| --- | --- | --- | --- |
| `welcome` | `{show_while_composing?}` | frozen | [`welcome` site](layout-and-styling.md#welcome-site) |
| `session_title_suffix` | string | frozen | [Title suffix and greeting](layout-and-styling.md#title-suffix-and-greeting) |
| `greeting` | string | frozen | [Title suffix and greeting](layout-and-styling.md#title-suffix-and-greeting) |
| `title` | string | frozen | [Default styling](layout-and-styling.md#default-styling) |
| `foreground` | number | experimental | type only |
| `background` | number | experimental | type only |
| `sidebar_width` | number | frozen | type only |
| `sidebar_side` | `left` or `right` | frozen | type only |
| `sidebar_style` | `TerminalFrameStyle` | frozen | [Box model](layout-and-styling.md#box-model-terminal_box_model_v1) |
| `panels` | `{title, lines}[]` | experimental | type only |
| `header` | `{title, lines}` | experimental | type only |
| `footer` | `{title, lines}` | experimental | type only |
| `sites` | site name to `{mode?, components?, overlay?}` | frozen | [Terminal patch composition](#terminal-patch-composition-ui_composition_v1), [Overlays](layout-and-styling.md#overlays) |
| `status` | string list | frozen | [View limits](layout-and-styling.md#view-limits) |
| `keybindings` | key name to `KeyAction` | frozen; experimental fields: `region`, `help` | [View keybindings](terminal-input.md#view-keybindings-and-command-ownership) |
| `key_contexts` | `KeyContext[]` | experimental | [Focus regions](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |
| `theme` | `TerminalTheme` | frozen | [Theme keys](#theme-keys) |
| `placeholder` | string | experimental | [View placeholder and glyphs](layout-and-styling.md#view-placeholder-and-glyphs) |
| `layout` | `LayoutNode` | frozen; experimental fields: `title`, `focus` | [Layouts](layout-and-styling.md#layouts-and-component-types) |
| `surface_styles` | `{composer?, approval?}` | experimental | [Surface paint](layout-and-styling.md#surface-paint) |
| `inline_sites` | `hidden` | frozen | [Screen modes](#alternate-screen-inline-mode-and-composer-sites) |
| `underlay` | `{raster}` | experimental | [Underlay](graphics.md#underlay-terminal_underlay_v1) |

### Theme keys

`TerminalTheme` takes the colors `accent`, `user_message_background`, `success`, `attention`, `failure`,
`diff_added`, `diff_removed` and `muted`; `syntax` (a string); `border` (`plain`, `rounded` or
`double`); `density` (`compact` or `comfortable`); `icons` (`unicode` or `ascii`); and `glyphs`
([View placeholder and glyphs](layout-and-styling.md#view-placeholder-and-glyphs)).

## Alternate screen, inline mode and composer sites

Terminal views are drawn on Codex's alternate screen, including its default fullscreen transcript. Inline
`--no-alt-screen` sessions draw the sidebar, header and dialogs inside the current viewport, and `render` hooks and
status segments apply to scrollback.

When any mod's view sets `inline_sites: 'hidden'` (`terminal_inline_sites_v1`), the inline viewport omits the
sidebar, header and named sites; dialogs, status segments, mod progress and diagnostics, the composer, approvals
and scrollback remain, and the owned fullscreen viewport is unchanged.

A launcher can narrow one session's TUI with three environment variables. `OMD_TUI_MOD_UI=ID[,ID…]` keeps sites,
panels, header, footer, layout and status segments only from the listed mods; other mods keep their `dialog` site,
`render` hooks, commands, keys and theme, and the status row holds only the listed mods' segments, without upstream
`/statusline` items or the host summary unless a mod failed. `OMD_TUI_HEADER=off` drops the Codex session header and
first-run help, and `OMD_TUI_COMPOSER=plain` draws the composer as a bare prompt line without its background,
blank rows, placeholder or idle hint row. `omd mini` sets all three. They are read once at start, and agent tool
processes don't inherit them or the launcher's `OH_MY_DIFF_*` variables (a mod's `exec_environment` still can).

The `above_composer` and `below_composer` sites draw in both modes, host-sized to their wrapped
components, directly above and below the bottom pane (composer, native hints and status row), with styles, links
and focusable controls. `above_composer` is clipped to 8 rows and `below_composer` to 6, each scrolling to the
focused control. Both are hidden while an approval or popup replaces the composer.

## Terminal patch composition (`ui_composition_v1`)

Every mod's `terminal` patch composes in the same order (`ui_composition_v1`):

- Sites wrap or replace. A wrap encloses the site's replacement whichever composes first. A site's `overlay` is not
  claimed, so the last patch that sets one wins. Only mod `owner` replaces or wraps its `owner/name` site; any other
  mod's patch for it is refused and reported as a conflict. Native sites keep the rules above.
- Presentation fields merge.
- Exclusive fields (layout, panels, header, footer, placeholder, underlay, replaced sites, keys, glyphs and the status
  budget) go to the first claimant. Each later claim is reported in `omd-mod status` under `terminal.conflicts` as
  `{field, owner, rejected, origin}`.
- A patch that breaks the composed view's limits is dropped whole.

## Reuse of `terminal` patches

The host reuses a mod's last `terminal` patch without a callback while its settings, durable state, UI state and
the `terminal` event input are unchanged.

- A patch from a callback that read the clock (`Date.now()` or `new Date()`) is reused for at most one second, so
  elapsed times and countdowns stay current on the next redraw.
- A command's `{terminal}` result likewise stands for at most one second; after that the next view update runs the
  `terminal` handler.

## Experimental session UI state

`api.uiState.get()` / `.set(value)` requires `terminal`.

- Values are bounded to 65,536 UTF-8 bytes of compact `JSON.stringify(value)` output, including quotes, keys and
  escapes.
- Strings and object keys must contain valid Unicode scalars (no lone surrogates).
- The host checks the original serialized bytes before parsing; number reformatting does not change the limit.
- Values are shared by host instances in the same process, store, repository, thread and package identity.
- Commands and component events may write; other callbacks may read.
- Writes commit only after successful validation and cancellation checks, with revision conflicts using the
  existing receipt-replay rules.
- Authority polling with unchanged configuration preserves UI state and command views.
- State is cleared on explicit reload, revocation, package changes and session teardown, and is never written to
  disk.
- A reload during a command or component event (such as one its own `packages.apply` caused) does not cancel it,
  and its `set` lands on the cleared state, even with the value it read; a change of repository during it cancels
  it.

Saved `api.state` is unchanged. Use UI state for open dialogs and filters, and saved state for preferences that
must survive a restart (a power failure can lose the last commits; `store.*` data is fully synced).

## Experimental command views

Return `{terminal: patch}` with a `TerminalPatch` to replace your complete terminal contribution, or `{terminal:
null}` to clear it.

- The host validates capability, ownership and generation, composes it with other owners' last valid contributions
  and displays it before asynchronously refreshing expired callbacks.
- Keep a `terminal` handler that reconstructs the same contribution from UI state for subsequent view updates.
- This opt-in path changes when other owners refresh; commands without `terminal` retain their synchronous preview
  behavior.
- Migration from durable dialog state consists of moving only transient presentation fields to `api.uiState` and
  returning the view from the command; persisted settings, replay and module lifetimes are unchanged.

## Experimental terminal entries

These terminal entries are experimental in the conformance registry or in
[Stability and migration](stability-and-migration.md#experimental-surfaces) and may change in any release.

| Entry | Described in |
| --- | --- |
| `raster` component, `terminal.blit` | [Graphics](graphics.md#rasters-terminal_raster_v1) |
| `terminal.image_sample` | [Graphics](graphics.md#terminalimage_sample) |
| `process_raster_v1`, `raster_pixels_v1` | [Graphics](graphics.md#raster-processes-process_raster_v1) |
| `underlay` (`terminal_underlay_v1`) | [Graphics](graphics.md#underlay-terminal_underlay_v1) |
| Render sites `user_message`, `tool_result`, `turn_duration`, `notice`, `session_mode`, `composer_hint` | [Render hooks](render-hooks.md#render-components) |
| View fields `foreground`, `background`, `panels`, `header`, `footer`, `placeholder`, `surface_styles`, `key_contexts`; the `header` site | [View fields](#view-fields) |
| Layout leaf `title` (`terminal_layout_title_v1`) and `style.focus` | [Layout and styling](layout-and-styling.md#layouts-and-component-types) |
| The `dock` component event fields `content`, `target`, `edge` (`terminal_layout_dock_v1`) | [Layout and styling](layout-and-styling.md#layout-region-sizing-split-resize-and-tab-select) |
| `code` component `start` | [Layout and styling](layout-and-styling.md#code-highlighting-terminal_code_highlight_v1) |
| Focus regions, `key_contexts`, the `region` and `help` key actions, `keys: 'all'` (`terminal_focus_v1`) | [Terminal input](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |
| The `view` and `focus` events | [Terminal input](terminal-input.md#component_event) |
| The `component_change` and `composer_key` interceptors | [Terminal input](terminal-input.md#component_change-interceptor), [Commands and composer](commands-and-composer.md#composer_key-interceptor) |
| `terminal.panes` | [Terminal operations](terminal-operations.md#terminalpane-and-terminalpanes) |
| `terminal.panel` navigation fields (`terminal_panel_navigation_v1`) | [Terminal operations](terminal-operations.md#terminalpanel) |
| `terminal` event `omd_version` and `sites` | [Terminal operations](terminal-operations.md#terminal-event-client) |
| `builtins.invoke` | [Commands and composer](commands-and-composer.md#builtinsinvoke-and-apibuiltins) |
| `api.uiState` and command views | [Experimental session UI state](#experimental-session-ui-state) |
