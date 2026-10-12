import type { ModAPI, TerminalClient, TerminalPatch } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  const state = () => (api.state.get() as { client?: TerminalClient; metrics?: string } | null) ?? {};
  api.on('start', () => {
    const node = api.host.call('process.which', { names: ['node'] }).found[0];
    if (!node || !api.settings.producer) return;
    const transport = String(api.settings.transport ?? 'raw');
    api.host.call('process.start', {
      session: 'frames', name: 'node', path: node.path, sha256: node.sha256,
      arguments: [String(api.settings.producer), transport, '{process.home}/frames.jsonl', String(api.settings.mouse_helper ?? '')],
      ...(api.settings.mouse_helper ? { sandbox: 'none' as const } : {}),
      framing: 'ndjson', raster: 'frame_pixels', keys: 'frame_keys', pixels: transport === 'raw',
    });
    api.host.call('events.schedule', { key: 'metrics', delay_ms: 1000 });
  });
  api.on('timer', ({ key }) => {
    if (key !== 'metrics') return;
    const result = api.host.call('process.exchange', { session: 'frames', wait_ms: 0 });
    const metrics = result.messages.find(message => message && typeof message === 'object' && !Array.isArray(message) && 'metrics' in message);
    if (metrics && typeof metrics === 'object' && !Array.isArray(metrics) && typeof metrics.metrics === 'string') {
      api.state.set({ ...state(), metrics: metrics.metrics });
    }
    else api.host.call('events.schedule', { key: 'metrics', delay_ms: 1000 });
  });
  api.on('terminal', ({ client }): TerminalPatch => {
    if (client && JSON.stringify(client) !== JSON.stringify(state().client)) api.state.set({ ...state(), client });
    return {
      layout: { split: 'vertical', ratio: [Math.max(1, Math.min(94, (client?.rows ?? 24) - 9)), 4, 5], children: [
        { content: 'site:frame_stream/canvas' }, { content: 'transcript' }, { content: 'composer' },
      ] },
      sites: { 'frame_stream/canvas': { components: [
        { type: 'raster', id: 'frame_pixels', label: 'Frame stream', alt: 'Waiting for the frame producer', pointer: true },
        { type: 'document', id: 'frame_keys', label: 'Frame controls', height: 1, keys: true, lines: [[{ text: 'Frame stream controls' }]] },
      ] } },
    };
  });
}
