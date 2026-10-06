import type { ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  const query = api.atom('query', '');
  const ticks = api.atom('ticks', 0);
  const searches = api.member('counts', 'searches', 0);
  const summary = api.derive(() => `${query.get() || 'no filter'} · ${searches.get()} searches · ${ticks.get()} ticks`);
  api.subscribe(query, () => searches.update(count => count + 1));

  // The input submits through `search`; following every keystroke would re-run each terminal mod per edit.
  api.command('search', text => {
    query.set(typeof text === 'string' ? text.trim() : '');
    return null;
  });
  api.command('focus', () => {
    api.host.call('terminal.pane', { action: 'focus', id: 'dashboard_query' });
    return null;
  });
  api.command('stream', () => {
    api.host.call('events.publish', { channel: 'stream', data: null });
    return { display: 'Streaming status once a second for ten ticks.' };
  });
  api.on('channel', ({ channel }) => {
    if (channel === 'reactive_dashboard/stream') api.host.call('events.schedule', { key: 'tick', delay_ms: 1000 });
  });
  api.on('timer', ({ key }) => {
    if (key !== 'tick') return;
    ticks.update(count => count + 1);
    if (ticks.get() % 10) api.host.call('events.schedule', { key: 'tick', delay_ms: 1000 });
  });

  api.on('terminal', (): TerminalPatch => ({
    sidebar_width: 32,
    sites: { sidebar: { components: [
      { type: 'input', id: 'dashboard_query', label: 'Filter', value: query.get(), placeholder: 'type to filter', action: { command: 'reactive_dashboard:search' } },
      { type: 'text', id: 'dashboard_summary', label: 'Summary', text: summary.get(), tone: 'muted' },
    ] } },
  }));

  api.intercept('render', { match: { component: 'spinner' } }, async (event, next) => {
    const inner = await next(event);
    return { tree: [...inner.tree, { type: 'text', id: 'dashboard_ticks', label: 'Stream', text: `stream · ${ticks.get()} ticks`, tone: 'muted' }] };
  });
}
