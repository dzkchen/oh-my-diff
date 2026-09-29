import type { ModAPI, Json } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.tool({ name: 'reads', description: 'Read several files at once', parameters: { type: 'object', properties: { calls: { type: 'object' } } } }, input => {
    const calls = (input as { calls: Record<string, string> }).calls;
    const files = api.host.call('workspace.read', { paths: Object.values(calls) }).files;
    const out: Record<string, Json> = {};
    for (const [callId, path] of Object.entries(calls)) out[callId] = files[path]?.text ?? `missing: ${path}`;
    return out;
  });
  api.replace('tool_batch', batch => {
    const reads = batch.calls.filter(call => call.tool === 'read_file');
    if (reads.length < 2) return null;
    const calls: Record<string, string> = {};
    for (const call of reads) calls[call.call_id] = String((call.arguments as { path?: string }).path);
    return { merge: [{ call_ids: reads.map(call => call.call_id), tool: 'reads', arguments: { calls } }] };
  });
}
