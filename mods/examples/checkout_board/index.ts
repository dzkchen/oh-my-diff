import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  const lines = () => (api.state.get() as string[] | null) ?? [];
  api.command('board', text => {
    const line = String(text ?? '').trim();
    api.state.set(line ? [...lines(), line].slice(-20) : []);
    return { display: line ? 'Pinned for every session in this checkout' : 'Board cleared' };
  }, { description: 'Pin a line that every OMD session in this Git checkout sees, or clear the board' });
  api.on('terminal', () => lines().length ? { sites: { sidebar: { mode: 'wrap', components: [
    { type: 'pane', id: 'checkout_board', label: 'Checkout board', title: 'Checkout board',
      children: lines().map((text, index) => ({ type: 'text', id: `checkout_board_${index}`, label: 'Pinned line', text })) },
    { type: 'slot' },
  ] } } } : null);
}
