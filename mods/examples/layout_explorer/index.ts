import type { ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

type Notes = { lines: string[]; row: number; col: number; tab?: number; ratio?: number[] };

export default function activate(api: ModAPI) {
  const notes = (): Notes => (api.state.get() as Notes | null) ?? { lines: [''], row: 0, col: 0 };
  api.on('terminal', (): TerminalPatch => {
    const { lines, row, col, tab = 0, ratio = [1, 3] } = notes();
    return {
      layout: { split: 'horizontal', ratio, children: [
        { tabs: [{ title: 'Diff', node: { content: 'site:layout_explorer/diff' } }, { title: 'Notes', node: { content: 'site:layout_explorer/notes' } }], active: tab },
        { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
      ] },
      backdrop: { ascii: { text: '·  ', dim: 0.6 } },
      sites: {
        'layout_explorer/diff': { mode: 'replace', components: [{ type: 'diff', id: 'explorer_diff', label: 'Working diff', unified: '+++ b/README.md\n@@ -1 +1 @@\n-old\n+new' }] },
        'layout_explorer/notes': { mode: 'replace', components: [
          { type: 'document', id: 'explorer_notes', label: 'Notes', keys: true, selected: { start: row, end: row },
            lines: lines.map((line, index) => index === row
              ? [{ text: line.slice(0, col) }, { text: line[col] ?? ' ', bg: '#7aa2f7' }, { text: line.slice(col + 1) }]
              : [{ text: line }]) },
          { type: 'line', id: 'explorer_hint', label: 'Hint', spans: [{ text: 'Focus Notes with Tab, type or paste; Ctrl+] leaves, Ctrl+C cancels', fg: '#7aa2f7', italic: true }] },
        ] },
      },
      keybindings: { 'Ctrl+Alt+n': { command: 'layout_explorer:open', args: 'palette' } },
    };
  });
  api.on('component_event', event => {
    if (event.kind === 'resize' && event.ratio?.length === 2) api.state.set({ ...notes(), ratio: event.ratio });
    if (event.kind === 'select' && event.component === 'r.0') api.state.set({ ...notes(), tab: event.index ?? 0 });
    if (event.component !== 'explorer_notes' || !event.events) return;
    let { lines, row, col } = notes();
    const insert = (text: string) => {
      const [first, ...rest] = (lines[row].slice(0, col) + text).split('\n');
      const tail = lines[row].slice(col);
      lines.splice(row, 1, first, ...rest);
      row += rest.length;
      col = lines[row].length;
      lines[row] += tail;
    };
    for (const input of event.events) {
      const key = 'key' in input ? input.key : null;
      if ('paste' in input) insert(input.paste);
      else if (input.text) insert(input.text);
      else if (key === 'Enter') insert('\n');
      else if (key === 'Backspace' && col > 0) lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col--);
      else if (key === 'Backspace' && row > 0) { col = lines[row - 1].length; lines.splice(row - 1, 2, lines[row - 1] + lines[row]); row--; }
      else if (key === 'Left') col = Math.max(0, col - 1);
      else if (key === 'Right') col = Math.min(lines[row].length, col + 1);
      else if (key === 'Up' || key === 'Down') {
        row = Math.max(0, Math.min(lines.length - 1, row + (key === 'Up' ? -1 : 1)));
        col = Math.min(col, lines[row].length);
      }
    }
    api.state.set({ ...notes(), lines, row, col });
  });
  api.command('open', anchor => ({ display: `open ${String(anchor)}` }));
}
