# Theme

`omd_theme` (`0.4.0-candidate.2`) is installed inactive in OMD+ and can be installed explicitly in OMD Core. Enable it through the ordinary mod manager, then use `/omd_theme:style`. It uses the public API; it does not require the workspace or logo mod.

Choose OMD Night (the default: a quiet charcoal surface with one muted blue-grey accent), Midnight, Paper, High contrast, Frost, Graphite or Amber, or import a palette. Your own messages sit on a slightly raised block derived from the background, kept at 4.5:1 contrast for every tone, so they stand apart from replies. Code highlighting follows the palette background: Catppuccin Latte on light backgrounds and Catppuccin Mocha on dark ones, replacing the configured syntax theme while the mod is active. Changes preview immediately. **Save** retains them, **Discard preview** restores the saved selection, and **Reset** returns to configured defaults and clears the backdrop selection. Settings survive reload and disable/enable. Startup greetings are hidden by default; the Greeting page enables a custom message. The logo mod supplies the same hidden default while the theme is inactive.

The keyboard-driven pages offer background/text RGB colors, ASCII/Unicode symbols, image or ASCII backdrops, center/fit/fill/tile placement, scale, cell offsets, tint, dimming and opacity. The Glass page adds static highlights, shading and borders to the prompt and backdrop. Text cells and image pixels approximate glass; there is no blur, window transparency, material shader or animation. Foreground contrast is corrected to at least 4.5:1 against known RGB surfaces. Image dimming and tint may be adjusted to preserve that contrast, so a low requested dimming value can produce a more subdued image.

All actions also work through namespaced commands, including in terminals too small for the settings dialog:

```text
/omd_theme:set palette paper
/omd_theme:set composer_gloss true
/omd_theme:set background_color #182030
/omd_theme:load ghostty /path/to/theme
/omd_theme:load iterm2 /path/to/colors.itermcolors
/omd_theme:load warp /path/to/theme.yaml
/omd_theme:ascii /path/to/art.txt
/omd_theme:image /path/to/backdrop.png
/omd_theme:save
/omd_theme:cancel
/omd_theme:reset
/omd_theme:close
```

## Powerline status line and prompt stash

The **status** page (or `/omd_theme:set statusline PRESET`) turns on a powerline status line; it is `off` by default.

| Preset | Segments |
| --- | --- |
| `default` | model, reasoning, folder, Git, context, spend, OMD, stash |
| `minimal` | folder, Git, context |
| `compact` | model, Git, spend, context, stash |
| `full` / `nerd` | model, reasoning, path, Git, tokens, spend, context, session, OMD, stash |
| `ascii` | model, reasoning, path, Git, tokens, spend, context, stash |

Segments without data are left out. Git shows the branch, ahead/behind and staged (`+`), unstaged (`*`) and untracked (`?`) counts, refreshed when the status line is turned on, at session start, after each turn and every 10 s. Context shows the share of the model's window used by the last request, in the success color below 70%, attention from 70% and failure from 90%. Model, reasoning, provider and tokens come from the session's own `thread/settings/updated` and `thread/tokenUsage/updated` notifications (sub-agent threads never replace them), with `config/read` before the first turn. Spend is the OMD ledger's settled paid charge; OMD shows the active mod count and a non-OpenAI route provider.

`nerd` uses Nerd Font icons and powerline arrows. Other presets use them when the terminal looks like Ghostty, Kitty, WezTerm, Alacritty or iTerm2 (the same heuristic as the source package) and plain colored blocks otherwise; `ascii` and `NO_COLOR` use ASCII text with `|` separators. The line is one row: a narrow terminal cuts it at the right edge, so presets put the most important segments first.

`statusline_position` is `above` (default) or `below` the composer. Below, the host offers only Codex's status row: the theme adds one plain segment with OMD state (active mods, route, spend, a context warning from 70% and the stash marker), and model, path, branch and context come from Codex's own `/statusline` items.

**Stash.** Alt+z (or `/omd_theme:stash`) stashes the composer draft and clears it; Alt+z with an empty composer restores it; with both a draft and a stash it replaces the stash. `/omd_theme:stash list` shows the 12 most recent stashed drafts and `/omd_theme:stash N` inserts one at the cursor. Stashes are kept per repository in mod storage and survive restarts; drafts over 16 KiB are not stashed. The `stash` segment shows while one is held.

Imports require the native file confirmation. Declined, denied or invalid files preserve the current selection. Text imports are bounded to 64 KiB; ASCII is printable ASCII plus newlines, at most 8 KiB. PNG/JPEG imports are at most 8 MiB and 4096 × 4096 pixels. A bounded 80 × 24 image sample supplies the ASCII fallback. Package-lifetime images are copied into the owner’s immutable resource store and never reread from their original path. They survive configuration changes and new sessions for the same exact package source. A source upgrade requires explicit reimport; the saved ASCII fallback remains usable. Reset clears selections; retained blobs remain within the existing host quotas (256 MiB/4096 blobs and 64 MiB/1024 resource records per owner) until the mod store is removed.

