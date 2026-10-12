import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('recent_tools', () => {
    const [session] = api.host.call('sessions.list', { limit: 1 }).sessions;
    if (!session) return { display: 'No recorded sessions in this repository.' };
    const { records } = api.host.call('sessions.read', { session_id: session.session_id, revision: session.revision, handle: session.handle });
    const outputs = new Map(records.flatMap(record => record.kind === 'tool_result' ? [[record.call_id, record.output]] : []));
    const lines = records.flatMap(record => record.kind === 'tool_call'
      ? [`${record.name}: ${outputs.get(record.call_id)?.split('\n')[0] ?? 'no result'}`] : []);
    return { display: lines.length ? lines.join('\n') : 'No tool calls in the latest session.' };
  }, { description: 'List the latest session\'s tool calls with the first line of each result' });
}
