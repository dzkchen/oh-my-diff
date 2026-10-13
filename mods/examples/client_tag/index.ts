import type { ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.component<null, string>('tag', {
    view: (_, ui) => ({ type: 'text', id: 'tag', label: 'Tag', text: ui.props }),
    pointer: (_, event, ui) => {
      if (event.action === 'down') ui.post({ column: event.column, row: event.row });
    },
  });
  api.on('component_post', ({ data }) => api.state.set(data));
  api.on('terminal', (): TerminalPatch => {
    const clicked = api.state.get() as { column: number; row: number } | null;
    return {
      sites: {
        above_composer: { mode: 'wrap', components: [
          { type: 'slot' },
          { type: 'module', id: 'client_tag', label: 'Tag', module: 'tag', props: 'Click this tag', pointer: true },
          { type: 'text', id: 'client_tag_clicked', label: 'Last click', tone: 'muted',
            text: clicked ? `Last click at column ${clicked.column}, row ${clicked.row}` : 'No click yet' },
        ] },
      },
    };
  });
}
