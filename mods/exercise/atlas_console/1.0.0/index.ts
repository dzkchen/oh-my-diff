import type { ModAPI } from '@oh-my-diff/mod-api/0.1';

export default function activate(api: ModAPI) {
  api.replace('terminal', ({ event }) => {
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
