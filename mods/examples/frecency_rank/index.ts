import type { ModAPI } from '@oh-my-diff/mod-api';

type Counts = Record<string, number>;

export default function activate(api: ModAPI) {
  const counts = (): Counts => (api.state.get() ?? {}) as Counts;
  api.intercept('input', (event, next) => {
    const seen = counts();
    for (const [, path] of event.text.matchAll(/@([\w./-]+)/g)) seen[path] = (seen[path] ?? 0) + 1;
    api.state.set(seen);
    return next(event);
  });
  api.command('recent', path => ({ display: `recent ${String(path)}` }));
  api.replace('completion', event => {
    const seen = counts();
    if (event.kind === 'argument') {
      if (event.command !== 'recent' && event.command !== 'frecency_rank:recent') return null;
      return { items: Object.keys(seen).filter(path => path.startsWith(event.query)).map(insert => ({ insert })) };
    }
    const items = [...event.candidates].sort((a, b) => (seen[b.path] ?? 0) - (seen[a.path] ?? 0) || b.score - a.score);
    return { items: items.map(({ path }) => ({ path })) };
  });
}
