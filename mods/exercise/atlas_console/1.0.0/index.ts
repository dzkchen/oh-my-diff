import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.on('terminal', ({ event }) => {
    const stored = api.state.get();
    const seen = [...(Array.isArray(stored) ? stored : []), event].slice(-8);
    api.state.set(seen);
    return {
      title: 'Atlas console',
      sidebar_width: 28,
      panels: [{ title: 'Events', lines: seen.map(String) }],
      keybindings: { 'Alt+x': { command: 'counter:reset' } },
    };
  });
}
