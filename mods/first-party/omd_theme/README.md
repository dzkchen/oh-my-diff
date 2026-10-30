# omd_theme

Draws a living scene behind the whole screen: an animated picture in character tiles under the conversation, the
prompt box, menus and the footer. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_theme
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn mods on and off.

## Use it

While it's on, `/theme` opens its panel. Codex's own syntax-highlighting picker is the panel's first item
(Syntax colours…), or type `/omd_theme:scenes syntax`.

Typed forms: `/theme lagoon`, `/theme off`, `/theme image ~/Pictures/sky.png`, `/theme font JetBrains Mono` and
`/theme terminal` (all steps for this terminal in the conversation, the Ghostty shader included).

### Scenes

| Scene | What moves |
| --- | --- |
| Ember mark | The OMD mark over a banked fire; embers rise on the draft |
| Cloud drift | Dusk clouds at different heights and speeds |
| Lagoon | Light shafts through shallow water, a sea turtle, rising bubbles |
| Jellyfish | Three glowing jellyfish pulse and rise, trailing tentacles |
| Fireflies | Fireflies wander and blink with soft halos over a treeline |
| Moonlit night | Twinkling stars, a cloud crossing the moon, an occasional meteor |
| Your image | A PNG or JPEG you choose, drawn as glyph tiles with a slow light sweep |

Every picture is made of two-cell tiles holding a glyph, tinted over a color gradient. Choosing a scene applies it
at once with a circular reveal. On a fresh session the scene shows at full strength in place of the OMD mark and the
welcome text.

Once anything else is on screen, the scene stays behind it, darkened. Its colors fill every cell with the default
background, and the prompt box, menus such as `/theme` and `/mods` and your submitted prompts become frosted glass
with the scene faintly visible through them. Its glyphs only appear in blank space past the end of each line and
never over images, so text stays readable and OMD's copies never include them. The terminal's own selection, such as
Shift-drag, copies what the screen shows. On a light terminal, text that would be hard to read over the dark scene
gets a readable color. With workspace panes, sidebars or docks the picture is drawn in the chat column and panes get
only its darkened colors. While the `/theme` panel is open, the scene is the preview.

### The panel

- Scenes: pick a scene, No scene, Your image… (asks before reading the file and keeps only a 60×24 color
  sample), or Syntax colours….
- Motion: animation normal, slow or off (one still frame), how many glyphs drift and calm while working
  (pauses the scene during a turn).
- Terminal: steps for the terminal you run in, found from its environment variables: font family; background
  opacity and blur for Kitty, Ghostty and WezTerm; an animated background shader for Ghostty; gradient background
  layers for WezTerm; font and background color for Orca, which has no window transparency setting. Each opens the
  lines to add, with Copy to the clipboard. The mod never edits terminal configuration.

### When it draws less

- Reduced motion (the system setting or `tui.animations = false`) or animation off: one still frame.
- `NO_COLOR`, a 16-color terminal, fewer than 60 columns or inline mode (`--no-alt-screen`): no scene, and the
  usual welcome.
- Sidebars, panels, overlays and dialogs draw over the scene.

## Settings

It has no settings in `/mods`. Your scene and motion choices are made in the `/theme` panel and shared by your
sessions.

## Needs and limits

- It asks to draw on the screen and in the panel, use the clipboard, keep your choices, run a frame timer, pause
  during turns, take over `/theme` and read `TERM_PROGRAM`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` and
  `WEZTERM_EXECUTABLE`. The capabilities are `terminal`, `commands`, `store`, `events`, `lifecycle`, `builtins` and
  `exec`.
- It needs an OMD host with the screen underlay (`terminal_underlay_v1`), the terminal colors (`terminal_colors_v1`)
  and the welcome area and its hiding (`terminal_welcome_area_v1`, `terminal_welcome_hidden_v1`; the scene replaces
  the welcome while it owns the underlay). The chat column (`terminal_chat_area_v1`) is optional.
- Animation runs eight frames a second while the session is idle and sends only the changed cells. A still or paused
  scene redraws nothing.
- A change made in one session reaches other running sessions at their next new session.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_workspace`](../omd_workspace/README.md), whose panes show the scene's darkened colors
- [Terminal UI reference](../../reference/terminal-ui.md)
