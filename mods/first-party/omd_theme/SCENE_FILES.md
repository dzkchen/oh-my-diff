# Shared scenes

You can load animated scenes from JSON files without changing the mod. Start with
[lanterns.omd-scene.json](examples/lanterns.omd-scene.json), or use a file someone shared with you.
[Turn on omd_theme](README.md#turn-it-on) first.

## Import and share a scene

Save the file as `lanterns.omd-scene.json` at your repository root and run:

```text
/theme import lanterns.omd-scene.json
```

Paths are relative to the repository root, even if you started the session in a subdirectory. For a file in
`art/`, use `/theme import art/lanterns.omd-scene.json`. Enter paths with spaces without surrounding quotes.
Absolute paths and paths containing `..` are rejected. You can also enter the path under **Import scene…** in
`/theme`. Imports use the session's file-read permissions.

The mod saves a copy in your user library and selects it. You can then move or delete the original file.
The file's `id` controls the saved name; its filename can be different. The library is shared by sessions using
the same mod store. Open `/theme` in another running conversation to refresh its saved choices and library.

For the example scene, these commands select, share, and remove the saved copy:

| Command | What it does |
| --- | --- |
| `/theme custom:lanterns` | Selects Lanterns |
| `/theme share lanterns` | Copies the scene JSON to your clipboard; paste it into a UTF-8 file to send to someone |
| `/theme remove lanterns` | Removes Lanterns from your library and turns it off if selected |

The picker has these actions too. `share` and `remove` also accept `custom:lanterns`. Sharing includes the scene's
drawing, palette and animation, without your other theme preferences or imported image.

To edit a saved scene:

1. Copy its JSON with `/theme share lanterns` and save it as a file, or edit your original file.
2. Change the drawing or animation. Keep `id: "lanterns"` to replace that scene, or choose a new ID to keep both.
3. If you kept the ID, run `/theme remove lanterns` before importing the edited file. Editing a source file does
   not update its saved copy automatically.
4. Run `/theme import PATH` and check the result in the conversation and at a different terminal size.

The mod rejects imports with an ID already in your library. Removing the selected scene turns it off in the
current conversation; removing a different scene leaves the current choice selected.

Your library can hold eight scenes, each up to 16 KiB of UTF-8 JSON, including whitespace. Imported scenes follow
the same motion, reduced-motion and calm-while-working settings as built-in scenes. Density changes the number
of particles; it does not resize sprites, blobs or glows.

## Write a scene file

Save this complete example as `stars.omd-scene.json`, then run `/theme import stars.omd-scene.json`:

```json
{
  "format": "omd-scene",
  "version": 1,
  "id": "stars",
  "name": "Stars",
  "detail": "Small lights drift across a blue sky.",
  "sky": ["#040916", "#132345"],
  "palette": { "tint": ["#132345", "#040916"], "accent": "#cceeff" },
  "layers": [
    { "kind": "particles", "count": 24, "glyphs": ".*+", "colors": ["#cceeff"], "vx": 0.2 }
  ]
}
```

All top-level fields below are required. The [Lanterns example](examples/lanterns.omd-scene.json) adds a glow and
an animated sprite.

| Field | Value |
| --- | --- |
| `format` | `"omd-scene"` |
| `version` | `1` |
| `id` | Up to 32 lowercase letters, digits, or hyphens, starting with a letter |
| `name` | Nonempty name shown in the picker, up to 64 characters |
| `detail` | Nonempty description shown in the picker, up to 240 characters |
| `sky` | 2–8 background colors, ordered from top to bottom |
| `palette` | Two `tint` colors and one `accent` color for the terminal setup instructions |
| `layers` | 0–24 drawing layers; later layers draw over earlier ones |

Write colors as `#rrggbb`, such as `#ffd699`. The mod rejects unknown fields and unsupported versions.
Use JSON without comments or trailing commas. Text cannot contain control characters, tabs or line breaks. String
limits count some characters, such as emoji, as two characters. Long picker labels and descriptions may
be shortened on screen. Scene files describe drawings and motion; the mod does not run code from them.

### Draw layers

Each layer has a `kind` and the fields listed below. `alpha` controls its strength from 0 to 1 and defaults to 1.

| Kind | What it draws | Required fields | Optional fields |
| --- | --- | --- | --- |
| `glow` | A circle of light that fades toward its edge | `kind`, `radius`, `color` | `x`, `y`, `alpha` |
| `blob` | An oval of glyph tiles with a soft edge | `kind`, `width`, `height`, `color` | `x`, `y`, `alpha` |
| `particles` | Moving glyphs that wrap around the screen | `kind`, `count`, `glyphs`, `colors` | `seed`, `vx`, `vy`, `sway`, `alpha` |
| `sprite` | A picture drawn from rows of characters | `kind`, `rows`, `ink` | `x`, `y`, `alpha` |

For glows and blobs, `x` and `y` locate the center. For sprites, they locate the top-left corner.
Both default to 0.5: halfway across or down the scene. Positions use fractions of the scene's width and height.
Positive `x` moves right and positive `y` moves down. Parts outside the scene are clipped. A sprite keeps its
tile size when the terminal resizes; its position moves with the scene's dimensions.

A blob's `width` and `height` are its horizontal and vertical radii, also expressed as fractions of the scene.
For example, `width: 0.1` extends one tenth of the scene's width on either side of the center.
A glow's `radius` uses the smaller of the scene's width in tiles and height in rows.

For sprites, `rows` contains 1–48 nonempty strings of up to 96 characters each. Each character identifies one
two-cell tile. `ink` maps up to 32 single-character keys to colors. For example:

```json
{ "kind": "sprite", "x": 0.25, "y": 0.5, "rows": [" aa ", "abba", " aa "], "ink": { "a": "#f4a257", "b": "#fff1c2" } }
```

The letters choose tile colors; the mod draws its own texture inside the tiles. Characters without an assigned
color, such as the spaces in this example, leave earlier layers visible. Use simple single-character keys such
as ASCII letters and punctuation.

For particles, `glyphs` supplies 1–16 printable ASCII characters and `colors` supplies 1–8 colors. Emoji, wide
characters and combining marks are rejected as particle glyphs. `count` sets the number of particles, from 0 to
100 before the density setting adjusts it. `vx` moves them horizontally in tiles per second;
`vy` moves them vertically in rows per second. Positive values move right and down. `sway` adds horizontal
oscillation in tiles. These three fields default to 0 and accept values from -10 to 10. `seed` chooses their
starting positions; it defaults to 1 and accepts values from 0 to 65535.

### Animate a layer

You can replace any numeric `x`, `y`, `radius`, `width`, `height`, or `alpha` with an object that changes the value
over time. For example, this `y` moves a layer between 0.4 and 0.6 of the scene's height every eight seconds:

```json
"y": { "base": 0.5, "amplitude": 0.1, "period": 8 }
```

| Field | Meaning | Default | Allowed range |
| --- | --- | --- | --- |
| `base` | Starting value before motion is added | Required | -4 to 4 |
| `amplitude` | How far the value swings above and below its base | 0 | 0 to 4 |
| `period` | Seconds per oscillation | 8 | 0.25 to 3600 |
| `phase` | Starting point in the oscillation, in radians | 0 | -100 to 100 |
| `drift` | Amount added to the base per second | 0 | -1 to 1 |

A nonzero `drift` makes the base wrap between 0 and 1. For example, `"y": { "base": 0.8, "drift": -0.015 }`
moves a sprite upward and returns it to the bottom when it passes the top. Omit `amplitude` for steady travel.

Plain numeric `x`, `y`, `radius`, `width`, `height` and `alpha` values must also be between -4 and 4. When drawing,
the mod clamps alpha to 0–1, glow radius to at least 0, and blob radii to at least 0.01.

With Normal animation, time advances in seconds; Slow runs at half that speed. Animation Off and Reduced motion
draw a still frame at 24 scene seconds, rather than at time zero. Check that your scene also looks right there.
Calm while working pauses time during a turn. Custom scenes do not receive Aurora's turn-end flare.

## Troubleshooting

| What happens | What to check |
| --- | --- |
| The file cannot be read | Use a repository-relative path and check that the session can read it. Move a file from outside the workspace into the project before importing it. |
| The ID is already imported | Remove the saved scene before importing its replacement, or give the new scene a different `id`. |
| The library is full | Remove one of its eight saved scenes, then retry. |
| The file is invalid | Check the required fields, JSON syntax, colors, size limit and supported layer fields above. |
| A save reports `store_revision_conflict` | Another session changed the library or preferences during the command. Retry; the conflicting command did not replace those saved preferences. |
| Copying fails | The host needs clipboard support and a working clipboard backend. You can share your original file directly if you kept it. |
| The scene does not move | Check Animation and Calm while working in `/theme`, your system's reduced-motion setting, and whether the terminal is focused. |
| The scene is absent | Check the [drawing limits](README.md#when-it-draws-less), such as a narrow terminal, text-only graphics or inline mode. |

Use a few layers first and test both a small and a large terminal. Large glows and blobs cover more cells and
cost more to draw. Short sprites and modest particle counts are a useful starting point.
