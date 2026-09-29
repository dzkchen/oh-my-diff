import type { ModAPI, TerminalView } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.replace('terminal', (): TerminalView => ({
    layout: { split: 'horizontal', ratio: [1, 3], children: [
      { tabs: [{ title: 'Diff', node: { content: 'site:layout_explorer/diff' } }, { title: 'Notes', node: { content: 'site:layout_explorer/notes' } }] },
      { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
    ] },
    backdrop: { ascii: { text: '·  ', dim: 0.6 } },
    sites: {
      'layout_explorer/diff': { components: [{ type: 'diff', id: 'explorer-diff', label: 'Working diff', unified: '+++ b/README.md\n@@ -1 +1 @@\n-old\n+new', action: { command: 'layout_explorer:open' } }] },
      'layout_explorer/notes': { components: [{ type: 'document', id: 'explorer-notes', label: 'Notes', lines: [[{ text: 'Select a line and press enter' }]] }] },
    },
  }));
  api.on('component_event', event => { api.state.set(event); });
  api.command('open', anchor => ({ display: `open ${String(anchor)}` }));
}
