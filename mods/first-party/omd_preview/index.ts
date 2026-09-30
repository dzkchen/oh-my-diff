import type { CommandResult, Json, ModAPI, TerminalComponent } from '@oh-my-diff/mod-api';

const DIR = '.omd/preview';
const INLINE_CHARACTERS = 40_000;
const MAX_WATCHES = 8;
const USAGE = 'usage: /preview [N | list | PATH] [--inline] [--watch] | /preview unwatch | /preview close';

type Inline = { title: string; kind: string; text: string };
type State = { inline: Inline | null; revision: number; watch: string[]; watchId: string | null };
type Turn = { items?: { type?: string; text?: string }[] };
type Rendered = { path: string } | { error: string };

const outputFor = (source: string) => `${DIR}/${source.replace(/[/\\]/g, '__')}.html`;
const inlineKind = (path: string) => {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  return ['diff', 'patch'].includes(extension) ? 'diff' : extension;
};

export default function activate(api: ModAPI) {
  const load = (): State => ({ inline: null, revision: 0, watch: [], watchId: null, ...(api.state.get() as Partial<State> | null) });
  const save = (patch: Partial<State>) => api.state.set({ ...load(), ...patch } as unknown as Json);

  const render = (output: string, title: string, source?: string, markdown?: string): Rendered => {
    const watch = source !== undefined && load().watch.includes(source);
    const input = markdown === undefined ? '' : `globalThis.markdown = ${JSON.stringify(markdown)};\n`;
    const run = api.host.tryCall('exec.run', {
      program: 'node',
      argv: ['--input-type=module', '-', output, title, watch ? 'watch' : '', ...(source ? [source] : [])],
      stdin: input + api.assets.read('render.mjs').text,
      write: true,
      timeout_ms: 30_000,
    });
    if (!run.ok) return { error: run.error === 'exec_arguments_invalid' ? 'the text is too long to preview (about 48 KB at most)' : run.error };
    return run.value.exit_code === 0 ? { path: run.value.stdout } : { error: /Error: (.*)/.exec(run.value.stderr)?.[1] ?? 'render failed' };
  };

  const open = (rendered: Rendered, label: string): CommandResult => {
    if ('error' in rendered) return { display: `/preview: ${rendered.error}` };
    const opened = api.host.tryCall('terminal.open', { path: rendered.path });
    if (opened.ok && 'opened' in opened.value) return { display: `Opened ${label} in the browser` };
    return { display: `Wrote ${label} to ${rendered.path}${opened.ok ? '' : ` (${opened.error})`}` };
  };

  const show = (title: string, kind: string, text: string): CommandResult => {
    save({ inline: { title, kind, text: text.slice(0, INLINE_CHARACTERS) }, revision: load().revision + 1 });
    return text.length > INLINE_CHARACTERS ? { display: `Showing the first ${INLINE_CHARACTERS} characters; open it in the browser for the rest` } : null;
  };

  const currentThread = () => {
    const before = api.host.call('store.get', { key: 'thread' });
    api.host.call('store.put', { key: 'thread', value: null, expected_revision: before?.revision ?? null });
    return api.host.call('store.get', { key: 'thread' })?.provenance.thread_id ?? null;
  };

  const responses = (limit: number): string[] => {
    const page = api.host.call('app.request', { method: 'thread/turns/list', params: { threadId: currentThread(), limit, itemsView: 'summary' } }) as { data?: Turn[] };
    return (page.data ?? []).flatMap(turn => (turn.items ?? []).filter(item => item.type === 'agentMessage').slice(-1).map(item => item.text ?? ''));
  };

  const preview = (words: string[]): CommandResult => {
    const inline = words.includes('--inline');
    const target = words.filter(word => !word.startsWith('--')).join(' ');
    if (words.some(word => word.startsWith('--') && word !== '--inline' && word !== '--watch')) return { display: USAGE };
    if (target === 'close') {
      save({ inline: null });
      return null;
    }
    if (target === 'unwatch') {
      save({ watch: [] });
      api.host.tryCall('events.publish', { channel: 'watch', data: null });
      return { display: 'Stopped watching preview files' };
    }
    if (target === 'list') {
      const lines = responses(10).map((text, index) => `${index + 1}. ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
      return { display: lines.join('\n') || 'No responses in this session yet' };
    }
    if (!target || /^\d+$/.test(target)) {
      const index = Math.max(1, Number(target || 1));
      const text = responses(Math.min(index, 20))[index - 1];
      if (text === undefined) return { display: `No response ${index} in this session` };
      return inline ? show(`Response ${index}`, 'markdown', text) : open(render(`${DIR}/response.html`, `Response ${index}`, undefined, text), `response ${index}`);
    }
    const file = api.host.call('workspace.stat', { paths: [target] }).files[target];
    if (file?.kind !== 'file') return { display: `No file ${target} in the workspace` };
    if (inline) {
      if (file.size > INLINE_CHARACTERS) return { display: `${target} is too large to show inline; use /preview ${target}` };
      return show(target, inlineKind(target), api.host.call('workspace.read', { paths: [target] }).files[target]?.text ?? '');
    }
    if (words.includes('--watch')) {
      const watch = [...new Set([...load().watch, target])];
      if (watch.length > MAX_WATCHES) return { display: `At most ${MAX_WATCHES} files can be watched; use /preview unwatch` };
      save({ watch });
      api.host.tryCall('events.publish', { channel: 'watch', data: null });
    }
    return open(render(outputFor(target), target, target), target);
  };

  const syncWatches = () => {
    const { watch, watchId } = load();
    if (watchId) api.host.tryCall('workspace.unwatch', { watch_id: watchId });
    const watched = watch.length ? api.host.tryCall('workspace.watch', { paths: watch, debounce_ms: 300 }) : null;
    save({ watchId: watched?.ok ? watched.value.watch_id : null });
  };

  api.command('preview', value => {
    try {
      return preview(String(value ?? '').trim().split(/\s+/).filter(Boolean));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: `/preview: ${error.message}` };
    }
  }, { description: 'Render a response or Markdown, code or diff file as HTML in the browser; --inline shows it here, --watch keeps a file fresh' });

  api.on('channel', syncWatches);
  api.on('start', syncWatches);
  api.on('resume', syncWatches);
  api.on('workspace_change', event => {
    const { watch } = load();
    for (const path of new Set(event.changes.map(change => change.path).filter(path => watch.includes(path)))) render(outputFor(path), path, path);
  });

  api.on('terminal', () => {
    const { inline, revision } = load();
    if (!inline) return null;
    const id = `omd_preview_body_${revision}`;
    const body: TerminalComponent = inline.kind === 'markdown' ? { type: 'markdown', id, label: inline.title, text: inline.text }
      : inline.kind === 'diff' ? { type: 'diff', id, label: inline.title, unified: inline.text }
        : { type: 'code', id, label: inline.title, text: inline.text, language: inline.kind };
    return { sites: { dialog: { mode: 'replace', components: [{ type: 'dialog', id: 'omd_preview_dialog', label: 'Preview', title: inline.title, children: [
      { type: 'pane', id: `omd_preview_pane_${revision}`, label: 'Preview content, scroll with arrows or the mouse wheel', children: [body] },
      { type: 'button', id: 'omd_preview_close', label: 'Close preview', text: 'Close', action: { command: 'omd_preview:preview', args: 'close' } },
    ] }] } } };
  });
}
