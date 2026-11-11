import type { HistoryItem, Json, ModAPI, ResourceRef } from '../../api.d.ts';
import { cacheLifetime } from './cache_ttl.ts';

type Kept = { tool: string; reference: ResourceRef | null; bytes: number; failed_edit: boolean };
type Cache = { identity: string; provider: string; model: string; route: string; ttl: number; reported: boolean; expires: number };
type State = {
  cache: Cache | null; continuation: { prompt: string; force: boolean; readable: string[] } | null;
  masked: Record<string, string>; kept: string[]; pinned: string[]; calls: Record<string, Kept>; visible: string[];
  advances: number; continues: number; hidden_bytes: number; pending_bytes: number; last_saved_bytes: number;
};

const scope = 'thread';
const RECALL = 'mod_omd_observation_mask_recall';
const PAGE = 32_768;
const ADVANCE = 256;
const PINS = 256;
const CALLS = 400;
const MASKED = 400;
const LINE = 120;
const KEPT_OUTPUTS = 1024;
const HEADER = /^(Chunk ID:|Wall time:|Process exited with code|Exit code:|Original token count:|Output:)/;

const EDIT_TOOL = /^apply_patch$|(^|_)(edit|write|create|replace)(_file|_editor)?$/;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const REDIRECT = /(?<![\d=<>&-])>>?\s*(?!&)([^\s;&|<>()]+)/g;
const WRITER = /(?:^|\s)(tee|cp|mv|sed|perl)\s+(.*)$/s;
const IN_PLACE = /(?:^|\s)-[a-zA-Z]*i[\w.]*(?=\s|$)/;
const UNSEEN_WRITE = /\.write\(|write_text\(|writeFile/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)[\s\S]*?^\s*\2$/gm;
const SHELL = /^(exec_command|shell|shell_command|local_shell)$/;
const command = (tool: string, args: Json) => {
  const value = typeof args === 'string' ? (SHELL.test(tool) ? args : null) : args && typeof args === 'object' && !Array.isArray(args) ? args.cmd ?? args.command : null;
  return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(item => typeof item === 'string').join(' ') : '';
};
function writes(cmd: string): { created: string[]; changed: string[]; unnamed: boolean; unseen: boolean } {
  const plain = cmd.replace(HEREDOC, '<<$2$3').replace(QUOTED, "''");
  const created = [...plain.matchAll(REDIRECT)].map(match => match[1]).filter(path => path !== '/dev/null');
  const changed: string[] = [];
  let unnamed = false;
  for (const part of plain.split(/&&|\|\||[;|\n]/)) {
    const [, tool, rest = ''] = WRITER.exec(part.trim()) ?? [];
    const words = rest.split(/\s+/).filter(word => word && !word.startsWith('-'));
    const files = (tool === 'sed' && !/(?:^|\s)-[ef]\b/.test(rest) ? words.slice(1) : words).filter(word => word !== "''");
    if (tool === 'tee') created.push(...words);
    else if ((tool === 'cp' || tool === 'mv') && words.length > 1) changed.push(words[words.length - 1]);
    else if ((tool === 'sed' || tool === 'perl') && IN_PLACE.test(rest)) { changed.push(...files); unnamed ||= !files.length; }
  }
  const named = (paths: string[]) => paths.filter(path => /^[\w./-]+$/.test(path));
  unnamed ||= named(created).length < created.length || named(changed).length < changed.length;
  return { created: named(created), changed: named(changed), unnamed, unseen: UNSEEN_WRITE.test(cmd) };
}
const size = (value: Json | undefined, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
const isOutput = (item: HistoryItem): item is HistoryItem & { call_id: string } => item.type.endsWith('call_output') && typeof item.call_id === 'string';
const sum = (items: { bytes: number }[]) => items.reduce((total, item) => total + item.bytes, 0);
const tokens = (bytes: number) => Math.round(bytes / 4);

function stub(item: HistoryItem & { call_id: string }, kept: Kept) {
  const text = item.text ?? '';
  const exit = text.match(/(?:Process exited with code|Exit code:) (-?\d+)|"exit_code":\s*(-?\d+)/);
  const first = text.split('\n').map(line => line.trim()).find(line => line && !HEADER.test(line)) ?? '';
  const line = first.length > LINE ? `${first.slice(0, LINE)}…` : first;
  const facts = [`${item.bytes} bytes`, ...(exit ? [`exit ${exit[1] ?? exit[2]}`] : []), ...(line ? [`first line ${JSON.stringify(line)}`] : [])];
  return `[omd_observation_mask hid this older ${kept.tool} output (${facts.join(', ')}). Read it with ${RECALL} {"call_id":${JSON.stringify(item.call_id)}}.]`;
}

export default function activate(api: ModAPI) {
  const keepRecent = Math.max(1, size(api.settings.keep_recent, 10));
  const minBytes = size(api.settings.min_bytes, 1024);
  const batchBytes = size(api.settings.batch_bytes, 32_768);
  const continuationOnly = api.settings.mode === 'continue';
  const minutes = Number(api.settings.cache_ttl_minutes) || 0;

  const load = (): State => ({
    cache: null, continuation: null, masked: {}, kept: [], pinned: [], calls: {}, visible: [], advances: 0, continues: 0, hidden_bytes: 0, pending_bytes: 0, last_saved_bytes: 0,
    ...(api.state.get() as Partial<State> | null ?? {}),
  });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const lookup = (callId: string) => load().calls[callId] ?? null;

  const cold = (state: State) => {
    const cache = state.cache;
    const session = api.session();
    return cache !== null && cache.ttl > 0 && cache.expires <= Date.now()
      && cache.provider === session.provider && cache.model === session.model
      && (session.route ?? 'session') === cache.route;
  };

  if (continuationOnly) {
    api.on('model_response', response => {
      if (response.scope.kind !== 'main' || response.scope.agent_id || response.synthetic
        || !['completed', 'incomplete'].includes(response.status)) return;
      const state = load();
      const at = response.timing.started_at_ms;
      const memo = cacheLifetime(response, minutes, at, state.cache);
      if (state.cache && at < state.cache.expires - state.cache.ttl) return;
      save({ ...state, cache: { ...memo, provider: response.provider, model: response.requested_model, route: response.route,
        ttl: Number.isFinite(at) && at > 0 && at <= Date.now() ? memo.ttl : 0 } });
    });
    api.intercept('command', async (event, next) => {
      if (event.command !== 'continue' || event.owner !== 'omd_continue' || event.active_turn) return next(event);
      if (!load().continues) save({ ...load(), continues: 1 });
      const force = /^--compact(?:\s|$)/.test(event.args.trim());
      const result = await next(force ? { ...event, args: event.args.trim().replace(/^--compact(?:\s+|$)/, '') } : event);
      const value = result.result;
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.submit !== 'string') return result;
      const state = load();
      if (!force && !cold(state)) return result;
      const calls = { ...state.calls };
      const readable: string[] = [];
      const candidates = state.visible.map(id => [id, calls[id]] as const).filter(([id, record]) => record?.reference && !record.failed_edit
        && !Object.hasOwn(state.masked, id) && !state.kept.includes(id) && !state.pinned.includes(id)).slice(0, 16);
      for (const [id, record] of candidates) {
        if (record.reference && api.host.tryCall('evidence.read', { reference: record.reference, max_bytes: 4 }).ok) readable.push(id);
        else calls[id] = { ...record, reference: null };
      }
      const submit = `${value.submit}\n\nOlder tool outputs may be omitted from this continuation. Use their recall references only for a specific missing fact and read the smallest relevant page. Historical output describes past state: verify files and processes before repeating actions. Do not rerun a command just to recover its output, especially if it has side effects.`;
      save({ ...state, calls, continuation: { prompt: submit.slice(0, 512), force, readable } });
      return { result: { ...value, submit } };
    });
    api.on('resume', () => save({ ...load(), continuation: null }));
    api.on('compaction_end', event => {
      if (event.outcome === 'compacted' || event.outcome === 'replaced') save({ ...load(), cache: null, continuation: null });
    });
  }

  api.replace('history', event => {
    if (event.agent_id) return null;
    const state = load();
    const outputs = event.items.filter(isOutput);
    const request = state.continuation;
    const advance = !continuationOnly || Boolean(request && event.items.at(-1)?.text?.startsWith(request.prompt)
      && (request.force || Boolean(state.cache && event.model === state.cache.model && state.cache.expires <= Date.now())));
    const recent = new Set(outputs.slice(-keepRecent).map(item => item.call_id));
    const pending = outputs.filter(item => item.editable && item.bytes >= minBytes && !recent.has(item.call_id)
      && Boolean(state.calls[item.call_id]?.reference)
      && !Object.hasOwn(state.masked, item.call_id) && !state.kept.includes(item.call_id) && !state.pinned.includes(item.call_id));
    const visible = continuationOnly ? outputs.filter(item => state.calls[item.call_id]).map(item => item.call_id) : state.visible;
    let next = { ...state, visible, continuation: null, pending_bytes: sum(pending) };
    if (advance && pending.length && next.pending_bytes >= batchBytes) {
      const present = new Set(outputs.map(item => item.call_id));
      const masked = Object.fromEntries(Object.entries(state.masked).filter(([id]) => present.has(id)));
      const kept = state.kept.filter(id => present.has(id));
      const batch = pending.filter(item => !continuationOnly || state.calls[item.call_id]?.failed_edit || request?.readable.includes(item.call_id))
        .slice(0, Math.max(0, Math.min(continuationOnly ? 16 : ADVANCE, MASKED - Object.keys(masked).length)));
      let hidden = 0;
      for (const item of batch) {
        const record = state.calls[item.call_id];
        if (record.failed_edit) {
          kept.push(item.call_id);
        } else {
          masked[item.call_id] = stub(item, record);
          hidden += item.bytes;
        }
      }
      if (batch.length) next = { ...next, masked, kept, advances: state.advances + 1, hidden_bytes: state.hidden_bytes + hidden, pending_bytes: sum(pending.filter(item => !Object.hasOwn(masked, item.call_id) && !kept.includes(item.call_id)
        && Boolean(next.calls[item.call_id]?.reference))) };
    }
    const replace = outputs.filter(item => item.editable && Object.hasOwn(next.masked, item.call_id))
      .map(item => ({ index: item.index, text: next.masked[item.call_id], saved: item.bytes - next.masked[item.call_id].length }));
    const saved = replace.reduce((total, item) => total + Math.max(0, item.saved), 0);
    if (state.continuation || JSON.stringify(visible) !== JSON.stringify(state.visible) || next.advances !== state.advances || next.pending_bytes !== state.pending_bytes || saved !== state.last_saved_bytes) save({ ...next, last_saved_bytes: saved });
    return replace.length ? { replace: replace.map(({ index, text }) => ({ index, text })) } : null;
  });

  api.intercept('tool', async (e, next) => {
    const result = await next(e);
    const bytes = result.bytes ?? new TextEncoder().encode(result.output).length;
    if (e.agent_id || next.origin.caller === 'code_mode' || bytes < minBytes) return result;
    const original = api.host.tryCall('tools.original', { call_id: e.call_id });
    const found = writes(command(e.tool, e.arguments));
    const edit = EDIT_TOOL.test(e.tool) || found.changed.length > 0;
    const record: Kept = { tool: e.tool, reference: original.ok ? original.value.reference : null, bytes, failed_edit: !result.success && edit };
    const state = load();
    const others = Object.entries(state.calls).filter(([id]) => id !== e.call_id);
    const recent = new Set(others.filter(([id]) => !Object.hasOwn(state.masked, id)).slice(1 - CALLS).map(([id]) => id));
    save({ ...state, calls: Object.fromEntries([...others.filter(([id]) => recent.has(id) || Object.hasOwn(state.masked, id)), [e.call_id, record]]) });
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
    const page = api.host.tryCall('evidence.read', { reference: record.reference, cursor, max_bytes: PAGE });
    if (!page.ok) throw new Error(`recall_unavailable: the saved text of ${callId} is gone (${page.error}); the host keeps only the newest ${KEPT_OUTPUTS} outputs per repository. Verify current state instead of rerunning a command that has side effects`);
    return { call_id: callId, tool: record.tool, bytes: record.bytes, text: page.value.text, next_cursor: page.value.cursor };
  });

  api.command('hidden_outputs', () => {
    const state = load();
    const breaks = api.host.tryCall('store.get', { key: 'breaks', scope });
    const other = breaks.ok && breaks.value ? breaks.value.value as { count: number; last: string } : null;
    const idle = !continuationOnly ? null
      : !state.continues ? 'Continue mode hides nothing until /continue (from the omd_continue mod, which OMD+ does not enable by default) has run in this thread: enable omd_continue in /mods'
      : state.cache?.ttl === 0 ? 'Continue mode has no cache lifetime estimate for this provider (ChatGPT subscriptions, unpriced responses and local providers get none), so only /continue --compact hides outputs; set cache_ttl_minutes to estimate one'
      : null;
    return {
      display: [
        `Mode: ${continuationOnly ? 'only on /continue after estimated cache expiry, or /continue --compact' : 'automatic batches'}`,
        ...idle ? [idle] : [],
        `Observation masking: keeps the newest ${keepRecent} tool outputs and outputs under ${minBytes} bytes; hides older ones in batches of at least ${batchBytes} bytes`,
        `${Object.keys(state.masked).length} outputs hidden in ${state.advances} batches (each batch breaks the prompt cache once) · about ${tokens(state.hidden_bytes)} tokens hidden`,
        `about ${tokens(state.last_saved_bytes)} tokens not resent with each request · ${tokens(state.pending_bytes)} tokens waiting for the next batch`,
        `${state.kept.length} failed edits kept · ${state.pinned.length} pinned · ${other ? `${other.count} prompt-prefix changes from other sources, last at ${other.last}` : 'no prompt-prefix changes from other sources'}`,
      ].join('\n'),
    };
  }, { description: 'Show hidden tool outputs and prompt-cache breaks in this thread' });
}
