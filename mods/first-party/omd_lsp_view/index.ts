import type { Json, ModAPI, TerminalComponent } from '../../api.d.ts';

type Item = { label: string; value: string };
type View = { title: string; status: 'working' | 'ready' | 'error'; message: string; items: Item[]; action: 'open' | 'apply'; text: string | null;
  excerpt: { path: string; line: number; start: number; lines: string[]; errors?: Item[] } | null; pane: boolean; revision: number };
type Server = { adapter: string; server: string | null; status: string; reason: string; documents: number; count?: number; errors: string[] };
type Saved = { view: View | null; servers: Server[] };

const object = (value: Json | undefined): Record<string, Json> | null => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const target = (value: string) => {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value.trim());
  return { path: match?.[1] ?? '', line: Number(match?.[2] ?? 1), character: Number(match?.[3] ?? 1) };
};

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ view: null, servers: [], ...api.state.get() as unknown as Saved | null });
  const view = () => saved().view;
  const show = (patch: Partial<View> | null) => {
    const { view: current, servers } = saved();
    api.state.set({ servers, view: patch === null ? null : { title: 'Code intelligence', status: 'ready', message: '', items: [], action: 'open', text: null, excerpt: null, pane: false,
      ...current, ...patch, revision: (current?.revision ?? 0) + 1 } } as unknown as Json);
  };
  const USAGE = 'usage: /lsp hover|definition|references|actions PATH:LINE[:COL] | symbols|diagnostics|format PATH | diagnostics | workspace QUERY | pane | close';
  api.command('lsp', value => {
    const text = String(value ?? '').trim();
    const [op = '', ...rest] = text.split(' ');
    const argument = rest.join(' ');
    if (op === 'close') {
      show(null);
      return null;
    }
    if (op === 'pane' || op === 'back') {
      show(op === 'pane' ? { pane: !view()?.pane } : { excerpt: null });
      return null;
    }
    if (op === 'open' || op === 'editor') {
      const { path, line } = target(argument);
      if (!path || /^\/|(^|\/)\.\.?(\/|$)/.test(path)) return { display: USAGE };
      if (op === 'editor') {
        const root = api.host.tryCall('exec.run', { program: 'pwd', timeout_ms: 5_000 });
        const opened = root.ok ? api.host.tryCall('terminal.open', { path: `${root.value.stdout.trim()}/${path}`, line, editor: true }) : root;
        return opened.ok ? null : { display: opened.error };
      }
      const start = Math.max(1, line - 12);
      const read = api.host.tryCall('exec.run', { program: 'awk', argv: ['-v', `s=${start}`, '-v', `e=${line + 12}`, 'NR>=s && NR<=e { print substr($0, 1, 400) }', `./${path}`], timeout_ms: 5_000 });
      if (!read.ok || read.value.exit_code !== 0) return { display: `Cannot read ${path}` };
      show({ excerpt: { path, line, start, lines: read.value.stdout.split('\n').slice(0, -1), errors: [] }, status: 'working', message: '' });
      const asked = api.host.tryCall('events.publish', { channel: 'request', data: { op: 'diagnostics', path } });
      if (!asked.ok) show({ status: 'error', message: asked.error });
      return null;
    }
    const [index, applyPath] = op === 'apply' ? [Number(argument.split(':')[0]), argument.slice(argument.indexOf(':') + 1)] : [0, ''];
    const request: Record<string, Json> = op === 'workspace' ? { op, query: argument } : op === 'apply' ? { op, index, path: applyPath } : { op, ...target(argument) };
    if (!['hover', 'definition', 'references', 'symbols', 'workspace', 'diagnostics', 'actions', 'format', 'apply'].includes(op) || (op !== 'workspace' && op !== 'diagnostics' && !request.path)) return { display: USAGE };
    show({ title: op === 'apply' ? 'Apply code action' : `${op} ${argument}`.trim(), status: 'working', message: 'Asking the language server…', items: [], text: null, excerpt: null, action: 'open' });
    const published = api.host.tryCall('events.publish', { channel: 'request', data: request });
    if (!published.ok) show({ status: 'error', message: published.error });
    return null;
  }, { description: 'Code intelligence from omd_lsp_sync language servers: hover, definition, references, symbols, diagnostics, code actions and formatting' });
  api.on('channel', event => {
    if (event.publisher === 'omd_lsp_sync') {
      api.state.set({ ...saved(), servers: Array.isArray(event.data) ? event.data.slice(0, 4) : [] } as unknown as Json);
      return;
    }
    const data = object(event.data);
    if (!event.channel.endsWith('/request') || !data) return;
    try {
      const result = api.services.call('omd.lsp', 'query', data) as unknown as Partial<View>;
      const excerpt = view()?.excerpt;
      // A diagnostics answer for an open excerpt fills its error list and keeps the earlier results for Back.
      show(data.op === 'diagnostics' && excerpt && data.path === excerpt.path ? { status: result.status, message: result.message, excerpt: { ...excerpt, errors: (result.items ?? []).filter(item => item.value.startsWith(`${excerpt.path}:`)) } } : result);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      show({ status: 'error', message: /service_provider_missing/.test(error.message) ? 'enable omd_lsp_sync, which runs the language servers' : error.message });
    }
  });
  api.on('terminal', () => {
    const { view: current, servers } = saved();
    const sidebar = servers.length ? { sidebar: { mode: 'wrap' as const, components: [{ type: 'pane' as const, id: 'omd_lsp_view_servers', label: 'Language servers', title: 'Language servers', children: servers.flatMap((entry, index): TerminalComponent[] => [
      { type: 'text', id: `omd_lsp_view_server_${index}`, label: `${entry.adapter} language server`, text: entry.server ? `${entry.adapter} ${entry.server} · ${entry.documents} open · ${entry.count ?? entry.errors.length} errors` : `${entry.adapter}: ${entry.reason.replace(/_/g, ' ') || entry.status}`,
        tone: entry.errors.length ? 'failure' : entry.status === 'stale' ? 'attention' : entry.server ? 'success' : 'muted' },
      ...entry.errors.map((error, line): TerminalComponent => ({ type: 'text', id: `omd_lsp_view_server_${index}_${line}`, label: 'Diagnostic', text: `  ${error}`, tone: 'failure' })),
    ]) }, { type: 'slot' as const }] } } : {};
    if (!current) return servers.length ? { sites: sidebar } : null;
    const id = (name: string) => `omd_lsp_view_${name}_${current.revision}`;
    const excerpt = current.excerpt;
    const own = excerpt?.errors ?? [];
    const where = excerpt && `${excerpt.path}:${excerpt.line} · ${current.status === 'working' ? 'checking diagnostics' : current.status === 'error' ? current.message : `${own.length} errors`}`;
    const components: TerminalComponent[] = [
      { type: 'text', id: id('status'), label: 'Status', text: where || current.message || `${current.items.length} results`, tone: current.status === 'error' ? 'failure' : current.status === 'working' ? 'muted' : 'normal' },
      ...(excerpt ? [
        { type: 'document' as const, id: id('excerpt'), label: excerpt.path, lines: excerpt.lines.map((text, index) => [{ text: `${String(excerpt.start + index).padStart(5)} `, tone: 'muted' as const }, { text }]), selected: { start: excerpt.line - excerpt.start, end: excerpt.line - excerpt.start } },
        { type: 'button' as const, id: id('pane_open'), label: 'Open in the viewer pane', text: 'Open in pane', action: { command: 'omd_panes:open', args: `${excerpt.path}:${excerpt.line}` } },
        { type: 'button' as const, id: id('editor'), label: 'Open in your editor', text: 'Open in editor', action: { command: 'omd_lsp_view:lsp', args: `editor ${excerpt.path}:${excerpt.line}` } },
        { type: 'button' as const, id: id('edit'), label: 'Edit in an omd_editor buffer', text: 'Edit here', action: { command: 'omd_editor:edit', args: `${excerpt.path}:${excerpt.line}` } },
        { type: 'button' as const, id: id('back'), label: 'Back to the results', text: 'Back', action: { command: 'omd_lsp_view:lsp', args: 'back' } },
        ...(own.length ? [{ type: 'list' as const, id: id('errors'), label: 'Errors in this file, Enter jumps', height: 6, rows: own.map(item => ({ value: item.value, label: item.label, spans: [{ text: item.label, tone: 'failure' as const }] })), action: { command: 'omd_lsp_view:lsp', args: 'open' } }] : []),
      ] : [
        ...(current.text ? [{ type: 'pane' as const, id: id('text'), label: 'Details, scroll with arrows', children: [{ type: 'markdown' as const, id: id('markdown'), label: 'Details', text: current.text }] }] : []),
        ...(current.items.length ? [{ type: 'list' as const, id: id('items'), label: current.action === 'apply' ? 'Code actions, Enter applies' : 'Results, Enter jumps', height: 12,
          rows: current.items.map(item => ({ value: item.value, label: item.label, spans: [{ text: item.label }] })), action: { command: 'omd_lsp_view:lsp', args: current.action } }] : []),
      ]),
      { type: 'button', id: id('mode'), label: current.pane ? 'Show as a popup' : 'Show in the omd_lsp_view/lsp pane', text: current.pane ? 'Popup' : 'Pin to pane', action: { command: 'omd_lsp_view:lsp', args: 'pane' } },
      { type: 'button', id: id('close'), label: 'Close code intelligence', text: 'Close', action: { command: 'omd_lsp_view:lsp', args: 'close' } },
    ];
    return current.pane ? { sites: { ...sidebar, 'omd_lsp_view/lsp': { mode: 'replace', components } } }
      : { sites: { ...sidebar, dialog: { mode: 'wrap', components: [{ type: 'dialog', id: 'omd_lsp_view_dialog', label: 'Code intelligence', title: current.title, children: components }, { type: 'slot' }] } } };
  });
}
