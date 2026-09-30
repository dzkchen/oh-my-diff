import type { Json, ModAPI, ResourceRef, TerminalComponent, TerminalPatch, TerminalTheme, ThemeColor } from '../../api.d.ts';

type Palette = { name: string; foreground: string; background: string; theme: TerminalTheme };
type Settings = {
  palette: string; symbols: 'ascii' | 'unicode'; background_color: string; foreground_color: string;
  backdrop_mode: 'none' | 'ascii' | 'image'; ascii_text: string; position: 'center' | 'fill' | 'fit' | 'tile';
  scale: number; tint: string; dim: number; opacity: number; x: number; y: number;
  composer_gloss: boolean; backdrop_gloss: boolean; highlight: number; shading: number;
  gloss_opacity: number; borders: boolean; greeting_enabled: boolean; greeting_text: string;
};
type Asset = { resource: ResourceRef; label: string; ascii: string };
type State = { saved: Settings | null; preview: Settings | null; asset: Asset | null; preview_asset: Asset | null; imports: Record<string, Palette>; open: boolean; page: string; notice: string; revision: number };
const DEFAULTS: Settings = {
  palette: 'midnight', symbols: 'ascii', background_color: '', foreground_color: '', backdrop_mode: 'none', ascii_text: '. :  ',
  position: 'fit', scale: 1, tint: '', dim: 0.65, opacity: 1, x: 0, y: 0,
  composer_gloss: false, backdrop_gloss: false, highlight: 0.12, shading: 0.08, gloss_opacity: 0.85, borders: true,
  greeting_enabled: false, greeting_text: 'What would you like to work on?',
};
const PALETTES: Record<string, Palette> = {
  midnight: { name: 'Midnight', foreground: '#eeeeee', background: '#262626', theme: { accent: '#80d8ff', success: '#91e6aa', attention: '#ffe08a', failure: '#ff9b9b', diff_added: '#91e6aa', diff_removed: '#ff9b9b', muted: '#b4beca', user_message_background: '#303942', border: 'plain', density: 'comfortable' } },
  paper: { name: 'Paper', foreground: '#1c1c1c', background: '#ffffff', theme: { accent: '#005f9e', success: '#176b37', attention: '#805300', failure: '#a21d2b', diff_added: '#176b37', diff_removed: '#a21d2b', muted: '#555d66', user_message_background: '#e8edf1', border: 'plain', density: 'comfortable' } },
  contrast: { name: 'High contrast', foreground: '#ffffff', background: '#000000', theme: { accent: '#91dcff', success: '#a5f5a5', attention: '#fff39a', failure: '#ffabab', diff_added: '#a5f5a5', diff_removed: '#ffabab', muted: '#d6d6d6', user_message_background: '#202020', border: 'double', density: 'comfortable' } },
  frost: { name: 'Frost', foreground: '#ecf2fc', background: '#172033', theme: { accent: '#a7caff', success: '#9be4bc', attention: '#ffe2a4', failure: '#ffb1be', diff_added: '#9be4bc', diff_removed: '#ffb1be', muted: '#b7c8e5', user_message_background: '#25314a', border: 'rounded', density: 'comfortable' } },
  graphite: { name: 'Graphite', foreground: '#f1f1f1', background: '#1b1b1f', theme: { accent: '#d3c7ff', success: '#a8e5c4', attention: '#f3d898', failure: '#ffb4b4', diff_added: '#a8e5c4', diff_removed: '#ffb4b4', muted: '#bebdc6', user_message_background: '#2b2b32', border: 'rounded', density: 'comfortable' } },
  amber: { name: 'Amber', foreground: '#ffedcc', background: '#241d14', theme: { accent: '#ffcf88', success: '#bce3a6', attention: '#ffe69c', failure: '#ffb2a1', diff_added: '#bce3a6', diff_removed: '#ffb2a1', muted: '#d6c3a7', user_message_background: '#372c1d', border: 'plain', density: 'comfortable' } },
};
const COLOR = /^#[\da-f]{6}$/i;
const bytes = (text: string) => Array.from(text).reduce((total, character) => total + ((character.codePointAt(0) ?? 0) <= 0x7f ? 1 : (character.codePointAt(0) ?? 0) <= 0x7ff ? 2 : (character.codePointAt(0) ?? 0) <= 0xffff ? 3 : 4), 0);
const visible = (text: string, limit = 512) => { let result = ''; for (const character of text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')) { if (bytes(result) + bytes(character) > limit) break; result += character; } return result; };
const color = (text: string): string => { const value = text.replace(/^['"]|['"]$/g, '').trim(); const hex = value.startsWith('#') ? value : `#${value}`; if (!COLOR.test(hex)) throw new Error('Use a six-digit RGB color, such as #1b2430'); return hex.toLowerCase(); };
const rgb = (hex: string): number[] => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const hex = (channels: number[]) => `#${channels.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const blend = (a: string, b: string, amount: number) => hex(rgb(a).map((value, index) => value * (1 - amount) + rgb(b)[index] * amount));
const luminance = (value: string) => rgb(value).map(channel => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
function readable(value: string, backgrounds: string[]): string {
  if (backgrounds.every(background => contrast(value, background) >= 4.5)) return value;
  const target = contrast('#ffffff', backgrounds[0]) >= contrast('#000000', backgrounds[0]) ? '#ffffff' : '#000000';
  for (let step = 1; step <= 20; step++) { const candidate = blend(value, target, step / 20); if (backgrounds.every(background => contrast(candidate, background) >= 4.5)) return candidate; }
  return target;
}
function readableBackground(value: string, foregrounds: string[], base: string): string {
  for (let step = 0; step <= 20; step++) { const candidate = blend(value, base, step / 20); if (foregrounds.every(foreground => contrast(foreground, candidate) >= 4.5)) return candidate; }
  return base;
}
function indexed(value: string): number {
  const channels = rgb(value); let best = 16; let distance = Infinity;
  for (let index = 16; index < 256; index++) {
    const n = index - 16; const levels = [0, 95, 135, 175, 215, 255];
    const candidate = index < 232 ? [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]] : Array(3).fill(8 + (index - 232) * 10);
    const d = candidate.reduce((total, channel, i) => total + (channel - channels[i]) ** 2, 0);
    if (d < distance) { best = index; distance = d; }
  }
  return best;
}
function configure(base: Settings, key: string, text: string): Settings {
  const next = { ...base };
  const numeric: Record<string, [number, number]> = { scale: [0.1, 4], dim: [0, 1], opacity: [0, 1], x: [-4096, 4096], y: [-4096, 4096], highlight: [0, 0.4], shading: [0, 0.4], gloss_opacity: [0, 1] };
  const choices: Record<string, string[]> = { symbols: ['ascii', 'unicode'], backdrop_mode: ['none', 'ascii', 'image'], position: ['center', 'fill', 'fit', 'tile'] };
  if (key in numeric) { const n = Number(text); const [min, max] = numeric[key]; if (text.trim() === '' || !Number.isFinite(n) || n < min || n > max || (['x', 'y'].includes(key) && !Number.isInteger(n))) throw new Error(`${key} must be ${min}–${max}${['x', 'y'].includes(key) ? ' integer cells' : ''}`); (next as unknown as Record<string, unknown>)[key] = n; }
  else if (key in choices) { if (!choices[key].includes(text)) throw new Error(`Choose ${choices[key].join(', ')}`); (next as unknown as Record<string, unknown>)[key] = text; }
  else if (['composer_gloss', 'backdrop_gloss', 'borders', 'greeting_enabled'].includes(key)) { if (!['true', 'false'].includes(text)) throw new Error('Choose true or false'); (next as unknown as Record<string, unknown>)[key] = text === 'true'; }
  else if (['background_color', 'foreground_color', 'tint'].includes(key)) (next as unknown as Record<string, unknown>)[key] = text === '' || text === 'auto' ? '' : color(text);
  else if (key === 'ascii_text') { if (!text || text.length > 8192 || /[^\x20-\x7e\n]/.test(text)) throw new Error('ASCII backdrop needs 1–8192 printable ASCII characters'); next.ascii_text = text; }
  else if (key === 'palette') { if (!/^[a-z0-9_-]{1,64}$/.test(text)) throw new Error('Invalid palette ID'); next.palette = text; }
  else if (key === 'greeting_text') { if (bytes(text) > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new Error('Greeting needs at most 256 UTF-8 bytes of printable text'); next.greeting_text = text; }
  else throw new Error(`Unknown setting: ${visible(key, 64)}`);
  return next;
}
function settings(values: Record<string, unknown>): Settings {
  let result = { ...DEFAULTS };
  for (const [key, value] of Object.entries(values)) { try { result = configure(result, key, String(value)); } catch { /* Broken saved values retain a usable default. */ } }
  return result;
}
function importedPalette(name: string, entries: Record<string, string>): Palette {
  if (!entries.background || !entries.foreground) throw new Error('Theme must contain foreground and background RGB colors');
  const background = color(entries.background); const foreground = readable(color(entries.foreground), [background]);
  const semantic = (keys: string[], fallback: string) => readable(color(keys.map(key => entries[key]).find(Boolean) ?? fallback), [background]) as ThemeColor;
  return { name: visible(name, 64), foreground, background, theme: {
    accent: semantic(['accent', '4', '6'], foreground), success: semantic(['2'], foreground), attention: semantic(['3'], foreground), failure: semantic(['1'], foreground),
    diff_added: semantic(['2'], foreground), diff_removed: semantic(['1'], foreground), muted: semantic(['8'], foreground),
    user_message_background: blend(background, foreground, 0.06) as ThemeColor, border: 'plain', density: 'comfortable',
  } };
}
function importTheme(format: string, text: string, name: string): Palette {
  if (!text || text.length > 65536 || text.includes('\u0000')) throw new Error('Theme must be a UTF-8 text file up to 64 KiB');
  const entries: Record<string, string> = {};
  if (format === 'ghostty') {
    for (const line of text.split('\n')) {
      const match = /^\s*(foreground|background|palette)\s*=\s*(.*?)\s*$/.exec(line); if (!match) continue;
      if (match[1] === 'palette') { const part = /^(\d+)\s*=\s*(#[\da-f]{6}|[\da-f]{6})(?:\s+#.*)?$/i.exec(match[2]); if (!part || Number(part[1]) > 255) throw new Error('Unsupported Ghostty palette color; export six-digit RGB colors'); entries[part[1]] = color(part[2]); }
      else { const part = /^(#[\da-f]{6}|[\da-f]{6})(?:\s+#.*)?$/i.exec(match[2]); if (!part) throw new Error('Unsupported Ghostty color; export six-digit RGB colors'); entries[match[1]] = color(part[1]); }
    }
  } else if (format === 'iterm2') {
    if (!/^\s*(<\?xml|<plist)/.test(text) || /<!ENTITY|<!\[CDATA\[/i.test(text)) throw new Error('Import an XML .itermcolors export; binary plists and entities are unsupported');
    const blocks = /<key>(Background Color|Foreground Color|Ansi (\d+) Color)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
    for (const match of text.matchAll(blocks)) {
      const space = /<key>Color Space<\/key>\s*<string>([^<]+)<\/string>/.exec(match[3]); if (space && space[1] !== 'sRGB') throw new Error('Unsupported iTerm2 color space; export sRGB colors');
      const values = ['Red', 'Green', 'Blue'].map(channel => { const value = new RegExp(`<key>${channel} Component<\\/key>\\s*<(?:real|integer)>([^<]+)<\\/(?:real|integer)>`).exec(match[3]); const n = Number(value?.[1]); if (!value || !Number.isFinite(n) || n < 0 || n > 1) throw new Error('Invalid iTerm2 RGB component'); return n * 255; });
      entries[match[1] === 'Background Color' ? 'background' : match[1] === 'Foreground Color' ? 'foreground' : match[2]] = hex(values);
    }
  } else if (format === 'warp') {
    // Only color scalars are interpreted. Image paths, tags and other YAML cannot cause I/O.
    let section = ''; let group = '';
    const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    for (const line of text.split('\n')) {
      if (/^\s*(?:#|$)/.test(line)) continue;
      const match = /^(\s*)([a-z_]+):\s*(.*?)\s*$/.exec(line); if (!match) continue;
      const indent = match[1].length; const key = match[2]; const value = match[3];
      const scalar = /^(['"]?)(#[\da-f]{6})\1(?:\s+#.*)?$/i.exec(value);
      if (indent === 0) { section = key; group = ''; if (['background', 'foreground', 'accent'].includes(key) && value) { if (!scalar) throw new Error('Unsupported Warp color; use RGB scalars or top/bottom gradients'); entries[key] = color(scalar[2]); } }
      else if (section === 'terminal_colors' && ['normal', 'bright'].includes(key)) group = key;
      else if (section === 'terminal_colors' && ansi.includes(key)) { if (!scalar) throw new Error('Invalid Warp ANSI color'); entries[String(ansi.indexOf(key) + (group === 'bright' ? 8 : 0))] = color(scalar[2]); }
      else if (['background', 'accent'].includes(section) && ['top', 'bottom', 'left', 'right'].includes(key)) { if (!scalar) throw new Error('Invalid Warp gradient color'); entries[`${section}_${key}`] = color(scalar[2]); }
    }
    for (const key of ['background', 'accent']) { const a = entries[`${key}_top`] ?? entries[`${key}_left`]; const b = entries[`${key}_bottom`] ?? entries[`${key}_right`]; if (a && b) entries[key] = blend(a, b, 0.5); }
  } else throw new Error('Choose ghostty, iterm2 or warp');
  return importedPalette(name, entries);
}

export default function activate(api: ModAPI) {
  const readState = (): State => { const value = api.state.get() as Partial<State> | null; return { saved: value?.saved ? settings(value.saved) : null, preview: value?.preview ? settings(value.preview) : null, asset: value?.asset ?? null, preview_asset: value?.preview_asset ?? null, imports: value?.imports ?? {}, open: value?.open === true, page: value?.page ?? 'palette', notice: value?.notice ?? '', revision: value?.revision ?? 0 }; };
  const writeState = (state: State) => api.state.set(state as unknown as Json);
  const current = (state: State) => state.preview ?? state.saved ?? settings(api.settings);
  const palette = (state: State, id: string): Palette | undefined => Object.hasOwn(state.imports, id) ? state.imports[id] : Object.hasOwn(PALETTES, id) ? PALETTES[id] : undefined;
  const restored = (state: State): State => ({ ...state, revision: state.revision + 1 });
  const update = (state: State, value: Settings, notice = 'Live preview; Save to keep these settings') => { writeState({ ...state, preview: value, notice }); return { display: notice }; };
  const guard = (action: () => Json): Json => { try { return action(); } catch (error) { if (!(error instanceof Error)) throw error; const message = visible(error instanceof Error ? error.message : String(error)); writeState({ ...readState(), notice: message }); return { display: message }; } };
  const importedText = (resource: ResourceRef): string => {
    let cursor: number | undefined; let text = '';
    do { const page = api.host.call('evidence.read', { reference: resource, cursor, max_bytes: 16384 }); if (page.bytes > 65536) throw new Error('Text import is limited to 64 KiB'); text += page.text; cursor = page.cursor ?? undefined; } while (cursor !== undefined);
    return text;
  };
  api.command('set', arguments_ => guard(() => { const text = String(arguments_ ?? ''); const [key, ...parts] = text.trim().split(/\s+/); const value = parts.join(' '); const state = readState(); if (key === 'palette' && !palette(state, value)) throw new Error('Unknown palette'); return update(state, configure(current(state), key, value)); }), { description: 'Preview a theme setting: set KEY VALUE' });
  api.command('save', () => { const state = readState(); writeState({ ...state, saved: current(state), asset: state.preview_asset ?? state.asset, preview: null, preview_asset: null, notice: 'Theme saved' }); return { display: 'Theme saved' }; }, { description: 'Save the live theme preview' });
  api.command('cancel', () => { const state = readState(); writeState({ ...restored(state), preview: null, preview_asset: null, notice: 'Preview discarded' }); return { display: 'Preview discarded' }; }, { description: 'Restore the last saved theme' });
  api.command('reset', () => { const state = readState(); writeState({ ...restored(state), saved: null, preview: null, asset: null, preview_asset: null, notice: 'Theme reset to configured defaults' }); return { display: 'Theme reset to configured defaults' }; }, { description: 'Reset theme settings and backdrop selection' });
  api.command('page', value => { const state = readState(); const page = String(value); writeState({ ...state, open: true, page: ['palette', 'backdrop', 'position', 'glass', 'greeting'].includes(page) ? page : 'palette' }); return null; });
  api.command('close', () => { writeState({ ...readState(), open: false }); return null; });
  api.command('import', arguments_ => guard(() => {
    const match = /^(ghostty|iterm2|warp)\s+(.+)$/.exec(String(arguments_ ?? '').trim()); if (!match) throw new Error('Use /omd_theme:import ghostty|iterm2|warp PATH');
    const resource = api.host.call('terminal.import_file', { path: match[2], max_bytes: 65536 }); if ('status' in resource) return { display: 'Theme import declined; current theme kept' };
    const state = readState(); if (Object.keys(state.imports).length >= 20) throw new Error('Import library is full (20 themes)');
    const id = `import_${Object.keys(state.imports).length + 1}`; const imported = importTheme(match[1], importedText(resource), match[2].split('/').at(-1) ?? id);
    state.imports[id] = imported; return update(restored(state), { ...current(state), palette: id }, `Imported ${imported.name}; Save to keep the selection`);
  }), { description: 'Import a Ghostty, iTerm2 XML or Warp palette from a confirmed file' });
  api.command('ascii', path => guard(() => { const resource = api.host.call('terminal.import_file', { path: String(path), max_bytes: 8192 }); if ('status' in resource) return { display: 'ASCII import declined; current backdrop kept' }; const state = readState(); const text = importedText(resource).replace(/\r\n?/g, '\n'); return update(restored(state), configure({ ...current(state), backdrop_mode: 'ascii' }, 'ascii_text', text), 'ASCII backdrop imported; Save to keep it'); }), { description: 'Import a printable ASCII backdrop from a confirmed file' });
  api.command('image', path => guard(() => {
    const resource = api.host.call('terminal.import_file', { path: String(path), max_bytes: 8 * 1024 * 1024, lifetime: 'package' }); if ('status' in resource) return { display: 'Image import declined; current backdrop kept' };
    const sample = api.host.call('terminal.image_sample', { resource, columns: 80, rows: 24 });
    const ramp = ' .:-=+*#%@'; const rows: string[] = [];
    for (let y = 0; y < sample.height; y++) { let line = ''; for (let x = 0; x < sample.width; x++) { const index = (y * sample.width + x) * 4; const channels = sample.rgba.slice(index, index + 3); const luma = channels.reduce((total, value, i) => total + value * [0.2126, 0.7152, 0.0722][i], 0) / 255 * sample.rgba[index + 3] / 255; line += ramp[Math.round(luma * (ramp.length - 1))]; } rows.push(line); }
    const state = readState(); state.preview_asset = { resource, label: visible(String(path), 128), ascii: rows.join('\n') || ' ' };
    return update(restored(state), { ...current(state), backdrop_mode: 'image' }, 'Image imported with ASCII fallback; Save to keep it');
  }), { description: 'Import a PNG/JPEG backdrop with an image-derived ASCII fallback' });
  api.command('theme', arguments_ => {
    const text = String(arguments_ ?? '').trim(); const state = readState();
    if (text) return guard(() => { if (!palette(state, text)) throw new Error('Unknown palette; use /theme to open the library'); return update(state, { ...current(state), palette: text }); });
    writeState({ ...state, open: true }); return null;
  }, { description: 'Open theme settings and live preview, or choose a palette' });
  api.on('terminal', (): TerminalPatch => {
    const state = readState(); const config = current(state); const selected = palette(state, config.palette) ?? PALETTES.midnight;
    const background = config.background_color || selected.background;
    const foreground = readable(config.foreground_color || selected.foreground, [background]);
    const theme: TerminalTheme = { ...selected.theme, syntax: contrast('#000000', background) > contrast('#ffffff', background) ? 'catppuccin-latte' : 'catppuccin-mocha', icons: config.symbols, glyphs: config.symbols === 'unicode' ? { '===': '≡  ', '->': '→ ', '<=': '≤ ' } : {} };
    for (const key of ['accent', 'success', 'attention', 'failure', 'diff_added', 'diff_removed', 'muted'] as const) { const value = theme[key]; if (typeof value === 'string' && COLOR.test(value)) theme[key] = readable(value, [background]) as ThemeColor; }
    theme.user_message_background = background as ThemeColor;
    const foregrounds = [foreground, ...(['accent', 'success', 'attention', 'failure', 'diff_added', 'diff_removed', 'muted'] as const).map(key => String(theme[key] ?? foreground))];
    const paint = (gloss: boolean) => ({ top: readableBackground(gloss ? blend(background, '#ffffff', config.highlight) : background, foregrounds, background) as ThemeColor, bottom: readableBackground(gloss ? blend(background, '#000000', config.shading) : background, foregrounds, background) as ThemeColor, foreground: foreground as ThemeColor, opacity: gloss ? config.gloss_opacity : 1, ...(gloss && config.borders ? { border: readable(blend(background, foreground, 0.6), [background]) as ThemeColor } : {}) });
    const view: TerminalPatch = { foreground: indexed(foreground), background: indexed(background), theme, greeting: config.greeting_enabled ? config.greeting_text : '', surface_styles: { composer: paint(config.composer_gloss), backdrop: paint(config.backdrop_gloss) } };
    const tint = readableBackground(config.tint || background, foregrounds, background);
    let imageDim = config.dim;
    while (imageDim < 1 && !['#000000', '#ffffff'].every(extreme => foregrounds.every(fg => contrast(fg, blend(extreme, tint, imageDim)) >= 4.5))) imageDim = Math.min(1, imageDim + 0.025);
    const transform = { position: config.position, scale: config.scale, dim: config.dim, opacity: config.opacity, offset: { x: config.x, y: config.y }, ...(config.tint ? { tint: config.tint as ThemeColor } : {}) };
    if (config.backdrop_mode === 'ascii') view.backdrop = { ascii: { text: config.ascii_text, ...transform } };
    const asset = state.preview_asset ?? state.asset;
    if (config.backdrop_mode === 'image' && asset) view.backdrop = { image: { resource: asset.resource, ...transform, dim: imageDim, tint: tint as ThemeColor, ...(config.backdrop_gloss ? { overlay: paint(true) } : {}) }, fallback: { ascii: { text: asset.ascii, ...transform } } };
    if (state.open) view.sites = { dialog: { components: [{ type: 'dialog', id: 'omd_theme_dialog', label: 'Theme settings', title: 'Theme · live preview', children: controls(state, config) }] } };
    return view;
  });

  function controls(state: State, config: Settings): TerminalComponent[] {
    const button = (id: string, text: string, command: string, args?: string): TerminalComponent => ({ type: 'button', id: `omd_theme_${id}`, label: text, text, action: { command: `omd_theme:${command}`, ...(args ? { args } : {}) } });
    const input = (key: keyof Settings, label: string): TerminalComponent => ({ type: 'input', id: `omd_theme_${key}_${state.revision}`, label, value: String(config[key]), action: { command: 'omd_theme:set', args: key } });
    const select = (key: keyof Settings, label: string, values: string[]): TerminalComponent => ({ type: 'select', id: `omd_theme_${key}_${state.revision}`, label, value: String(config[key]), options: values.map(value => ({ value, label: value })), action: { command: 'omd_theme:set', args: key } });
    const children: TerminalComponent[] = [button('close', 'Close', 'close'), button('save', 'Save', 'save'), button('cancel', 'Discard preview', 'cancel'), button('reset', 'Reset', 'reset'), { type: 'select', id: 'omd_theme_page', label: 'Settings page', value: state.page, options: ['palette', 'backdrop', 'position', 'glass', 'greeting'].map(value => ({ value, label: value })), action: { command: 'omd_theme:page' } }];
    if (state.page === 'palette') children.push(
      { type: 'select', id: `omd_theme_palette_${state.revision}`, label: 'Palette library', value: config.palette, options: Object.entries({ ...PALETTES, ...state.imports }).map(([value, palette]) => ({ value, label: palette.name })), action: { command: 'omd_theme:set', args: 'palette' } },
      select('symbols', 'Symbols', ['ascii', 'unicode']), input('background_color', 'Background RGB (empty = palette)'), input('foreground_color', 'Text RGB (empty = palette)'),
      { type: 'input', id: 'omd_theme_import', label: 'Import theme', placeholder: 'ghostty|iterm2|warp /absolute/path', action: { command: 'omd_theme:import' } },
    );
    else if (state.page === 'backdrop') children.push(
      select('backdrop_mode', 'Backdrop', ['none', 'ascii', 'image']), input('dim', 'Dimming (0–1; contrast floor)'), input('opacity', 'Image opacity (0–1)'), input('tint', 'Tint RGB (empty = palette)'),
      { type: 'input', id: 'omd_theme_ascii_import', label: 'Import ASCII file', placeholder: '/absolute/path.txt', action: { command: 'omd_theme:ascii' } },
      { type: 'input', id: 'omd_theme_image_import', label: 'Import PNG/JPEG image', placeholder: '/absolute/path.png', action: { command: 'omd_theme:image' } },
    );
    else if (state.page === 'position') children.push(select('position', 'Position', ['center', 'fill', 'fit', 'tile']), input('scale', 'Scale (0.1–4)'), input('x', 'Horizontal offset (cells)'), input('y', 'Vertical offset (cells)'));
    else if (state.page === 'greeting') children.push(select('greeting_enabled', 'Startup greeting', ['false', 'true']), input('greeting_text', 'Greeting text'));
    else children.push(select('composer_gloss', 'Glossy prompt', ['false', 'true']), select('backdrop_gloss', 'Gloss over backdrop', ['false', 'true']), input('highlight', 'Highlight (0–0.4)'), input('shading', 'Shading (0–0.4)'), input('gloss_opacity', 'Gloss opacity (0–1)'), select('borders', 'Glass borders', ['true', 'false']));
    children.push({ type: 'text', id: 'omd_theme_notice', label: 'Preview status', text: visible(state.notice || 'Changes preview immediately; Save keeps them', 400) });
    return children;
  }
}
