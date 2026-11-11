# omd_theme

Draws a living scene behind the conversation: an animated picture in character tiles, with the prompt box and
menus kept opaque. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_theme
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

While it's on, `/theme` opens its panel. Codex's own syntax-highlighting picker is the panel's first item
(Syntax colours…), or type `/theme syntax`.

You can also type:

- `/theme lagoon` to pick a scene
- `/theme off` for no scene
- `/theme image ~/Pictures/sky.png` to use your own image
- `/theme font JetBrains Mono` to save a font family and show the steps that set it in your terminal
- `/theme terminal` for all steps for this terminal in the conversation, the Ghostty shader included

You can also [import and share scenes from JSON files](#import-and-share-scenes).

### Scenes

The bundled scenes are standalone [JSON files](collection/), installed by default. Each can be copied or removed
in the Scenes tab, just like an imported scene. For example, `/theme share ember` copies Ember's file and
`/theme remove ember` removes it from your picker. Removal is remembered across sessions; removing the selected
scene switches to No scene. Use `/theme restore ember` or its Restore action in the panel to add it back.
You can remove every bundled scene and use only your own imports or image.

| Scene | Command | What moves |
| --- | --- | --- |
| Ember mark | `/theme ember` | The OMD logo over a banked fire; embers rise on the draft |
| Cloud drift | `/theme drift` | Dusk clouds at different heights and speeds |
| Lagoon | `/theme lagoon` | Light shafts through shallow water, a sea turtle, rising bubbles |
| Jellyfish | `/theme jelly` | Three glowing jellyfish pulse and rise, trailing tentacles |
| Fireflies | `/theme fireflies` | Fireflies wander and blink with soft halos over a treeline |
| Moonlit night | `/theme moonlit` | Twinkling stars, a cloud crossing the moon, an occasional meteor |
| Aurora | `/theme aurora` | Northern lights ripple over a snowy ridge. They flare for a few seconds when a turn finishes, and stir faster while one runs if Calm while working is off |
| Koi | `/theme koi` | Ivory fins and a vermilion head wave in dark water |
| Prismatic flow | `/theme prism` | Pearlescent ribbons drift diagonally across charcoal |
| Event horizon | `/theme horizon` | Amber bands orbit a dark core and a thin accretion disk |
| Your image | `/theme image PATH` | A PNG or JPEG you choose, drawn as glyph tiles with a slow light sweep |

Every picture is made of two-cell tiles that each contain a glyph, tinted over a color gradient. Choosing a scene
applies it at once, with a circular reveal between scenes. Enabling a scene from No scene shows it directly. On a
fresh session the scene shows at full strength in place of the OMD logo and the welcome text.

Once anything else is on screen, the scene stays behind it, darkened:

- Its colors fill every cell that has the default background.
- The prompt box, menus such as `/theme` and `/mods`, and submitted prompts keep their opaque backgrounds.
- Its glyphs appear only in blank space past the end of each line and never over images, so text stays readable and
  OMD's copies never include them. The terminal's own selection, such as Shift-drag, copies what the screen shows.
- On a light terminal, text that would be hard to read over the dark scene gets a readable color.
- With workspace panels, sidebars or docks, the picture is drawn in the chat column and the panels get only its darkened
  colors.
- While the `/theme` panel is open, the scene is the preview.

### Import and share scenes

Save a scene JSON file in your project, then import it with a path relative to the repository root:

```text
/theme import art/lanterns.omd-scene.json
```

The mod saves a copy in your user library and selects it. You can move or delete the original file afterward.
For a file whose `id` is `lanterns`, use `/theme custom:lanterns` to select it again, `/theme share lanterns` to
copy its JSON to the clipboard, and `/theme remove lanterns` to remove the saved copy. Sharing a scene copies
only that scene file, without your image, font or motion choices.

Your imported library holds up to eight scenes of 16 KiB each; bundled scenes do not use those slots. To replace
a saved scene, remove it and import the edited file. The Scenes tab has import, copy and remove actions too.

[Write and share a scene](SCENE_FILES.md) covers the format, a complete example, animation and troubleshooting.

### The panel

- Scenes: pick a bundled or imported scene, import a scene file, copy or remove any scene, restore a bundled
  scene, choose No scene, Your image… (asks before reading the file and keeps only a 60×24 color sample), or Syntax colours….
- Motion: animation normal, slow or off (one still frame), how many glyphs drift and calm while working
  (pauses the scene during a turn). Aurora's flare when a turn finishes shows either way, unless animation is off.
- Terminal: steps for the terminal you run in, found from its environment variables. Each opens the lines to add,
  with Copy to the clipboard. The mod never edits terminal configuration. The steps cover:
  - font family
  - background opacity and blur for Kitty, Ghostty and WezTerm
  - an animated background shader for Ghostty
  - gradient background layers for WezTerm
  - font and background color for Orca, which has no window transparency setting

### When it draws less

- No scene: no frame timer runs.
- When the terminal loses focus or has no input for five minutes, animation pauses until activity resumes. Focus detection requires terminal focus events.
- Reduced motion (the system setting or `tui.animations = false`) or animation off: one still frame.
- `NO_COLOR`, a 16-color terminal, fewer than 60 columns or inline mode (`--no-alt-screen`): no scene, and the
  usual welcome.
- Sidebars, panels, overlays and dialogs draw over the scene.

## Settings

It has no settings in `/mods`. Your scene and motion choices, removed bundled scenes and imported library are saved
for sessions using the same mod store. Opening `/theme` refreshes the current conversation from those saved choices. Other running
conversations keep their current scene until you open `/theme`, change a theme preference there, or start or
resume a session.

## Needs and limits

- It asks to draw on the screen and in the panel, use the clipboard, keep your choices, run a frame timer, pause
  during turns, take over `/theme`, read scene JSON files in the workspace and read `TERM_PROGRAM`,
  `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` and `WEZTERM_EXECUTABLE`. The capabilities are `terminal`,
  `commands`, `store`, `events`, `lifecycle`, `builtins`, `exec` and `fs.read`
  (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)). Scene imports use the
  session's existing file-read permissions; image imports ask before reading the file.
- It needs an OMD host that supports the screen underlay (`terminal_underlay_v1`), terminal colors
  (`terminal_colors_v1`), welcome presentation and hiding it (`terminal_welcome_v1`, `terminal_welcome_hidden_v1`),
  and thread-view events (`terminal_thread_view_v1`). The scene replaces the welcome while it draws the underlay.
  The chat column (`terminal_chat_area_v1`) is optional.
- Menus, the composer and submitted prompts stay opaque over the scene. Cached frames belong to their repository
  and conversation.
- Opening a conversation, including through `/subagent`, loads your saved scene if that thread has no theme state.
  Returning to an initialized thread keeps its current scene and animation.
- Animation runs eight frames a second while the session is idle and sends only the changed cells. A still or paused
  scene probes its cached frame. Resizing promptly redraws it without restarting the animation or advancing a paused scene.
- The background fills the terminal grid, including newly exposed cells during resize. Any padding outside the grid
  is controlled by the terminal application.

## More

- [Included mods](../../../docs/collection.md)
- [`omd_workspace`](../omd_workspace/README.md), whose panels show the scene's darkened colors
- [Terminal UI reference](../../reference/terminal-ui.md)
