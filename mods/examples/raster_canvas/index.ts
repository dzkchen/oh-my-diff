import type { ModAPI, TerminalCell, TerminalClient, TerminalPatch } from '@oh-my-diff/mod-api';

const W = 40;
const H = 8;
const FRAMES = 30;
type Graph = {
  phase: number; pan: number; client: TerminalClient | null;
  hover: { column: number; row: number } | null; grab: { column: number; pan: number } | null;
};

const sample = (x: number, phase: number) => Math.round(3.5 + 3.5 * Math.sin((x + phase) / 4));
const animated = (client: TerminalClient | null) => !client || (!client.reduced_motion && client.pointer !== 'none');

function cells(g: Graph): TerminalCell[] {
  const out: TerminalCell[] = [];
  for (let row = 0; row < H; row++) {
    for (let x = 0; x < W; x++) {
      const bg = g.hover?.column === x ? '#2a2f45' : null;
      out.push(sample(x + g.pan, g.phase) === H - 1 - row ? ['●', '#7aa2f7', bg] : [' ', null, bg]);
    }
  }
  return out;
}

export default function activate(api: ModAPI) {
  const graph = (): Graph => (api.state.get() as Graph | null) ?? { phase: 0, pan: 0, client: null, hover: null, grab: null };
  const schedule = () => api.host.call('events.schedule', { key: 'frame', delay_ms: 1000 });
  const backpressured = (g: Graph) => 'status' in api.host.call('terminal.blit', { key: 'canvas_graph', rect: { x: 0, y: 0, width: W, height: H }, cells: cells(g) });

  api.on('start', () => { if (animated(graph().client)) schedule(); });

  api.on('terminal', (input): TerminalPatch => {
    const g = graph();
    const client = input.client ?? null;
    if (JSON.stringify(client) !== JSON.stringify(g.client)) api.state.set({ ...g, client });
    const tip = g.hover && {
      mode: 'replace' as const,
      overlay: { anchor: { component: 'canvas_graph' }, offset: { x: g.hover.column + 1, y: g.hover.row + 1 }, width: 16, height: 3, z: 1, style: { border: 'rounded' as const } },
      components: [{ type: 'text' as const, id: 'graph_tip', label: 'Value under pointer', text: `x ${g.hover.column + g.pan} = ${sample(g.hover.column + g.pan, g.phase)}` }],
    };
    return {
      sites: {
        sidebar: { components: [{ type: 'raster', id: 'canvas_graph', label: 'Series graph', alt: 'Animated line graph; hover for a value, drag to pan', width: W, height: H, pointer: client?.pointer !== 'none' }] },
        ...(tip && { 'raster_canvas/tip': tip }),
      },
    };
  });

  api.on('timer', ({ key }) => {
    let g = graph();
    if (key !== 'frame' || !animated(g.client)) return;
    for (let i = 0; i < FRAMES; i++) {
      const next = { ...g, phase: g.phase + 1 };
      if (backpressured(next)) break;
      g = next;
    }
    api.state.set(g);
    schedule();
  });

  api.on('component_event', ({ component, kind, pointer }) => {
    if (component !== 'canvas_graph' || kind !== 'pointer' || !pointer) return;
    if (!['down', 'up', 'move', 'drag', 'enter', 'leave'].includes(pointer.action)) return;
    const g = graph();
    const { action, column, row } = pointer;
    if (action === 'down') g.grab = { column, pan: g.pan };
    if (action === 'drag' && g.grab) g.pan = g.grab.pan + g.grab.column - column;
    if (action === 'up') g.grab = null;
    g.hover = action !== 'leave' && column >= 0 && column < W && row >= 0 && row < H ? { column, row } : null;
    backpressured(g);
    api.state.set(g);
    if (action === 'enter' && animated(g.client)) schedule();
  });
}
