# omd_theme

A living scene behind the whole screen: an animated picture drawn in character tiles under the conversation, the
prompt box, menus and the footer.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd mods enable omd_theme
```

While it is on, `/theme` opens its panel; Codex's own syntax-highlighting picker is the panel's first item
(Syntax colours…), or type `/omd_theme:scenes syntax`.

## Scenes

| Scene | What moves |
| --- | --- |
| Ember mark | The OMD mark over a banked fire; embers rise on the draft |
| Cloud drift | Dusk clouds at different heights and speeds |
| Lagoon | Light shafts through shallow water, a sea turtle, rising bubbles |
| Jellyfish | Three glowing jellyfish pulse and rise, trailing tentacles |
| Fireflies | Fireflies wander and blink with soft halos over a treeline |
| Moonlit night | Twinkling stars, a cloud crossing the moon, an occasional meteor |
| Your image | A PNG or JPEG you choose, drawn as glyph tiles with a slow light sweep |

Every picture is made of two-cell tiles holding a glyph, tinted over a colour gradient. Choosing a scene applies it
at once with a circular reveal. On a fresh session the scene shows at full strength in place of the OMD mark and the
welcome text. Once anything else is on screen it stays behind it, darkened: its colours fill every cell with the
default background, and the prompt box, menus such as `/theme` and `/mods` and your submitted prompts become
frosted glass with the scene faintly visible through them. Its glyphs only appear in blank space past the end of
each line and never over images, so text stays readable and OMD's copies never include them (the terminal's own
selection, such as Shift-drag, copies what the screen shows). On a light terminal, text that would be hard to read
over the dark scene gets a readable colour. With workspace panes, sidebars or docks the picture sits in the chat
column and panes get only its darkened colours. The
scene is the preview while the `/theme` panel is open.

## The panel

- **Scenes**: pick a scene, No scene, Your image… (asks before reading the file and keeps only a 60×24 colour
  sample), or Syntax colours….
- **Motion**: animation normal, slow or off (one still frame), how many glyphs drift and calm while working
  (pauses the scene during a turn).
- **Terminal**: steps for the terminal you run in, found from its environment variables: font family; background
  opacity and blur for Kitty, Ghostty and WezTerm; an animated background shader for Ghostty; gradient background
  layers for WezTerm; font and background colour for Orca, which has no window transparency setting. Each opens the
  lines to add, with Copy to the clipboard. The mod never edits terminal configuration.

Typed forms: `/theme lagoon`, `/theme off`, `/theme image ~/Pictures/sky.png`, `/theme font JetBrains Mono` and
`/theme terminal` (all steps for this terminal in the conversation, the Ghostty shader included).

## When it draws less

- Reduced motion (the system setting or `tui.animations = false`) or animation off: one still frame.
- `NO_COLOR`, a 16-colour terminal, fewer than 60 columns or inline mode (`--no-alt-screen`): no scene, and the
  usual welcome.
- Sidebars, panels, overlays and dialogs draw over the scene.

## Needs and limits

- Capabilities: `terminal` (scene raster, panel, clipboard), `commands`, `store` (your choices, shared by your
  sessions), `events` (frame timer), `lifecycle` (pauses during turns), `builtins` (takes over `/theme`) and `exec`
  (reads `TERM_PROGRAM`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` and `WEZTERM_EXECUTABLE`).
- Needs the screen underlay (`terminal_underlay_v1`), the terminal colours (`terminal_colors_v1`) and the welcome
  area and its hiding (`terminal_welcome_area_v1`, `terminal_welcome_hidden_v1`: the scene replaces the welcome while
  it owns the underlay); the chat column (`terminal_chat_area_v1`) is optional. Animation runs eight frames a second
  while the session is idle and sends only the changed cells; a still or paused scene redraws nothing.
- A change made in one session reaches other running sessions at their next new session.
