import type { Json, ModAPI, TerminalView } from '@oh-my-diff/mod-api';

const VERSION = '2.0.0';

export default function activate(api: ModAPI) {
  const held = (): { [key: string]: Json } => {
    const stored = api.state.get();
    return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  };

  const activity = (): string[] => {
    const stored = held().activity;
    return Array.isArray(stored) ? stored.map(String) : [];
  };

  const density = (): string => {
    const chosen = held().density ?? api.settings.density;
    return chosen === 'roomy' ? 'roomy' : 'compact';
  };

  const note = (line: string) => api.state.set({ ...held(), version: 2, activity: [...activity(), line].slice(-8) });

  api.on('migrate', ({ from }) => {
    const stored = api.state.get();
    api.state.set({
      version: 2,
      migrated_from: from,
      density: 'compact',
      activity: Array.isArray(stored) ? stored.map(String).slice(-8) : [],
    });
  });

  api.on('turn_start', ({ turn_id }) => note(`▸ turn ${turn_id}`));

  api.on('turn_end', ({ turn_id, outcome }) => note(`■ turn ${turn_id} ${outcome}`));

  api.on('terminal', ({ event }): TerminalView => {
    const roomy = density() === 'roomy';
    const lines = activity();
    return {
      title: `Atlas console ${VERSION}`,
      sidebar_side: api.settings.side === 'left' ? 'left' : 'right',
      sidebar_width: roomy ? 42 : 28,
      panels: [
        { title: 'Scope', lines: [`density ${density()}`, `latest ${event}`] },
        { title: 'Activity', lines: lines.length ? lines : ['no turns yet'] },
      ],
      header: { title: 'Atlas', lines: ['outside-author console'] },
      footer: { title: 'Keys', lines: ['F6 draft · Alt+r review · Alt+x reset counter · Alt+p policy'] },
      status: [`atlas:${density()}`],
      theme: { accent: 111, user_message_background: '#1b2430', success: 78, attention: 214, failure: '#ff5f5f' },
      keybindings: {
        F6: 'Summarize the remaining acceptance work.',
        'Alt+r': { submit: 'Review the current changes and list remaining risks.' },
        'Alt+x': { command: 'counter:reset' },
        'Alt+p': { command: 'atlas_policy:atlas' },
      },
    };
  });

  api.command('density', passed => {
    const requested = typeof passed === 'string' && passed.trim() ? passed.trim() : 'compact';
    api.state.set({ ...held(), version: 2, density: requested === 'roomy' ? 'roomy' : 'compact' });
    return { display: `Atlas console density is ${density()}.` };
  }, { description: 'Switch the console between compact and roomy' });
}
