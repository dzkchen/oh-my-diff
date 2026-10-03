import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.tool({ name: 'status', description: 'Native status with a custom presentation', parameters: { type: 'object', properties: {} } }, () => ({ policy: 'custom status', native: api.host.call('task.status', null) }));
  api.intercept('tool', { match: { tool: 'omd_status' } }, (e, next) => next({ ...e, tool: 'mod_interception_status', arguments: {} }));
}