Palette imports retain foreground/background and map ANSI red, green, yellow, blue and bright black to semantic tones. Contrast correction can change the imported tone. Other terminal configuration is ignored and cannot execute commands or read referenced paths.

| Format | Accepted colors | Limits |
| --- | --- | --- |
| [Ghostty](https://ghostty.org/docs/config/reference#palette) | Six-digit RGB `foreground`, `background`, and decimal `palette = N=RGB` | Named/X11 colors and include resolution are not imported. |
| [iTerm2](https://iterm2.com/documentation-preferences-profiles-colors.html) ([primary plist source](https://github.com/gnachman/iTerm2/blob/master/plists/ColorPresets.plist)) | XML `.itermcolors` RGB components, foreground/background and ANSI slots | Binary plists, entities and non-sRGB color spaces are unsupported. |
| [Warp](https://docs.warp.dev/terminal/appearance/custom-themes) | Quoted/unquoted six-digit RGB YAML scalars, normal/bright ANSI colors | Color gradients become their midpoint palette color; referenced images, cursor settings, tags and general YAML features are not imported. |

| Environment | Backdrop and gloss behavior |
| --- | --- |
| Local Ghostty, Kitty, WezTerm; owned/fullscreen viewport | Detected Kitty graphics: PNG/JPEG with pixel tint/dim/opacity and optional gradient overlay; static cell gradients on the prompt. |
| iTerm2, Warp or terminals without the detected protocol | Image-derived ASCII and cell gradients when color is available; no iTerm2 inline-image or Sixel implementation. |
| SSH, tmux or reduced motion | ASCII fallback and static color surfaces; no graphic transmission or animation. |
| Inline viewport | ASCII fallback, cell surfaces and keyboard controls in the current viewport; earlier terminal scrollback remains terminal-owned. Image placement is restricted to the owned viewport. |
| `NO_COLOR` | Native plain output; custom colors, backgrounds and gloss are omitted. |
| Narrow/resize | Image/ASCII decoration omitted below 60 columns; solid palette surfaces, native text, input and commands remain. The dialog requires 48 columns and 14 rows. |

Kitty placement uses `z=-1`, below text and above cell backgrounds under the [protocol’s layering rules](https://sw.kovidgoyal.net/kitty/graphics-protocol/#controlling-displayed-image-layout). Image geometry assumes cells twice as tall as they are wide and uses a bounded 2048 × 2048 working canvas. Borders occupy blank edge cells and never replace input text. Explicit native foregrounds, styled diff backgrounds, failures and approval content are preserved. Disabling or a broken mod restores the native presentation; the welcome mark and status belong to their own mods.

Ported from [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) 0.18.0 (Nico Bailon, MIT; see `../../../THIRD_PARTY_NOTICES.md`): presets, segments, context thresholds, Nerd Font detection and the stash toggle. This package reimplements that behavior and copies no code; loading vibes, bash mode, delayed send, the welcome overlay and the queue are not ported.

The [earlier theme rejection](../../../.docs/audits/theme-focus-revisit-20260922.md) remains unchanged: +57.708 ms cold activation and +49.697 ms callback p95, exceeding the +25 ms gates. Batch 3aa adds opt-in delivery.

The [fresh isolated debug host comparison](../../../.docs/audits/evidence/batch3aa-20260929/theme-measurement.json), against workspace + logo, measured +152.569 ms for the median fresh `omd-mod status` launch (266.337 → 418.906 ms) and +181.352 ms aggregate terminal callback p95 (240.543 → 421.895 ms). Sampled host-plus-child peak RSS rose by 12.34 MiB (89.31 → 101.66 MiB). It used 15 randomized launches and 20 offline callbacks per arm, sanitized child homes/environments and zero paid requests. Callback timing includes sandbox startup and TypeScript presentation generation; RSS is a sampled peak, not an allocator measurement. Both +25 ms gates still fail, so the package remains inactive until chosen.

The [bounded native debug timing fixture](../../../.docs/audits/evidence/batch3aa-20260929/tui-render-cost.log) measured one cell surface at 1.58 ms solid / 1.77 ms gloss for 80 × 24, and 3.92 / 4.27 ms for 120 × 40, including a 0.07 / 0.18 ms buffer clone baseline. Rebuilding a 512 × 256 PNG with placement, tint, dimming, opacity, gloss and encoding took 185 ms at 80 × 24, 435 ms at 120 × 40, and 2.86 s at the capped 2048 × 2048 canvas. Image work is cached between resource, transform, geometry or environment changes; a rebuild can cause a noticeable pause in this debug build. These figures exclude terminal transmission and do not establish release-build performance.

The fixture records cell structures of 90 / 225 KiB and image canvases of 0.94 / 2.34 / 16 MiB, plus 0.50 MiB of decoded source pixels. Those counts exclude string capacity and encoder scratch; test-process RSS was unavailable inside the sandbox. These tests and terminal fixtures establish local behavior; physical Ghostty/iTerm2/Warp, real SSH/tmux and public support qualification remain separate.
