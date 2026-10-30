import type { Json, ModAPI, TerminalPanel, TerminalPanelItem, TerminalPatch } from '../../api.d.ts';
import { FRAME_SECONDS, SCENES, STILL_SECONDS, changed, compose, pack, place, revealProgress, samplePalette, scene, shade } from './scenes.ts';
import type { Rect, Sample } from './scenes.ts';
import { ENVIRONMENT, LABELS, TERMINALS, TOPICS, detect, steps } from './steps.ts';
import type { Terminal, Topic } from './steps.ts';

type Speed = 'off' | 'slow' | 'normal';
type Density = 'sparse' | 'normal' | 'dense';
type Prefs = { scene: string; speed: Speed; density: Density; calm: boolean; image: Sample | null; family: string };
type Area = { x: number; y: number; columns: number; rows: number };
type View = { columns: number; rows: number; reduced: boolean; color: boolean; colors: string; phase: string | null; surface: string | null; chat: Area | null; welcome: boolean; raster: string };
type State = { prefs: Prefs | null; view: View | null; run: number; switched: { from: string; at: number } | null; busy: boolean };
type Remembered = { selected?: string; query?: string };
type Tick = { run: number; drawn: number; width: number; height: number; look: string; misses: number };

const DEFAULTS: Prefs = { scene: 'ember', speed: 'normal', density: 'normal', calm: true, image: null, family: '' };
const SPEEDS: Speed[] = ['normal', 'slow', 'off'];
const DENSITIES: Density[] = ['normal', 'sparse', 'dense'];
const DENSITY: Record<Density, number> = { sparse: 0.5, normal: 1, dense: 1.8 };
const FRAME_MS = 125;
const SLOW_MS = 250;
const RASTER = 'omd_theme_scene';
const MIN_COLUMNS = 60;
const MAX_COLUMNS = 512;
const MAX_ROWS = 256;
const DEFAULT_FONT = 'JetBrains Mono';
const BEHIND = 0.55;
const BEHIND_CAP = 64;
const WELCOME_CAP = 150;
const BAND_CELLS = 14_000;
const STARTUP_MS = 3000;
const RETRY_MS = 250;
const HIDDEN_MS = 1000;
const STILL_POLL_MS = 1500;
const PAUSE_POLL_MS = 400;
const UNKNOWN_RETRIES = 40;
const SAMPLE = { columns: 60, rows: 24 };
const TABS = [{ id: 'scenes', title: 'Scenes' }, { id: 'motion', title: 'Motion' }, { id: 'terminal', title: 'Terminal' }];
const encoder = new TextEncoder();
const clip = (text: string, bytes: number) => encoder.encode(text).length <= bytes ? text : text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes - 3)).read) + '…';

const size = (view: View) => ({ width: Math.min(MAX_COLUMNS, view.columns), height: Math.min(MAX_ROWS, view.rows) });
const chatArea = (view: View, width: number, height: number): Area => {
  const chat = view.chat;
  if (!chat || chat.x >= width || chat.y >= height) return { x: 0, y: 0, columns: width, rows: height };
  return { x: chat.x, y: chat.y, columns: Math.max(1, Math.min(chat.columns, width - chat.x)), rows: Math.max(1, Math.min(chat.rows, height - chat.y)) };
};
const blocked = (view: View) => !view.color || view.colors === '16' || view.surface === 'inline';
const drawable = (s: State) => !!s.prefs && !!s.view && s.prefs.scene !== 'off' && (s.prefs.scene !== 'image' || !!s.prefs.image)
  && !blocked(s.view) && s.view.columns >= MIN_COLUMNS;
