# TypeScript terminal experience acceptance

Date: 2026-09-22

## Outcome

The terminal batch is complete. The retained preview ships three first-party
mods, with `omd_workspace@0.2.0-preview.1` owning the customizable terminal
experience through public mod API `0.1.0-experimental.7`. The separately
packaged theme and focus-flow prototypes were built and exercised, then removed
because both failed their roadmap keep gates.

The machine-readable result and measurements are retained in
[`evidence/typescript-terminal-experience-20260922/summary.json`](evidence/typescript-terminal-experience-20260922/summary.json).

## Public terminal surface

The current API adds `terminal_components_v1` and
`terminal_render_sites_v1`. A terminal replacement publishes a bounded base
view; current-API observers may compose transactional patches in deterministic
dependency order. The supported component tree contains box, text, button,
input, select, Markdown, code, pane, dialog and exactly-one-child wrapper slots
at sidebar, header, above-composer and dialog sites.

Rust retains the terminal driver, native composer and caret, effective-mode and
recovery visibility, keyboard and pointer dispatch, focus, scrolling, redraw,
resize, component validation, accessible labels, clipboard authorization,
cancellation, inline/headless/narrow fallbacks and terminal restoration. Mods
cannot emit terminal escapes, mutate the transcript or evidence, intercept
reserved cancellation keys, bypass native clipboard handling or hide native
recovery diagnostics.

`omd_workspace` now renders task, remaining-step, worker, allowance and activity
panes; a header and above-composer shortcuts; compact/full and left/right
layouts; message/tool presentation; and an F8 settings dialog containing
selectors, input, copy and close actions. Command results carry a freshly
recomposed preview back to the TUI, so live state changes do not race a stale
snapshot. Focus, selector/input values and pane scroll survive redraw and
resize. A modal forces a full-height frame and uses compact row spacing so all
controls remain reachable at comfortable density.

## Optional package keep gates

The theme prototype supplied midnight, paper and high-contrast palettes,
semantic diff/status colors, border/icon and density choices, live preview,
ASCII and terminal-capability fallback. The focus-flow prototype wrapped task
and worker surfaces, grouped only successful completed agent tool output, kept
failures and active work visible, and offered a keyboard toggle. Their behavior
worked in the PTY and native rendering tests.

They were not retained. Fifteen randomized cold host activations per
combination measured a 388.854 ms workspace-only median, 495.872 ms with theme
(+107.018 ms), 493.179 ms with focus-flow (+104.325 ms), and 598.759 ms with
both (+209.905 ms). Twenty host-telemetry samples measured a 104.673 ms median
theme callback and 103.850 ms median focus-flow callback. These are clearly
measurable startup and recomposition costs; theme fails its explicit cost gate,
and focus-flow fails its no-responsiveness-regression gate. Their source,
preview entries, locks, settings, docs and installer expectations were removed.
The generic public theme and completed-tool presentation fields remain for
outside authors and future lower-overhead implementations.

## Automated acceptance

- The engine-owned offline runner mounts and activates terminal components and
  preserves zero paid requests.
- Fresh-replay `codex-omd` tests pass, including validation limits,
  transactional composition, dependency order and `.6` observer compatibility.
- All 23 `codex-omd-extension` tests and seven focused TUI terminal tests pass.
- Five physical PTY profiles pass: legacy mod, extension fullscreen, extension
  inline, focused settings dialog, and the retained preview lifecycle. They
  cover keyboard interaction, streaming, narrow/large resize, live source and
  settings reload, session preservation, broken-mod isolation, native recovery,
  clean disable, cancellation and terminal restoration.
- `mise run mods:check`, all 11 Node runner tests, 23 focused Python tests with
  five environment skips, Python compilation, and the 30-decision/12-rule
  conformance contract pass.
- Fresh-replay Rust formatting and warning-clean scoped Clippy pass.
- Patch `9ed3a885f7112cfa3a843e53f285d681c057ac8ee11e6c8ccbda25aea2628685`
  applies over 157 pinned destinations from a fresh normalized
  `rust-v0.155.1` checkout, applies a second time as a no-op, and is byte-equal
  to the tested work checkout.

## Boundaries

Desktop, VS Code and mobile rendering remain outside the initial breadth
release. Copy actions are validated through component activation and native
clipboard dispatch/authorization; this audit does not claim a manual macOS
pasteboard readback. No provider request or paid benchmark was used.
