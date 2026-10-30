import { hex } from './scenes.ts';
import type { Palette, Rgb } from './scenes.ts';

export type Terminal = 'Kitty' | 'Ghostty' | 'WezTerm' | 'Orca';
export type Topic = 'font' | 'glass' | 'shader' | 'layers' | 'background';
export type Steps = { title: string; text: string; copy: string };

export const TERMINALS: Terminal[] = ['Kitty', 'Ghostty', 'WezTerm', 'Orca'];
export const ENVIRONMENT = ['TERM_PROGRAM', 'KITTY_WINDOW_ID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_EXECUTABLE'];
export const TOPICS: Record<Terminal, Topic[]> = {
  Kitty: ['font', 'glass'],
  Ghostty: ['font', 'glass', 'shader'],
  WezTerm: ['font', 'glass', 'layers'],
  Orca: ['font', 'background'],
};
export const LABELS: Record<Topic, string> = {
  font: 'Font family',
  glass: 'Background opacity and blur',
  shader: 'Animated background shader',
  layers: 'Background gradient layers',
  background: 'Background colour',
};
const UNCHANGED = 'Nothing was changed: paste the lines yourself, then reload.';

export function detect(values: Record<string, { set: boolean; value?: string | null }>): Terminal | null {
  const value = (name: string) => values[name]?.value ?? '';
  if (values.KITTY_WINDOW_ID?.set) return 'Kitty';
  if (values.GHOSTTY_RESOURCES_DIR?.set || value('TERM_PROGRAM') === 'ghostty') return 'Ghostty';
  if (values.WEZTERM_EXECUTABLE?.set || value('TERM_PROGRAM') === 'WezTerm') return 'WezTerm';
  if (value('TERM_PROGRAM') === 'Orca') return 'Orca';
  return null;
}

const vec = (color: Rgb) => `vec3(${[16, 8, 0].map(shift => ((color >>> shift & 255) / 255).toFixed(3)).join(', ')})`;

export function shader(palette: Palette): string {
  return [
    'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
    '  vec2 uv = fragCoord / iResolution.xy;',
    '  vec4 text = texture(iChannel0, uv);',
    '  float dark = 1.0 - smoothstep(0.08, 0.3, dot(text.rgb, vec3(0.299, 0.587, 0.114)));',
    '  float wave = 0.5 + 0.5 * sin(uv.x * 5.0 + iTime * 0.25) * sin(uv.y * 3.0 - iTime * 0.17);',
    `  vec3 tint = mix(${vec(palette.tint[0])}, ${vec(palette.tint[1])}, uv.y) * (0.6 + 0.4 * wave);`,
    '  vec2 cell = floor(fragCoord / 18.0);',
    '  float seed = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);',
    '  float spark = step(0.985, seed) * (0.5 + 0.5 * sin(iTime * 1.7 + seed * 40.0));',
    `  fragColor = vec4(text.rgb + dark * (tint + spark * 0.35 * ${vec(palette.accent)}), text.a);`,
    '}',
  ].join('\n');
}

export function steps(terminal: Terminal, topic: Topic, palette: Palette, scene: string, family: string): Steps {
  const [top, bottom] = palette.tint.map(hex);
  const file = `omd-${scene}.glsl`;
  const config: Record<Terminal, Partial<Record<Topic, [string, string, string]>>> = {
    Kitty: {
      font: ['~/.config/kitty/kitty.conf', `font_family ${family}`, 'Reload with Ctrl+Cmd+, on macOS, Ctrl+Shift+F5 elsewhere.'],
      glass: ['~/.config/kitty/kitty.conf', 'background_opacity 0.88\nbackground_blur 24', 'background_blur works on macOS; restart Kitty for background_opacity to apply.'],
    },
    Ghostty: {
      font: ['~/.config/ghostty/config', `font-family = "${family}"`, 'Reload with Cmd+Shift+, on macOS, Ctrl+Shift+, elsewhere.'],
      glass: ['~/.config/ghostty/config', 'background-opacity = 0.88\nbackground-blur = 20', 'Reload with Cmd+Shift+, on macOS, Ctrl+Shift+, elsewhere.'],
      shader: [`~/.config/ghostty/config, and the shader as ~/.config/ghostty/shaders/${file}`, `custom-shader = ~/.config/ghostty/shaders/${file}\ncustom-shader-animation = true`,
        'Copy puts the shader in the clipboard; save it under that name first. It tints dark cells with this scene\'s colours behind every program.'],
    },
    WezTerm: {
      font: ['~/.wezterm.lua', `config.font = wezterm.font("${family}")`, 'WezTerm reloads the file when it is saved.'],
      glass: ['~/.wezterm.lua', 'config.window_background_opacity = 0.88\nconfig.macos_window_background_blur = 20', 'WezTerm reloads the file when it is saved.'],
      layers: ['~/.wezterm.lua', `config.background = {\n  { source = { Gradient = { colors = { '${top}', '${bottom}' }, orientation = 'Vertical' } }, width = '100%', height = '100%', opacity = 0.92 },\n}`,
        'WezTerm reloads the file when it is saved; remove the block to go back.'],
    },
    Orca: {
      font: ['Orca Settings › Terminal', `Font family: ${family}`, 'Orca applies it to open terminals.'],
      background: ['Orca Settings › Terminal', `Background colour: ${bottom}`, 'Orca has no window transparency setting, so the scene stays inside Oh My Diff; this frames it in the scene\'s colour.'],
    },
  };
  const entry = config[terminal][topic];
  if (!entry) return { title: `${terminal}: ${LABELS[topic]}`, text: `${terminal} has no ${LABELS[topic].toLowerCase()} setting.`, copy: '' };
  const [where, lines, note] = entry;
  const copy = topic === 'shader' ? shader(palette) : lines;
  const text = [`In ${where}:`, '', lines, '', note, UNCHANGED, ...topic === 'font' ? ['The font must be installed on this machine.'] : []].join('\n');
  return { title: `${terminal}: ${LABELS[topic]}`, text, copy };
}
