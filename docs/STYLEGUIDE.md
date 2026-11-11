# Terminal UI style guide

OMD adds mod views to Codex's terminal UI. Keep the conversation and composer easy to read, reuse the host's
components, and make keyboard actions predictable. These rules guide contributor choices; the API fields and
limits live in [Layout and styling](../mods/reference/layout-and-styling.md) and
[Terminal input](../mods/reference/terminal-input.md).

## Use components and semantic tones

Use `text` or rich `line` components for text, `list` for selectable rows, `input` for editing, `select` or
`multiselect` for choices, and `button` for actions. Use `document` or `diff` for content that needs scrolling and
selection. Reuse these controls before building custom key handling or drawing a control with spans.

Use the semantic tones in [`TerminalTone`](../mods/api.d.ts) for ordinary UI:

| Tone | Use |
| --- | --- |
| `normal` | Body text and ordinary values |
| `muted` | Supporting details, hints and metadata |
| `accent` | Focus or the main item that needs attention |
| `success` | A confirmed successful result |
| `attention` | A condition the user should inspect |
| `failure` | A failed operation or invalid input |

Let the terminal and active theme supply colors. Use explicit foreground/background colors only when the feature
needs them, such as a theme or image mod. Pair foreground and background deliberately, and check both light and
dark terminals. Don't use color alone to distinguish an error, selection or action; add text or a visible marker.

Use stable component `id` values and meaningful `label` values. Keep a component's identity when its content changes
so focus and selection can survive a redraw. Follow the host's view limits rather than truncating data silently.

## Fit the terminal

- Size from the terminal event's `client.columns` and `client.rows`, not an assumed desktop width. Let content wrap
  or scroll, and keep the composer and approvals usable in a small viewport.
- Keep status segments brief. Put longer details behind a command, panel or document. Avoid a dialog for a status
  update that does not require a decision.
- Check empty, loading, failed and populated states. Explain how to acquire missing data or retry a failed action.
- Respect `client.reduced_motion` and the client's graphics and pointer capabilities. Text and keyboard controls
  must still work when images or a mouse are unavailable. See [Graphics](../mods/reference/graphics.md).
- Check fullscreen and `--no-alt-screen` behavior when the change affects sites, layout or scrollback. Test resizing
  while a view is open, including long paths, Unicode text and enough rows to scroll.

## Keep keyboard behavior predictable

Use the host's focus, hotkey and action fields before implementing custom input. Enter activates the selected
action; Esc backs out through the host's normal focus rules. Preserve a clear route back to the conversation.
Use `autofocus` only when opening a view should move focus; a background refresh should not take it.

Show the shortcut that actually works. Native bindings take priority, and macOS Option keys may produce composed
characters instead of `Alt+` sequences. Read [Handle keys in a terminal view](mod-authors/handle-keys.md) before
adding bindings. Keep destructive actions explicit about what they affect, and preserve the user's draft or
selection when an action fails.

## Write messages from results

Use short, specific labels: “Reload mods” rather than “Perform reload.” Report progress while an operation runs and
success after it finishes. State what failed and what the user can do next. A preview, queued request or mock
result must not appear as a completed change. Name the actor and action, and remove vague claims and filler.

## Verify what the user sees

For a visible change, include before and after screenshots or a recording in the pull request. Record the terminal,
viewport size, relevant mod settings and the steps needed to reproduce it. Cover keyboard focus and dismissal as
well as appearance. Exercise the states and terminal modes affected by the change; list any you could not check.

Use a [scratch store](mod-authors/run-and-debug.md#run-it-in-a-scratch-store) and binaries built from the branch when
the change depends on native code. Offline scenarios and `TerminalView` assertions check the data a mod returns;
they do not prove clipping, wrapping, colors, focus delivery or pixels in a real terminal. See
[Tests](../tests/README.md) for the other checks.
