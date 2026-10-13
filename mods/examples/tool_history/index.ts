import type { HostOperations, ModAPI } from '@oh-my-diff/mod-api';

const PAGES = 6;

export default function activate(api: ModAPI) {
  api.command('recent_tools', () => {
    const [session] = api.host.call('sessions.list', { limit: 1 }).sessions;
    if (!session) return { display: 'No recorded sessions in this repository.' };
    const outputs = new Map<string, string>();
    const calls: { name: string; call_id: string }[] = [];
    let cursor: number | null = null;
    let read = 0;
    let truncated = false;
    for (let page = 0; page < PAGES && (page === 0 || cursor !== null); page++) {
      const result: HostOperations['sessions.read']['result'] = api.host.call('sessions.read', { session_id: session.session_id, revision: session.revision, handle: session.handle, ...cursor === null ? {} : { cursor } });
      for (const record of result.records) {
        if (record.kind === 'tool_result') outputs.set(record.call_id, 'output' in record ? record.output.split('\n')[0] : `${record.bytes} bytes`);
        if (record.kind === 'tool_call') calls.push(record);
      }
      read += result.records.length;
      cursor = result.cursor;
      truncated ||= result.projection_truncated;
    }
    const lines = calls.slice(-20).map(call => `${call.name}: ${outputs.get(call.call_id) ?? 'no result'}`);
    if (!lines.length) lines.push('No tool calls in the latest session.');
    if (cursor !== null || truncated) lines.push(`(read the first ${read} records of a longer session)`);
    return { display: lines.join('\n') };
  }, { description: 'List the latest session\'s last 20 tool calls with the first line of each result', cli: 'tool-history' });
}
