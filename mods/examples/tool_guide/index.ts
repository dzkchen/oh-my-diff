import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.intercept('tool_specs', async (event, next) => {
    const result = await next(event);
    if (!event.route?.model.includes('mini')) return result;
    return {
      tools: result.tools.map(tool => tool.name.startsWith('mcp__') ? { ...tool, deferred: true }
        : tool.name === 'apply_patch' ? { ...tool, description: 'Edit files with a unified patch. Keep hunks small.' } : tool),
    };
  });
}
