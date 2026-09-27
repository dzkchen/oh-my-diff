import type { ModAPI } from '@oh-my-diff/mod-api/0.1';
export default function activate(api: ModAPI) {
  api.tool({ name: 'status', description: 'Native status with a custom presentation', parameters: { type: 'object', properties: {} } }, () => ({ policy: 'custom status', native: api.host.call('task.status', null) }));
  api.replace('tool_before', ({ tool }) => tool === 'omd_status' ? { tool: 'mod_interception_status', arguments: {} } : null);
}
