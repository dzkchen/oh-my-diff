import type { LayoutNode, ModAPI, TerminalCell, TerminalPatch } from '@oh-my-diff/mod-api';

type State = { running: boolean; reduced: boolean; started: number; first: number | null; reported: number; status: string };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const UPPER_HALF = 0x2580;

const base64 = (bytes: Uint8Array) => {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out.push(ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '='));
  }
  return out.join('');
};

const bounded = (value: unknown, fallback: number, most: number) => Math.min(most, Math.max(1, Math.floor(Number(value ?? fallback)) || fallback));

const channel = (value: number) => Math.round(127.5 + 127.5 * Math.sin(value));

const wave = (x: number, y: number, t: number) => {
  const v = Math.sin(x / 9 + t) + Math.sin(y / 6 - t * 0.7) + Math.sin((x + y) / 13 + t * 0.4);
  return (channel(v) << 16) | (channel(v + 2.1) << 8) | channel(v + 4.2);
};

const frame = (width: number, height: number, t: number, mode: string) => {
  if (mode === 'cells') {
    const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}` as const;
    const cells: TerminalCell[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push(['▀', hex(wave(x, y * 2, t)), hex(wave(x, y * 2 + 1, t))]);
    return { cells };
  }
  const view = new DataView(new ArrayBuffer(width * height * 12));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 12;
      view.setUint32(at, UPPER_HALF, true);
      view.setUint32(at + 4, wave(x, y * 2, t), true);
      view.setUint32(at + 8, wave(x, y * 2 + 1, t), true);
    }
  }
  return { packed: base64(new Uint8Array(view.buffer)) };
};

export default function activate(api: ModAPI) {
  const read = (): State => ({ running: false, reduced: false, started: 0, first: null, reported: 0, status: 'stopped', ...api.state.get() as Partial<State> | null });
  const write = (patch: Partial<State>) => api.state.set({ ...read(), ...patch });
  const size = () => ({ width: bounded(api.settings.width, 64, 512), height: bounded(api.settings.height, 16, 256) });
  const mode = () => String(api.settings.mode ?? 'packed');

  api.command('wave', argument => {
    const running = argument === 'start' ? true : argument === 'stop' ? false : !read().running;
    write({ running, started: Date.now(), first: null, status: running ? 'starting' : 'stopped' });
    if (running) api.host.tryCall('events.publish', { channel: 'wake', data: null });
    return { display: running ? 'Wave started' : 'Wave stopped' };
  }, { description: 'Start or stop the half-block wave: /raster_wave:wave [start|stop]' });

  api.on('channel', ({ channel: name }) => {
    if (name === 'raster_wave/wake') api.host.call('events.schedule', { key: 'tick', delay_ms: 100 });
  });

  api.on('timer', ({ key }) => {
    const s = read();
    if (key !== 'tick' || !s.running || s.reduced) return;
    const { width, height } = size();
    const now = Date.now();
    const reply = api.host.tryCall('terminal.blit', { key: 'raster_wave', rect: { x: 0, y: 0, width, height }, ...frame(width, height, now / 400, mode()) });
    let delay = 16;
    if (!reply.ok) {
      delay = 250;
      if (s.status !== reply.error) write({ status: reply.error });
    } else if ('status' in reply.value) {
      delay = reply.value.retry_after_ms;
    } else if (s.first === null) {
      write({ first: reply.value.frame, reported: reply.value.frame, started: now });
    } else if (reply.value.frame - s.reported >= 60) {
      const fps = (reply.value.frame - s.first) / Math.max(0.001, (now - s.started) / 1000);
      write({ reported: reply.value.frame, status: `${mode()} ${width}×${height}: ${fps.toFixed(1)} frames/s, ${Math.round(fps * width * height)} cells/s` });
    }
    api.host.call('events.schedule', { key: 'tick', delay_ms: Math.max(16, delay) });
  });

  api.on('terminal', (input): TerminalPatch => {
    const s = read();
    const reduced = input.client?.reduced_motion === true;
    if (reduced !== s.reduced) write({ reduced });
    const { width, height } = size();
    const layout: LayoutNode = { split: 'vertical', ratio: [3, 1], children: [
      { content: 'site:raster_wave/canvas' },
      { split: 'vertical', ratio: [4, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
    ] };
    return { layout, sites: { 'raster_wave/canvas': { mode: 'replace', components: [
      { type: 'text', id: 'raster_wave_status', label: 'Wave status', text: reduced && s.running ? 'paused: reduced motion' : s.status },
      { type: 'raster', id: 'raster_wave', label: 'Wave', alt: 'Animated half-block wave', width, height },
    ] } } };
  });
}
