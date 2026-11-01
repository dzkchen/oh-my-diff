import type { HistoryItem, Json, ModAPI, ResourceRef } from '../../api.d.ts';

type Kept = { tool: string; reference: ResourceRef | null; bytes: number; failed: boolean };
type State = {
  masked: Record<string, string>; kept: string[]; pinned: string[]; calls: Record<string, Kept>;
  advances: number; hidden_bytes: number; saved_bytes: number; pending_bytes: number; last_saved_bytes: number;
};

const scope = 'thread';
const RECALL = 'mod_omd_observation_mask_recall';
const PAGE = 32_768;
const ADVANCE = 256;
const PINS = 256;
const CALLS = 400;
const LINE = 120;
const EDIT = /patch|edit|write|replace/i;
const HEADER = /^(Chunk ID:|Wall time:|Process exited with code|Exit code:|Original token count:|Output:)/;

const size = (value: Json | undefined, fallback: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
const isOutput = (item: HistoryItem): item is HistoryItem & { call_id: string } => item.type.endsWith('call_output') && typeof item.call_id === 'string';
const sum = (items: { bytes: number }[]) => items.reduce((total, item) => total + item.bytes, 0);
const tokens = (bytes: number) => Math.round(bytes / 4);

function stub(item: HistoryItem & { call_id: string }, kept: Kept | null) {
  const text = item.text ?? '';
  const exit = text.match(/(?:Process exited with code|Exit code:) (-?\d+)|"exit_code":\s*(-?\d+)/);
  const first = text.split('\n').map(line => line.trim()).find(line => line && !HEADER.test(line)) ?? '';
  const line = first.length > LINE ? `${first.slice(0, LINE)}…` : first;
  const facts = [`${item.bytes} bytes`, ...(exit ? [`exit ${exit[1] ?? exit[2]}`] : []), ...(line ? [`first line ${JSON.stringify(line)}`] : [])];
  const recovery = kept?.reference ? `Read it with ${RECALL} {"call_id":${JSON.stringify(item.call_id)}}.` : 'Its full text was not kept: run the call again if you need it.';
  return `[omd_observation_mask hid this older ${kept?.tool ?? 'tool'} output (${facts.join(', ')}). ${recovery}]`;
}

export default function activate(api: ModAPI) {
  const keepRecent = Math.max(1, size(api.settings.keep_recent, 10));
  const minBytes = size(api.settings.min_bytes, 1024);
  const batchBytes = size(api.settings.batch_bytes, 32_768);

  const load = (): State => ({
    masked: {}, kept: [], pinned: [], calls: {}, advances: 0, hidden_bytes: 0, saved_bytes: 0, pending_bytes: 0, last_saved_bytes: 0,
    ...(api.state.get() as Partial<State> | null ?? {}),
  });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const lookup = (callId: string) => load().calls[callId] ?? null;

  api.replace('history', event => {
    if (event.agent_id) return null;
    const state = load();
    const outputs = event.items.filter(isOutput);
    const recent = new Set(outputs.slice(-keepRecent).map(item => item.call_id));
    const pending = outputs.filter(item => item.editable && item.bytes >= minBytes && !recent.has(item.call_id)
      && !Object.hasOwn(state.masked, item.call_id) && !state.kept.includes(item.call_id) && !state.pinned.includes(item.call_id));
    let next = { ...state, pending_bytes: sum(pending) };
    if (pending.length && next.pending_bytes >= batchBytes) {
      const present = new Set(outputs.map(item => item.call_id));
      const masked = Object.fromEntries(Object.entries(state.masked).filter(([id]) => present.has(id)));
      const kept = state.kept.filter(id => present.has(id));
      let hidden = 0;
      for (const item of pending.slice(0, ADVANCE)) {
        const record = state.calls[item.call_id] ?? null;
        if (record?.failed && EDIT.test(record.tool)) {
          kept.push(item.call_id);
        } else {
          masked[item.call_id] = stub(item, record);
          hidden += item.bytes;
        }
      }
      next = { ...next, masked, kept, advances: state.advances + 1, hidden_bytes: state.hidden_bytes + hidden, pending_bytes: sum(pending.slice(ADVANCE)) };
    }
    const replace = outputs.filter(item => item.editable && Object.hasOwn(next.masked, item.call_id))
      .map(item => ({ index: item.index, text: next.masked[item.call_id], saved: item.bytes - next.masked[item.call_id].length }));
    const saved = replace.reduce((total, item) => total + Math.max(0, item.saved), 0);
    save({ ...next, saved_bytes: next.saved_bytes + saved, last_saved_bytes: saved });
    return replace.length ? { replace: replace.map(({ index, text }) => ({ index, text })) } : null;
  });

  api.intercept('tool', async (e, next) => {
    const result = await next(e);
    const bytes = result.bytes ?? new TextEncoder().encode(result.output).length;
    if (e.agent_id || next.origin.caller === 'code_mode' || bytes < minBytes) return result;
    const original = api.host.tryCall('tools.original', { call_id: e.call_id });
    const record: Kept = { tool: e.tool, reference: original.ok ? original.value.reference : null, bytes, failed: !result.success };
    const state = load();
    save({ ...state, calls: Object.fromEntries([...Object.entries(state.calls).filter(([id]) => id !== e.call_id), [e.call_id, record]].slice(-CALLS)) });
    return result;
  });

  api.intercept('model_request', async (e, next) => {
    const result = await next(e);
    if (e.scope.kind !== 'main' || !result.cache.from) return result;
    const got = api.host.tryCall('store.get', { key: 'breaks', scope });
    if (!got.ok) return result;
    const count = Number((got.value?.value as { count?: number } | undefined)?.count ?? 0) + 1;
    api.host.tryCall('store.put', { key: 'breaks', value: { count, last: result.cache.from }, expected_revision: got.value?.revision ?? null, scope });
    return result;
  });

  api.tool({
    name: 'recall',
    description: 'Read the full output of an older tool call that omd_observation_mask hid, by its call_id, in pages of 32 KiB (pass next_cursor as cursor for the next page). pin: true instead puts the output back in place from the next request and never hides it again; use it only for an output you will keep needing.',
    parameters: {
      type: 'object',
      properties: { call_id: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, pin: { type: 'boolean' } },
      required: ['call_id'], additionalProperties: false,
    },
  }, (input): Json => {
    const { call_id: callId, cursor, pin } = input as { call_id: string; cursor?: number; pin?: boolean };
    if (pin) {
      const state = load();
      const { [callId]: _, ...masked } = state.masked;
      save({ ...state, masked, pinned: [...state.pinned.filter(id => id !== callId), callId].slice(-PINS) });
      return { call_id: callId, pinned: true };
    }
    const record = lookup(callId);
    if (!record?.reference) throw new Error(`recall_unavailable: no kept output for ${callId}; only outputs of at least ${minBytes} bytes from this thread's own calls are kept`);
    const page = api.host.call('evidence.read', { reference: record.reference, cursor, max_bytes: PAGE });
    return { call_id: callId, tool: record.tool, bytes: record.bytes, text: page.text, next_cursor: page.cursor };
  });

  api.command('mask', () => {
    const state = load();
    const breaks = api.host.tryCall('store.get', { key: 'breaks', scope });
    const other = breaks.ok && breaks.value ? breaks.value.value as { count: number; last: string } : null;
    return {
      display: [
        `Observation masking: keeps the newest ${keepRecent} tool outputs and outputs under ${minBytes} bytes; hides older ones in batches of at least ${batchBytes} bytes`,
        `${Object.keys(state.masked).length} outputs hidden in ${state.advances} batches (each batch breaks the prompt cache once) · about ${tokens(state.hidden_bytes)} tokens hidden`,
        `about ${tokens(state.saved_bytes)} tokens not resent in total, ${tokens(state.last_saved_bytes)} in the last request · ${tokens(state.pending_bytes)} tokens waiting for the next batch`,
        `${state.kept.length} failed edits kept · ${state.pinned.length} pinned · ${other ? `${other.count} prompt-prefix changes from other sources, last at ${other.last}` : 'no prompt-prefix changes from other sources'}`,
      ].join('\n'),
    };
  }, { description: 'Show hidden tool outputs and prompt-cache breaks in this thread' });
}
