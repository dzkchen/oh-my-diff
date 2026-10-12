import type { ModAPI, SessionRecord } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('recent_tools', () => {
    const [session] = api.host.call('sessions.list', { limit: 1 }).sessions;
    if (!session) return { display: 'No recorded sessions in this repository.' };
    const outputs = new Map<string, string>();
    const calls: { name: string; call_id: string }[] = [];
    let cursor: number | null = null;
    for (let page = 0; page === 0 || cursor !== null && page < 100; page++) {
      const read: { records: SessionRecord[]; cursor: number | null } = api.host.call('sessions.read', { session_id: session.session_id, revision: session.revision, handle: session.handle, ...cursor === null ? {} : { cursor } });
      for (const record of read.records) {
        if (record.kind === 'tool_result') outputs.set(record.call_id, record.output);
        if (record.kind === 'tool_call') calls.push(record);
      }
      cursor = read.cursor;
    }
    const lines = calls.slice(-20).map(call => `${call.name}: ${outputs.get(call.call_id)?.split('\n')[0] ?? 'no result'}`);
    return { display: lines.length ? lines.join('\n') : 'No tool calls in the latest session.' };
  }, { description: 'List the latest session\'s last 20 tool calls with the first line of each result' });
}
