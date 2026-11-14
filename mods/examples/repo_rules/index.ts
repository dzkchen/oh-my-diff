import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.intercept('tool', { match: { tool: 'exec_command', arguments: { cmd: /\bgit\s+push\b.*\s(--force|-f)\b/ } } },
    () => ({ deny: 'Force-pushing is off in this repo. Push to a new branch instead.' }));

  api.command('standup', () => ({ submit: 'From git log since yesterday, write my standup as three short bullets.' }),
    { description: 'Ask the agent for a standup from recent commits' });
}