const still = (s: State) => !!s.view?.reduced || s.prefs?.speed === 'off';
const paused = (s: State) => s.busy && !!s.prefs?.calm;
const behind = (s: State) => s.view?.phase !== 'fresh' || s.view?.welcome === false;
const fontName = (value: string) => clip(value.replace(/["\\\n\r]/g, '').trim(), 128);
const palette = (prefs: Prefs) => prefs.scene === 'image' && prefs.image ? samplePalette(prefs.image) : (scene(prefs.scene) ?? SCENES[0]).palette!;
const stepsFor = (prefs: Prefs, terminal: Terminal, topic: Topic, family = prefs.family) =>
  steps(terminal, topic, palette(prefs), prefs.scene === 'off' ? SCENES[0].id : prefs.scene, family || DEFAULT_FONT);
const rasterFor = (thread: string | null | undefined) => thread ? `omd_theme_${thread.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 48) : RASTER;
const tickKey = (tick: Tick) => ['f', tick.run, tick.drawn, tick.width, tick.height, tick.look, tick.misses].join('.');
const parseTick = (key: string): Tick | null => {
  const [tag, run, drawn, width, height, look, misses] = key.split('.');
  return tag === 'f' ? { run: Number(run), drawn: Number(drawn), width: Number(width), height: Number(height), look, misses: Number(misses) } : null;
};
const restarted = (reply: { ok: true; value: { frame: number; queued: number } | { status: string } } | { ok: false }) =>
  reply.ok && !('status' in reply.value) && reply.value.frame === 1 && reply.value.queued > 0;
const bands = (rect: Rect): Rect[] => {
  const rows = Math.max(1, Math.floor(BAND_CELLS / rect.width));
  const out: Rect[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y += rows) out.push({ ...rect, y, height: Math.min(rows, rect.y + rect.height - y) });
  return out;
};

export default function activate(api: ModAPI) {
  api.builtins({ commands: { replace: { theme: 'scenes' } } });

  const read = (): State => ({ prefs: null, view: null, run: 0, switched: null, busy: false, ...api.state.get() as Partial<State> | null });
  const write = (patch: Partial<State>) => api.state.set({ ...read(), ...patch } as unknown as Json);
  const stored = () => {
    const record = api.host.tryCall('store.get', { key: 'prefs', scope: 'user' });
    return record.ok ? record.value : null;
  };
  const load = (): Prefs => {
    const value = (stored()?.value ?? {}) as Partial<Prefs>;
    const image = value.image && typeof value.image.rgb === 'string' && value.image.rgb.length === value.image.width * value.image.height * 6 ? value.image : null;
    const known = value.scene === 'off' || (value.scene === 'image' ? !!image : !!scene(value.scene));
    const pick = <T extends string>(found: unknown, allowed: T[]) => allowed.includes(found as T) ? found as T : allowed[0];
    return { scene: known ? value.scene! : DEFAULTS.scene, speed: pick(value.speed, SPEEDS), density: pick(value.density, DENSITIES),
      calm: value.calm !== false, image, family: typeof value.family === 'string' ? fontName(value.family) : '' };
  };
  const save = (prefs: Prefs, patch: Partial<State> = {}) => {
    write({ ...patch, prefs });
    api.host.tryCall('store.put', { key: 'prefs', value: prefs as unknown as { [key: string]: Json }, expected_revision: stored()?.revision ?? null, scope: 'user' });
  };
  const schedule = (tick: Tick, delay: number) => api.host.call('events.schedule', { key: tickKey(tick), delay_ms: Math.max(16, Math.round(delay)) });
  const first = (run: number): Tick => ({ run, drawn: -1, width: 0, height: 0, look: '0', misses: 0 });
  const restart = () => {
    const run = Date.now();
    write({ run });
    api.host.tryCall('events.publish', { channel: 'wake', data: run });
  };
  const begin = () => {
    const run = Date.now();
    write({ prefs: load(), run, busy: false });
    schedule(first(run), 16);
  };

  api.on('start', begin);
  api.on('resume', begin);
  api.on('channel', ({ channel, data }) => {
    if (channel === 'omd_theme/wake' && typeof data === 'number') schedule(first(data), 16);
  });
  api.on('turn_start', () => {
    if (!read().busy) write({ busy: true });
  });
  api.on('turn_end', () => {
    if (read().busy) write({ busy: false });
  });

  api.on('timer', ({ key }) => {
    const tick = parseTick(key);
    const s = read();
    if (!tick || tick.run < s.run || !s.prefs) return;
    const now = Date.now();
    const again = (delay: number, next: Partial<Tick> = {}) => schedule({ ...first(tick.run), ...next }, delay);
    if (tick.run > s.run) {
      if (tick.misses < UNKNOWN_RETRIES) again(RETRY_MS, { misses: tick.misses + 1 });
      return;
    }
    if (!drawable(s)) {
      const starting = now - s.run < STARTUP_MS;
      if (starting || s.prefs.scene !== 'off' && (!s.view || !blocked(s.view))) again(starting ? RETRY_MS : HIDDEN_MS);
      return;
    }
    try {
      draw(s, now, tick, again);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      again(HIDDEN_MS);
    }
  });

  const draw = (s: State, now: number, tick: Tick, again: (delay: number, next?: Partial<Tick>) => void) => {
    const view = s.view!;
    const prefs = s.prefs!;
    const { width, height } = size(view);
    const chat = chatArea(view, width, height);
    const look = [view.raster, behind(s) ? 1 : 0, chat.x, chat.y, chat.columns, chat.rows].join('-');
    const same = tick.width === width && tick.height === height && tick.look === look;
    const quiet = still(s);
    const period = prefs.speed === 'slow' ? SLOW_MS : FRAME_MS;
    const k = quiet ? 0 : paused(s) && tick.drawn > 0 ? tick.drawn : Math.max(1, Math.floor((now - s.run) / period));
    const poll = quiet ? STILL_POLL_MS : PAUSE_POLL_MS;
    const shown = { width, height, look };
    const frame = (n: number) => {
      const art = compose(prefs.scene, quiet ? null : s.switched?.from ?? null, s.switched ? revealProgress(s.run + n * period - s.switched.at) : 1,
        chat.columns, chat.rows, DENSITY[prefs.density], prefs.image, quiet ? STILL_SECONDS : n * FRAME_SECONDS);
      const canvas = place(art, width, height, chat.x, chat.y);
      return behind(s) ? shade(canvas, BEHIND, BEHIND_CAP) : shade(canvas, 0, WELCOME_CAP);
    };
    const next = frame(k);
    if ((quiet || paused(s)) && same && tick.drawn === k) {
      const cell = { x: 0, y: 0, width: 1, height: 1 };
      const kept = api.host.tryCall('terminal.blit', { key: view.raster, rect: cell, packed: pack(next, cell) });
      again(poll, { ...shown, drawn: restarted(kept) ? -1 : k });
      return;
    }
    const partial = !quiet && same && tick.drawn > 0;
    const rects = partial ? changed(frame(tick.drawn), next) : bands({ x: 0, y: 0, width, height });
    let lost = false;
    for (const band of rects) {
      const reply = api.host.tryCall('terminal.blit', { key: view.raster, rect: band, packed: pack(next, band) });
      if (reply.ok && !('status' in reply.value)) {
        lost ||= partial && restarted(reply);
        continue;
      }
      const misses = tick.misses + 1;
      again(reply.ok && 'status' in reply.value ? Math.max(HIDDEN_MS, reply.value.retry_after_ms) : misses > UNKNOWN_RETRIES ? HIDDEN_MS : RETRY_MS, { ...shown, misses });
      return;
    }
    again(quiet || paused(s) ? poll : s.run + (k + 1) * period - now, { ...shown, drawn: lost ? -1 : k });
  };

  api.on('terminal', (input): TerminalPatch | null => {
    const s = read();
    const client = input.client;
    const view: View | null = client ? { columns: client.columns, rows: client.rows, reduced: client.reduced_motion, color: client.graphics !== 'text', colors: client.colors ?? 'truecolor',
      phase: input.presentation?.phase ?? null, surface: input.presentation?.surface ?? null, chat: client.chat ?? null, welcome: client.welcome !== null,
      raster: rasterFor(input.presentation?.thread_id) } : s.view;
    if (JSON.stringify(view) !== JSON.stringify(s.view)) write({ view });
    const prefs = s.prefs;
    if (!prefs || !view) return null;
    if (!drawable({ ...s, view })) return {};
    const patch: TerminalPatch = { underlay: { raster: view.raster } };
    if (view.phase !== 'fresh') return patch;
    patch.welcome = { show_while_composing: true };
    return { ...patch, sites: { welcome: { mode: 'wrap', components: [
      { type: 'box', id: 'omd_theme_hidden', label: 'Welcome hidden by the theme', min_width: 500, children: [{ type: 'slot' }] },
    ] } } };
  });

  const remembered = (): Remembered => api.uiState.get() as Remembered | null ?? {};
  const terminalHere = (): Terminal | null => {
    const read = api.host.tryCall('environment.read', { names: ENVIRONMENT });
    return read.ok ? detect(read.value.values) : null;
  };
  const item = (entry: TerminalPanelItem): TerminalPanelItem => ({ ...entry, label: clip(entry.label, 128), ...entry.description ? { description: clip(entry.description, 256) } : {} });
  const listing = (prefs: Prefs, notice: string | null): TerminalPanel => {
    const here = terminalHere();
    const showing = prefs.scene === 'off' ? 'no scene' : prefs.scene === 'image' ? prefs.image?.label ?? 'your image' : scene(prefs.scene)?.name;
    const scenes = SCENES.filter(entry => entry.id !== 'image' || prefs.image).map(entry => item({
      id: `scene:${entry.id}`, tab: 'scenes', group: 'Scenes', kind: 'action', label: `${entry.id === prefs.scene ? '● ' : ''}${entry.id === 'image' ? `${entry.name}: ${prefs.image!.label}` : entry.name}`,
      description: entry.id === prefs.scene ? 'showing' : undefined, keywords: entry.id, detail: entry.detail,
    }));
    const order = here ? [here, ...TERMINALS.filter(name => name !== here)] : TERMINALS;
    const terminal = order.flatMap(name => TOPICS[name].filter(topic => topic !== 'font').map(topic => item({
      id: `steps:${name}:${topic}`, tab: 'terminal', group: name === here ? `${name} (this terminal)` : name, kind: 'action', label: LABELS[topic], description: 'Shows the lines to add; changes nothing',
    })));
    const { selected, query } = remembered();
    return {
      title: 'Theme', subtitle: clip([`Showing: ${showing} · motion ${prefs.speed}`, notice].filter(Boolean).join('\n'), 2000),
      tabs: TABS, search: true, action: { command: 'scenes', args: 'panel' }, close_args: 'closed', ...selected ? { selected } : {}, ...query ? { query } : {},
      items: [
        item({ id: 'syntax', tab: 'scenes', kind: 'action', label: 'Syntax colours…', description: "Codex's own syntax-highlighting theme picker", detail: 'Opens the /theme picker Codex ships; this mod takes over /theme while it is on.' }),
        ...scenes,
        item({ id: 'scene:off', tab: 'scenes', group: 'Scenes', kind: 'action', label: `${prefs.scene === 'off' ? '● ' : ''}No scene`, detail: 'Sessions show the usual welcome and colours.' }),
        item({ id: 'image', tab: 'scenes', kind: 'text', value: '', label: 'Your image…', description: 'A PNG or JPEG path, drawn as glyph tiles', detail: 'Asks before reading the file and keeps only a small colour sample.' }),
        item({ id: 'speed', tab: 'motion', kind: 'choice', value: prefs.speed, label: 'Animation', options: [{ value: 'normal', label: 'Normal' }, { value: 'slow', label: 'Slow' }, { value: 'off', label: 'Off (one still frame)' }] }),
        item({ id: 'density', tab: 'motion', kind: 'choice', value: prefs.density, label: 'Drifting glyphs', options: [{ value: 'sparse', label: 'Sparse' }, { value: 'normal', label: 'Normal' }, { value: 'dense', label: 'Dense' }] }),
        item({ id: 'calm', tab: 'motion', kind: 'toggle', value: prefs.calm, label: 'Calm while working', description: 'Pauses the scene while a turn runs' }),
        item({ id: 'font', tab: 'terminal', kind: 'text', value: prefs.family, label: 'Font family…', description: here ? `Steps for ${here}` : 'Steps for each terminal' }),
        ...terminal,
      ],
    };
  };
  const stepsPanel = (prefs: Prefs, terminal: Terminal | null, topic: Topic, notice: string | null): TerminalPanel => {
    const shown = (terminal ? [terminal] : TERMINALS).map(name => stepsFor(prefs, name, topic));
    return {
      title: terminal ? shown[0].title : LABELS[topic], action: { command: 'scenes', args: `steps ${terminal ?? 'all'} ${topic}` },
      subtitle: clip([...shown.map(entry => terminal ? entry.text : `${entry.title}\n${entry.text}`), notice].filter(Boolean).join('\n\n'), 2000),
      items: [item({ id: 'copy', kind: 'action', label: 'Copy to the clipboard', description: topic === 'shader' ? 'Copies the shader' : 'Copies the lines above; Esc returns to Theme' })],
    };
  };
  const show = (panel: TerminalPanel) => {
    const shown = api.host.tryCall('terminal.panel', panel);
    return shown.ok ? null : { display: `/theme is unavailable here: ${shown.error}` };
  };
  const choose = (prefs: Prefs, id: string) => {
    if (id === prefs.scene) return;
    const at = Date.now();
    save({ ...prefs, scene: id }, { switched: { from: prefs.scene, at } });
    restart();
  };
  const sample = (prefs: Prefs, path: string): string => {
    const resource = api.host.call('terminal.import_file', { path, max_bytes: 8 * 1024 * 1024 });
    if ('status' in resource) return 'Image import declined; the scene is unchanged';
    const { width, height, rgba } = api.host.call('terminal.image_sample', { resource, ...SAMPLE });
    let rgb = '';
    for (let i = 0; i < width * height; i++) {
      const alpha = rgba[i * 4 + 3] / 255;
      rgb += [0, 1, 2].map(channel => Math.round(rgba[i * 4 + channel] * alpha).toString(16).padStart(2, '0')).join('');
    }
    const label = clip(path.split('/').at(-1) || path, 64);
    save({ ...prefs, image: { label, width, height, rgb }, scene: 'image' }, { switched: { from: prefs.scene, at: Date.now() } });
    restart();
    return `Scene set to ${label}`;
  };
  const change = (prefs: Prefs, id: string, value: string): string | null => {
    if (id.startsWith('scene:')) {
      choose(prefs, id.slice(6));
      return null;
    }
    if (id === 'image') return value ? sample(prefs, value) : null;
    if (id === 'speed' && SPEEDS.includes(value as Speed) || id === 'density' && DENSITIES.includes(value as Density)) {
      save({ ...prefs, [id]: value });
      restart();
      return null;
    }
    if (id === 'calm') save({ ...prefs, [id]: value === 'true' });
    if (id === 'font') save({ ...prefs, family: fontName(value) });
    return null;
  };
  api.command('scenes', input => {
    const raw = String(input ?? '').trim();
    const [, verb, id, value] = raw.match(/^(\S*)\s*(\S*)\s*([\s\S]*)$/)!;
    const prefs = read().prefs ?? load();
    try {
      if (verb === 'closed') {
        api.uiState.set({ selected: id && id !== '-' ? id : undefined, query: clip(value, 128) || undefined } as Json);
        return null;
      }
      if (verb === 'syntax' || verb === 'panel' && id === 'syntax') {
        const invoked = api.host.tryCall('commands.invoke', { command: 'theme' });
        if (invoked.ok && !('status' in invoked.value)) return null;
        return { display: `Codex's theme picker is unavailable: ${invoked.ok ? 'declined' : invoked.error}` };
      }
      if (verb === 'panel' && id.startsWith('steps:')) {
        const [, terminal, topic] = id.split(':');
        return show(stepsPanel(prefs, terminal as Terminal, topic as Topic, null));
      }
      if (verb === 'panel' && id === 'font' && value) {
        change(prefs, id, value);
        return show(stepsPanel({ ...prefs, family: fontName(value) }, terminalHere(), 'font', null));
      }
      if (verb === 'panel') {
        let notice: string | null = null;
        try {
          notice = id ? change(prefs, id, value) : null;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          notice = error.message;
        }
        return show(listing(read().prefs ?? prefs, notice));
      }
      if (verb === 'steps') {
        const [terminal, topic, action] = [id, ...value.split(/\s+/)] as [string, Topic, string];
        const who = terminal === 'all' ? null : terminal as Terminal;
        if (action !== 'copy') return show(stepsPanel(prefs, who, topic, null));
        const text = (who ? [who] : TERMINALS).map(name => stepsFor(prefs, name, topic).copy).filter(Boolean).join('\n\n');
        const copied = api.host.tryCall('terminal.copy', { text });
        const done = copied.ok && (copied.value.status === 'confirmed' || copied.value.status === 'pending');
        return show(stepsPanel(prefs, who, topic, done ? 'Copied. Nothing else was changed.' : `Copy ${copied.ok ? `not confirmed (${copied.value.status})` : `failed: ${copied.error}`}`));
      }
      if (verb === 'image' && id) return { display: sample(prefs, raw.replace(/^image\s+/, '')) };
      if (verb === 'off' || scene(verb)) {
        if (verb === 'image' && !prefs.image) return { display: 'Pick an image first: /theme image PATH' };
        choose(prefs, verb);
        return null;
      }
      if (verb === 'font' || verb === 'terminal') {
        const here = terminalHere();
        const family = verb === 'font' ? fontName([id, value].filter(Boolean).join(' ')) : '';
        if (verb === 'font' && !family) return { display: 'Usage: /theme font FAMILY' };
        if (family) change(prefs, 'font', family);
        const topics: Topic[] = verb === 'font' ? ['font'] : here ? TOPICS[here] : ['font', 'glass'];
        const text = (here ? [here] : TERMINALS).flatMap(name => topics.filter(topic => TOPICS[name].includes(topic))
          .map(topic => stepsFor(prefs, name, topic, family || prefs.family)))
          .map(entry => `${entry.title}\n${entry.text}${entry.copy.includes('mainImage') ? `\n\n${entry.copy}` : ''}`);
        return { display: [here ? null : 'Terminal not detected; the steps for each supported terminal:', ...text].filter(Boolean).join('\n\n') };
      }
      if (verb) return { display: `Usage: /theme [${SCENES.map(entry => entry.id).join('|')}|off|syntax|image PATH|font FAMILY|terminal]` };
      return show(listing(prefs, null));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: error.message };
    }
  }, { description: 'Living scenes behind the whole screen, motion and terminal background steps; Syntax colours opens Codex\'s picker', args_hint: '[scene|off|syntax|terminal]' });
}
