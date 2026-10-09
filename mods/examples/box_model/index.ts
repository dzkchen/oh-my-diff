import type { LayoutNode, ModAPI, TerminalComponent, TerminalPatch } from '@oh-my-diff/mod-api';

type Look = { side: 'left' | 'right'; split: boolean; entered: number };

const metric = (id: string, title: string, value: string, flex: number): TerminalComponent => ({
  type: 'box', id, label: title, title, flex, min_width: 10,
  style: { border: 'rounded', padding: [0, 1], hover: { border: 'thick', foreground: 'accent' } },
  children: [{ type: 'text', id: `${id}_value`, label: `${title} value`, text: value }],
});

export default function activate(api: ModAPI) {
  const look = (): Look => ({ side: 'right', split: false, entered: 0, ...api.state.get() as Partial<Look> | null });
  api.command('box', argument => {
    const current = look();
    if (argument === 'side') api.state.set({ ...current, side: current.side === 'left' ? 'right' : 'left' });
    else if (argument === 'split') api.state.set({ ...current, split: !current.split });
    else return { display: 'usage: /box_model:box side|split' };
    return null;
  }, { description: 'Move the box model sidebar or toggle its split layout' });

  api.on('component_event', ({ component, kind, pointer }) => {
    if (component === 'box_model_status' && kind === 'pointer' && pointer?.action === 'enter') api.state.set({ ...look(), entered: look().entered + 1 });
  });

  api.on('terminal', (): TerminalPatch => {
    const { side, split, entered } = look();
    const cards: TerminalComponent[] = [
      { type: 'pane', id: 'box_model_card', label: 'Bordered card', title: 'Bordered card', children: [
        { type: 'box', id: 'box_model_metrics', label: 'Metrics', style: { direction: 'row', gap: 1 }, children: [
          metric('box_model_cpu', 'CPU', '12%', 1), metric('box_model_memory', 'Memory', '3.1 GB', 2),
        ] },
      ] },
      { type: 'pane', id: 'box_model_panel', label: 'Flat panel', title: 'Flat panel', style: { border: 'none', background: 236, padding: [0, 1], focus: { background: 238 } }, children: [
        { type: 'box', id: 'box_model_status', label: 'Hover target', pointer: true, style: { hover: { background: 'accent', foreground: 0 } }, children: [
          { type: 'text', id: 'box_model_entered', label: 'Pointer entries', text: `Pointer entered ${entered} times` },
        ] },
        { type: 'button', id: 'box_model_side', label: 'Move the sidebar', text: `Move ${side === 'left' ? 'right' : 'left'}`, action: { command: 'box_model:box', args: 'side' } },
      ] },
    ];
    const layout: LayoutNode = { split: 'horizontal', ratio: [2, 1], gap: 1, children: [
      { split: 'vertical', ratio: [4, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
      { content: 'site:box_model/cards', style: { border: 'double', padding: 1, gap: 1 } },
    ] };
    return split
      ? { layout, sites: { 'box_model/cards': { mode: 'replace', components: cards } } }
      : { sidebar_side: side, sidebar_width: 40, sidebar_style: { gap: 1 }, sites: { sidebar: { mode: 'wrap', components: [{ type: 'slot' }, ...cards] } } };
  });
}
