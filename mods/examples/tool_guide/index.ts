import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.replace('tool_specs', event => {
    if (!event.route?.model.includes('mini')) return null;
    return {
      hide: event.tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name),
      describe: { apply_patch: { description: 'Edit files with a unified patch. Keep hunks small.' } },
    };
  });
}
