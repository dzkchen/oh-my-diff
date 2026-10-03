import type { Json, ModAPI } from '@oh-my-diff/mod-api';

const VERSION = '1.0.0';

export default function activate(api: ModAPI) {
  const solo = api.settings.mode === 'solo';

  const remember = (entry: Json) => {
    const stored = api.state.get();
    api.state.set([...(Array.isArray(stored) ? stored : []), entry].slice(-16));
  };

  api.replace('routing', ({ routes }) => {
    const chosen = routes.find(route => route.name === (solo ? 'sol' : 'astra')) ?? routes[0];
    remember({ decision: 'routing', route: chosen?.name ?? null });
    return chosen ? { route: chosen.name } : null;
  });

  api.command('atlas', () => ({
    display: `atlas_policy ${VERSION} routes every turn to ${solo ? 'sol' : 'astra'}.`,
  }), { description: 'Show the Atlas routing policy' });
}
