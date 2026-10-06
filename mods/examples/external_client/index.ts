import type { ModAPI, ResourceRef, TerminalCell, TerminalComponent, TerminalPatch } from '@oh-my-diff/mod-api';

const BADGE = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5NiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDk2IDMyIj48cmVjdCB3aWR0aD0iOTYiIGhlaWdodD0iMzIiIHJ4PSI2IiBmaWxsPSIjN2FhMmY3Ii8+PHRleHQgeD0iNDgiIHk9IjIxIiBmb250LWZhbWlseT0ibW9ub3NwYWNlIiBmb250LXNpemU9IjE0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjMWExYjI2Ij5leHRlcm5hbDwvdGV4dD48L3N2Zz4=';
const METER = (['#1a1b26', '#24283b', '#414868', '#565f89', '#7aa2f7', '#7dcfff', '#9ece6a', '#e0af68'] as const).map((color): TerminalCell => ['█', color, null]);
type State = { badge: ResourceRef | null; picked: string | null; clicked: string | null; ui: string };

export default function activate(api: ModAPI) {
  const read = (): State => ({ badge: null, picked: null, clicked: null, ui: 'not started', ...(api.state.get() as Partial<State> | null) });
  const write = (patch: Partial<State>) => api.state.set({ ...read(), ...patch });

  api.on('start', () => {
    if (!read().badge) write({ badge: api.host.call('evidence.write', { media_type: 'image/svg+xml', base64: BADGE, label: 'external client badge' }) });
    api.host.call('events.schedule', { key: 'paint', delay_ms: 1000 });
  });

  api.on('timer', ({ key }) => {
    if (key === 'paint') api.host.tryCall('terminal.blit', { key: 'external_meter', rect: { x: 0, y: 0, width: METER.length, height: 1 }, cells: METER });
  });

  api.on('terminal', (input): TerminalPatch => {
    const s = read();
    const clients = input.clients ?? [];
    const components: TerminalComponent[] = [
      { type: 'list', id: 'external_clients', label: 'Attached clients', height: 4, action: { command: 'external_client:pick' },
        rows: clients.map(client => ({ value: client.id, label: client.name,
          spans: [{ text: client.name, bold: true }, { text: ` ${client.renderer.kind} ${client.renderer.formats.join('/')}`, tone: 'muted' }] })) },
      { type: 'text', id: 'external_status', label: 'Client status',
        text: `${clients.length} attached; UI ${s.ui}; picked ${s.picked ?? 'none'}; badge clicked by ${s.clicked ?? 'nobody'}` },
      { type: 'raster', id: 'external_meter', label: 'Meter', alt: 'Eight-step color meter', width: METER.length, height: 1 },
    ];
    if (s.badge) components.push({ type: 'image', id: 'external_badge', label: 'Badge', image: s.badge, alt: 'Badge reading "external"', height: 2, pointer: true });
    return { sites: { sidebar: { components } } };
  });

  api.command('pick', id => {
    write({ picked: String(id) });
    return { display: `Picked ${String(id)}` };
  });

  api.command('launch', () => {
    const asked = api.host.tryCall('events.publish', { channel: 'launch', data: null });
    return { display: asked.ok ? 'Launching the text client' : 'Launching is unavailable here' };
  });

  api.on('channel', ({ channel }) => {
    if (channel !== 'external_client/launch') return;
    const url = String(api.settings.listen_url ?? '');
    const script = String(api.settings.client_path ?? '');
    const tokenFile = String(api.settings.token_file ?? '');
    if (!url || !script) return write({ ui: 'needs listen_url and client_path settings' });
    const node = api.host.call('process.which', { names: ['node'] }).found[0];
    if (!node) return write({ ui: 'cannot find node' });
    const started = api.host.tryCall('process.start', {
      session: 'ui', name: 'node', path: node.path, sha256: node.sha256, arguments: [script], sandbox: 'none', notify: ['exit'],
      environment: { EXTERNAL_CLIENT_URL: url, ...(tokenFile && { EXTERNAL_CLIENT_TOKEN_FILE: tokenFile }) },
    });
    write({ ui: started.ok ? 'running' : started.error });
  });

  api.on('process_event', ({ session, kind }) => {
    if (session === 'ui' && kind === 'exit') write({ ui: 'exited' });
  });

  api.on('component_event', ({ component, kind, pointer, client }) => {
    if (component === 'external_badge' && kind === 'pointer' && pointer?.action === 'down') write({ clicked: client ?? 'terminal' });
  });
}
