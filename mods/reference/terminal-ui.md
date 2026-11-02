# Terminal UI

Use it when a mod draws in the terminal. This page defines the terms the terminal pages share, lists every view
field, and describes the two screen modes and how the patches of several mods compose.

Entries are frozen in Mod API `1.0.0` unless marked experimental; the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry) lists the experimental ones. The
terminal runs on Apple Silicon macOS; [external clients](external-clients.md) draw the same view elsewhere.

The details are on these pages:

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
patch into one view. A package that draws in the terminal lists the [host features](glossary.md#mods-and-the-host)
it uses in `required_features`. The terminal's features are `terminal_surface_v1`, `terminal_media_v1`,
`terminal_prompt_v1` and `terminal_pty_v1`. `terminal_pty_v2` is experimental.

| Term | Type in `api.d.ts` | Meaning | Details |
| --- | --- | --- | --- |
| View | `TerminalView` | The fields listed in [View fields](#view-fields) | this page |
| Site | `TerminalSiteName`, `TerminalRenderSite` | A named place a view fills: `sidebar`, `header`, `above_composer`, `below_composer`, `dialog`, `welcome` or a mod site `owner/name`, each with `mode` (`replace` or `wrap`), `components` and `overlay` | [Terminal patch composition](#terminal-patch-composition-ui_composition_v1) |
| Layout | `LayoutNode` | A tree of `split` and `tabs` nodes over `transcript`, `composer` and `site:` leaves | [Layouts and component types](layout-and-styling.md#layouts-and-component-types) |
| Component | `TerminalComponent` | One of 20 node types, such as `box`, `list` or `raster` | [Component types](layout-and-styling.md#component-types) |
| Region | none | A focus region is the chat or one drawn `site:` leaf. A layout region is the area a layout leaf draws in. | [Focus regions](terminal-input.md#focus-regions-key-contexts-and-help-terminal_focus_v1) |

The `identity`, `client` and `clients` inputs are described in
[Terminal operations](terminal-operations.md#terminal-identity-terminal_identity_v1), the `presentation` input in
[Startup presentation](layout-and-styling.md#startup-presentation-terminal_welcome_v1).

## View fields

Every field of `TerminalView` in [`api.d.ts`](../api.d.ts), with its status in the conformance registry. "Type
only" means no page describes the field beyond its type.

| Field | Type | Status | Details |
| --- | --- | --- | --- |
| `welcome` | `{show_while_composing?, hidden?}` | frozen; `hidden` is experimental | [`welcome` site](layout-and-styling.md#welcome-site) |
| `session_title_suffix` | string | frozen | [Title suffix and greeting](layout-and-styling.md#title-suffix-and-greeting) |
| `greeting` | string | frozen | [Title suffix and greeting](layout-and-styling.md#title-suffix-and-greeting) |
| `title` | string | frozen | [Default styling](layout-and-styling.md#default-styling) |
| `foreground` | number | experimental | type only |
| `background` | number | experimental | type only |
| `sidebar_width` | number | frozen | [Default styling](layout-and-styling.md#default-styling) |
| `sidebar_side` | `left` or `right` | frozen | [Default styling](layout-and-styling.md#default-styling) |
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

By default Codex draws on the alternate screen, which this reference calls fullscreen mode, and terminal views draw
there, including in the fullscreen transcript. Inline mode (`--no-alt-screen`) draws the sidebar, header and dialogs
inside the current viewport. In inline mode, `render` hooks and status segments apply to scrollback.

When any mod's view sets `inline_sites: 'hidden'` (`terminal_inline_sites_v1`), the inline viewport omits the
sidebar, header and named sites. Dialogs, status segments, mod progress and diagnostics, the composer, approvals and
scrollback still draw. Fullscreen mode is unchanged.

A program that launches `codex` can narrow one session's terminal UI (TUI) with three environment variables.
`omd mini` sets all three.

| Variable | Effect |
| --- | --- |
| `OMD_TUI_MOD_UI=ID[,ID…]` | Keeps sites, panels, header, footer, layout and status segments only from the listed mods. |
| `OMD_TUI_HEADER=off` | Drops the Codex session header and first-run help. |
| `OMD_TUI_COMPOSER=plain` | Draws the composer as a bare prompt line without its background, blank rows, placeholder or idle hint row. |

- With `OMD_TUI_MOD_UI` set, unlisted mods still contribute their `dialog` site, `render` hooks, commands, keys and
  theme.
- The status row contains only the listed mods' segments. It shows no upstream `/statusline` items, and shows the
  host summary only when a mod failed.

The variables are read once at start. Agent tool processes don't inherit them or the launcher's `OH_MY_DIFF_*`
variables. A mod can still pass `OH_MY_DIFF_*` variables to its commands by listing them in its
[`exec_environment`](authority-grants.md#exec_environment-names).

The `above_composer` and `below_composer` sites draw in fullscreen and inline mode, directly above and below the bottom
pane. The bottom pane is the composer, the native hints and the status row. The host sizes each site to its wrapped
components, which can use styles, links and focusable controls. `above_composer` is clipped to 8 rows and
`below_composer` to 6, each scrolling to the focused control. Both are hidden while an approval or popup replaces the
composer.

## Terminal patch composition (`ui_composition_v1`)

Every mod's `terminal` patch composes in the same order (`ui_composition_v1`):

- Sites wrap or replace. A wrap encloses the site's replacement, whichever of the two patches composes first. A
  site's `overlay` is not claimed, so the last patch that sets one wins
  ([Overlays](layout-and-styling.md#overlays)). Only mod `owner` replaces or wraps its `owner/name` site; any other
  mod's patch for it is refused and reported as a conflict. Any mod can patch a native site, such as `sidebar` or
  `welcome`, under the wrap, replace and overlay rules at the start of this item.
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
- The host shows a command's `{terminal}` result for at most one second. After that, the next view update runs the
  `terminal` handler.

Session UI state is described under [`api.uiState`](state-and-storage.md#session-ui-state-apiuistate), and command
`{terminal}` results under [Command views](commands-and-composer.md#command-views).
