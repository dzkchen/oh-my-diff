import type { Json, ModAPI, TerminalComponent, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Row = { id: string; label: string; detail: string };
type Provenance = { workspace_snapshot: false; validation: 'double_list_and_hash' };
type SearchResult = { schema: 1; generator: string; repository_identity: string; revision: string; source_digest: string; rows: Row[]; count: number; page: number; page_size: number; provenance: Provenance };
type SelectionPacket = { schema: 1; graph_generator: string; repository_identity: string; revision: string; source_digest: string; nodes: { id: string }[]; relationships: unknown[]; coverage: unknown[]; guidance: string; provenance: Provenance };
type Saved = { open: boolean; query: string; page: number; pageSize: number; rows: Row[]; count: number; identity: string; revision: string; digest: string; viewRevision: number; error: string | null };
const EMPTY: Saved = { open: false, query: '', page: 0, pageSize: 32, rows: [], count: 0, identity: '', revision: '', digest: '', viewRevision: 0, error: null };
const SHA = /^[0-9a-f]{64}$/;
const GENERATOR = 'omd-repository-analysis-five-language-v3';
const NODE_ID_LIMIT = 768;
const INSERT_BYTES_LIMIT = 16_384;
const utf8Bytes = (value: string) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length;

export default function activate(api: ModAPI) {
  const saved = (): Saved => {
    const value = api.state.get() as Partial<Saved> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY };
    return {
      open: value.open === true,
      query: typeof value.query === 'string' ? value.query.slice(0, 100) : '',
      page: Number.isSafeInteger(value.page) && Number(value.page) >= 0 && Number(value.page) <= 1000 ? Number(value.page) : 0,
      pageSize: Number.isSafeInteger(value.pageSize) && Number(value.pageSize) >= 1 && Number(value.pageSize) <= 100 ? Number(value.pageSize) : 32,
      rows: Array.isArray(value.rows) ? value.rows.slice(0, 100).filter(row => row && typeof row.id === 'string' && row.id.length <= NODE_ID_LIMIT && typeof row.label === 'string' && typeof row.detail === 'string')
        .map(row => ({ id: row.id, label: bounded(row.label, 256, 96), detail: bounded(row.detail, 256, 180) })) : [],
      count: Number.isSafeInteger(value.count) && Number(value.count) >= 0 && Number(value.count) <= 20_000 ? Number(value.count) : 0,
      identity: typeof value.identity === 'string' ? value.identity.slice(0, 120) : '',
      revision: typeof value.revision === 'string' ? value.revision.slice(0, 120) : '',
      digest: typeof value.digest === 'string' && SHA.test(value.digest) ? value.digest : '',
      viewRevision: Number.isSafeInteger(value.viewRevision) && Number(value.viewRevision) >= 0 ? Number(value.viewRevision) : 0,
      error: typeof value.error === 'string' ? value.error.slice(0, 240) : null,
    };
  };
  const save = (state: Saved) => api.state.set(state);
  const visible = (value: string, limit = 120) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, limit);
  const bounded = (value: string, maxBytes: number, maxChars: number): string => {
    let output = '';
    let count = 0;
    for (const character of value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')) {
      if (count >= maxChars || utf8Bytes(output + character) > maxBytes) break;
      output += character;
      count++;
    }
    return output;
  };
  const rowToken = (state: Saved, index: number) => `graph-row:${state.digest}:${state.viewRevision}:${state.page}:${index}`;
  const root = typeof api.settings.root === 'string' ? api.settings.root : '';
  const validRoot = root.length <= 240 && !root.startsWith('/') && !root.includes('\\') && (root === '' || root.split('/').every(part => part.length > 0 && part !== '..' && part !== '.' && part !== '.git'));
  const provenance = (value: unknown): value is Provenance => !!value && typeof value === 'object' && (value as Provenance).workspace_snapshot === false && (value as Provenance).validation === 'double_list_and_hash';
  const fail = (state: Saved, error: string): Saved => { const next = { ...state, rows: [], count: 0, digest: '', error: visible(error, 240) }; save(next); return next; };
  const load = (state: Saved, expected?: string): Saved => {
    if (!validRoot) return fail(state, 'graph root is unsafe');
    const result = api.services.call('omd.repository_analysis', 'search', { query: state.query, page: state.page, root, ...(expected ? { expected_source_digest: expected } : {}) }) as unknown as SearchResult;
    if (!result || result.schema !== 1 || result.generator !== GENERATOR || !SHA.test(result.source_digest) || !provenance(result.provenance)
      || typeof result.repository_identity !== 'string' || result.repository_identity.length > 120 || typeof result.revision !== 'string' || result.revision.length > 120
      || !Number.isSafeInteger(result.count) || result.count < 0 || result.count > 20_000 || !Number.isSafeInteger(result.page) || result.page < 0
      || !Number.isSafeInteger(result.page_size) || result.page_size < 1 || result.page_size > 100 || !Array.isArray(result.rows) || result.rows.length > result.page_size
      || result.rows.some(row => !row || typeof row.id !== 'string' || row.id.length > NODE_ID_LIMIT || typeof row.label !== 'string' || typeof row.detail !== 'string' || row.detail.length > 512)) return fail(state, 'graph service response is invalid');
    if (!Number.isSafeInteger(state.viewRevision + 1)) return fail(state, 'graph view revision exhausted');
    const next = { ...state, page: result.page, pageSize: result.page_size, rows: result.rows.map(row => ({ id: row.id, label: bounded(row.label, 256, 96), detail: bounded(row.detail, 256, 180) })),
      viewRevision: state.viewRevision + 1,
      count: result.count, identity: visible(result.repository_identity), revision: visible(result.revision), digest: result.source_digest, error: null };
    save(next);
    return next;
  };
  const line = (id: string, label: string, text: string, tone: TerminalTone = 'normal'): TerminalComponent => ({ type: 'text', id, label, text, tone });
  const view = (): TerminalPatch | null => {
    const state = saved();
    if (!state.open) return null;
    const children: TerminalComponent[] = [
      line('omd_graph_repository', 'Repository', state.error ?? `${state.identity} · ${state.revision}`, state.error ? 'failure' : 'accent'),
      ...(state.error ? [] : [line('omd_graph_counts', 'Graph', `${state.count} matches · source ${state.digest.slice(0, 12)} · live source revalidated on selection`)]),
      { type: 'input', id: 'omd_graph_query', label: 'Search graph', value: state.query, placeholder: 'symbol, module, test, path', action: { command: 'omd_graph_navigator:graph', args: 'search' } },
      ...(state.rows.length ? [{ type: 'list' as const, id: 'omd_graph_nodes', label: 'Graph nodes', rows: state.rows.map((row, index) => ({ value: rowToken(state, index), label: row.label, spans: [{ text: bounded(`${row.label}  ${row.detail}`, 256, 256) }] })), selected: rowToken(state, 0), height: 12, action: { command: 'omd_graph_navigator:graph', args: 'select' } }] : [line('omd_graph_empty', 'Nodes', state.error ? 'Graph unavailable' : 'No matching nodes', 'muted')]),
      ...(state.page > 0 ? [{ type: 'button' as const, id: 'omd_graph_previous', label: 'Previous graph page', text: 'Previous', action: { command: 'omd_graph_navigator:graph', args: 'previous' } }] : []),
      ...((state.page + 1) * state.pageSize < state.count ? [{ type: 'button' as const, id: 'omd_graph_next', label: 'Next graph page', text: 'Next', action: { command: 'omd_graph_navigator:graph', args: 'next' } }] : []),
      { type: 'button', id: 'omd_graph_refresh', label: 'Refresh live source graph', text: 'Refresh', action: { command: 'omd_graph_navigator:graph', args: 'refresh' } },
      { type: 'button', id: 'omd_graph_close', label: 'Close graph navigator', text: 'Close', action: { command: 'omd_graph_navigator:graph', args: 'close' } },
    ];
    return { sites: { dialog: { mode: 'replace', components: [{ type: 'dialog', id: 'omd_graph_dialog', label: 'Oh My Diff code graph', title: 'Oh My Diff code/impact graph', children }] } } };
  };
  const select = (state: Saved, token: string) => {
    const node = state.rows.find((_, index) => rowToken(state, index) === token);
    if (!state.open || !node || !SHA.test(state.digest) || !validRoot) return 'select a visible graph node first';
    const packet = api.services.call('omd.repository_analysis', 'select', { node_id: node.id, expected_source_digest: state.digest, root }) as unknown as SelectionPacket;
    if (!packet || packet.schema !== 1 || packet.graph_generator !== GENERATOR || packet.repository_identity !== state.identity || packet.revision !== state.revision
      || packet.source_digest !== state.digest || !provenance(packet.provenance) || !Array.isArray(packet.nodes) || !packet.nodes.some(item => item && item.id === node.id)
      || !Array.isArray(packet.relationships) || !Array.isArray(packet.coverage) || typeof packet.guidance !== 'string') return 'graph selection does not match the preview';
    const content = JSON.stringify(packet);
    if (content.length > 32 * 1024) return 'graph selection exceeds the bounded evidence limit';
    const insert = `Use this live source code-graph evidence. Verify inferred and unknown relationships against source before relying on them.\n\`\`\`json\n${content}\n\`\`\`\n`;
    if (utf8Bytes(insert) > INSERT_BYTES_LIMIT) return 'graph selection exceeds the composer insertion limit';
    const written = api.host.tryCall('composer.write', { insert });
    if (!written.ok) return written.error;
    save({ ...state, open: false });
    return null;
  };
  // Slash commands can't call services, so the command hops to this mod's own native channel handler.
  api.command('graph', value => {
    const [op = '', ...rest] = String(value ?? '').trim().split(' ');
    const argument = rest.join(' ');
    if (op === 'close') {
      save({ ...saved(), open: false });
      return null;
    }
    if (!['', 'open', 'refresh', 'search', 'next', 'previous', 'select'].includes(op)) return { display: 'usage: /omd_graph_navigator:graph [search QUERY | next | previous | refresh | close]' };
    save({ ...saved(), open: true });
    const asked = api.host.tryCall('events.publish', { channel: 'request', data: { op, argument: argument.slice(0, NODE_ID_LIMIT) } });
    return asked.ok ? null : { display: asked.error };
  }, { description: 'Open, search and page the live source code graph; selecting a node inserts its evidence' });
  api.on('channel', ({ channel, data }) => {
    const request = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    if (channel !== 'omd_graph_navigator/request' || !request) return;
    const state = { ...saved(), open: true };
    const op = String(request.op ?? '');
    const argument = typeof request.argument === 'string' ? request.argument : '';
    try {
      if (op === 'select') {
        const refused = select(state, argument);
        if (refused) save({ ...state, error: visible(refused, 240) });
      } else if (op === 'search') load({ ...state, query: argument.slice(0, 100), page: 0 }, state.digest || undefined);
      else if (op === 'next' || op === 'previous') load({ ...state, page: Math.max(0, state.page + (op === 'next' ? 1 : -1)) }, state.digest || undefined);
      else load({ ...state, page: op === 'refresh' ? state.page : 0 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      fail(state, error.message);
    }
  });
  api.on('terminal', () => view());
}
