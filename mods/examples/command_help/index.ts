import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('command_help', query => {
    const text = String(query ?? '').trim();
    if (text.startsWith('run ')) {
      api.host.call('commands.invoke', { command: text.slice(4).trim() });
      return null;
    }
    const needle = text.toLowerCase();
    const commands = api.host.call('commands.list', null).commands.filter(item => !item.hidden);
    const matches = commands.filter(item => `${item.command} ${item.description}`.toLowerCase().includes(needle));
    return { display: matches.map(item => `/${item.command}  ${item.description}${item.owner ? ` (${item.owner})` : ''}`).join('\n') || `No command matches ${needle}` };
  });
}
