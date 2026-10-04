import type { ModAPI } from '@oh-my-diff/mod-api';

const DEPTH = 'agents.max_depth';

export default function activate(api: ModAPI) {
  api.intercept('command_list', async (event, next) => {
    const { commands } = await next(event);
    return {
      commands: commands.map(row => row.command === 'review' ? { ...row, args_hint: '[base branch]' }
        : row.command === 'feedback' ? { ...row, hidden: true } : row),
    };
  });
  api.intercept('command', (event, next) => event.command === 'compact' && event.active_turn
    ? { deny: 'compact after the turn ends' }
    : next({ ...event, args: event.args.trim() }));
  api.intercept('config_list', async (event, next) => {
    const { rows } = await next(event);
    return { rows: rows.map(row => row.key === DEPTH && !row.managed ? { ...row, label: 'Subagent depth (at most 3)' } : row) };
  });
  api.intercept('config_set', (event, next) => event.key === DEPTH && Number(event.value) > 3
    ? next({ ...event, value: 3 })
    : next(event));
  api.command('hidden', () => {
    const { commands } = api.host.call('commands.list', null);
    const hidden = commands.filter(row => row.hidden).map(row => `/${row.command}`);
    return { display: hidden.length ? hidden.join('\n') : 'No commands are hidden.' };
  }, { description: 'List the slash commands mods hide' });
}
