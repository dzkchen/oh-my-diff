import type { ModAPI } from '@oh-my-diff/mod-api';

type Counts = Record<string, number>;

export default function activate(api: ModAPI) {
  const counts = (): Counts => (api.state.get() ?? {}) as Counts;
  api.on('input', event => {
    const next = counts();
    for (const [, path] of event.text.matchAll(/@([\w./-]+)/g)) next[path] = (next[path] ?? 0) + 1;
    api.state.set(next);
    return null;
  });
  api.replace('completion', event => {
    const seen = counts();
    const items = [...event.candidates].sort((a, b) => (seen[b.path] ?? 0) - (seen[a.path] ?? 0) || b.score - a.score);
    return { items: items.map(({ path }) => ({ path })) };
  });
}
