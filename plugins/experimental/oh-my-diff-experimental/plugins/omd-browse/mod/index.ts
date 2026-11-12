import type { Json, LayoutNode, ModAPI, RenderEvent, TerminalComponent, TerminalPatch } from '@oh-my-diff/mod-api';

type Browser = { calls: number; tab: string; title: string; url: string; recording: boolean; learned: string[] };
type Pane = { open: boolean; session: string; runs: number; line: string; user: boolean; error: string };

const SERVER = 'omd_browse';
const TOOL = `mcp__${SERVER}__browse`;
const RASTER = 'omd_browse_live';
const KEYS = 'omd_browse_keys';
const BOOT = "import{createInterface as c}from'node:readline';const i=c({input:process.stdin});const q=[];let f=l=>q.push(l);i.on('close',()=>process.exit(0));const s=await new Promise(r=>{f=l=>{try{const m=JSON.parse(l);if(m.src){f=x=>q.push(x);r(m.src);return}}catch{}q.push(l)};i.on('line',l=>f(l))});globalThis.omdLines=h=>{f=h;q.splice(0).forEach(h)};await import('data:text/javascript,'+encodeURIComponent(s))";
const EMPTY: Browser = { calls: 0, tab: '', title: '', url: '', recording: false, learned: [] };
const CLOSED: Pane = { open: false, session: '', runs: 0, line: '', user: false, error: '' };

const clip = (text: string, size: number) => text.length > size ? `${text.slice(0, size - 1)}…` : text;

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'this site';
  }
};

function absorb(state: Browser, output: string): Browser {
  const next = { ...state, calls: state.calls + 1 };
  const header = [...output.matchAll(/^\[(t\d+)(?:, lent by the user)?\] (.*) — (\S+)$/gm)].at(-1);
  if (header) Object.assign(next, { tab: header[1], title: header[2], url: header[3] });
  if (/^Recording t\d+/m.test(output)) next.recording = true;
  if (/^Saved \S+\.mp4|^ffmpeg is not available/m.test(output)) next.recording = false;
  const learned = [...output.matchAll(/^learned api: ([\w-]+)/gm)].map(match => match[1]);
  if (learned.length) next.learned = [...new Set([...state.learned, ...learned])].slice(-20);
  return next;
}

export default function activate(api: ModAPI): void {
  const browser = api.atom<Browser>('browser', EMPTY);
  const pane = api.atom<Pane>('pane', CLOSED);

  const open = (): string => {
    const current = pane.get();
    if (current.open) return 'The browser pane is already open.';
    const found = api.host.tryCall('process.which', { names: ['node'], sandbox: 'none' });
    const node = found.ok ? found.value.found[0] : null;
    if (!node) return `The browser pane needs node on OMD's PATH${found.ok ? '' : ` (${found.error})`}.`;
    const session = `live${current.runs + 1}`;
    const started = api.host.tryCall('process.start', { session, name: 'node', path: node.path, sha256: node.sha256, sandbox: 'none', framing: 'ndjson',
      notify: ['output', 'exit'], raster: RASTER, keys: KEYS, arguments: ['--input-type=module', '-e', BOOT] });
    if (!started.ok) return `The browser pane did not start: ${started.error}`;
    const sent = api.host.tryCall('process.exchange', { session, send: [{ src: api.assets.read('bridge.mjs').text }], wait_ms: 0 });
    if (!sent.ok) {
      api.host.tryCall('process.stop', { session });
      return `The browser pane did not start: ${sent.error}`;
    }
    pane.set({ ...CLOSED, open: true, session, runs: current.runs + 1, line: 'Waiting for the agent browser…' });
    return 'Browser pane open. Click it to use the page; Ctrl+] gives the keyboard back to the chat.';
  };

  const close = (): string => {
    const current = pane.get();
    if (!current.open) return 'The browser pane is closed.';
    api.host.tryCall('process.stop', { session: current.session });
    pane.set({ ...current, open: false });
    return 'Browser pane closed.';
  };

  api.on('process_event', event => {
    const current = pane.get();
    if (event.session !== current.session || !current.open) return;
    if (event.kind === 'exit') {
      pane.set({ ...current, open: false, error: 'The browser pane bridge stopped.' });
      return;
    }
    const read = api.host.tryCall('process.exchange', { session: current.session, wait_ms: 0 });
    if (!read.ok) return;
    const status = (read.value.messages as { status?: Record<string, Json> }[]).map(message => message.status).filter(Boolean).at(-1);
    if (!status) return;
    if (status.waiting) return pane.set({ ...current, line: 'No browse server yet; the pane attaches when the agent opens the browser.', user: false });
    const line = status.tab ? `${status.tab} ${status.title || host(String(status.url))} — ${status.url}` : 'The agent has no tab open.';
    pane.set({ ...current, line, user: status.user === true });
  });

  api.intercept('tool', { match: { tool: TOOL } }, async (e, next) => {
    const result = await next(e);
    browser.set(absorb(browser.get(), typeof result.output === 'string' ? result.output : ''));
    return result;
  });

  api.intercept('render', { match: { component: 'tool_call' } }, (event, next) => {
    const { props, viewport } = event as RenderEvent<'tool_call'>;
    if (props.kind !== 'mcp' || props.server !== SERVER || props.tool !== 'browse' || props.expanded) return next(event);
    const command = typeof props.arguments === 'object' && props.arguments && !Array.isArray(props.arguments) ? String((props.arguments as Record<string, Json>).command ?? '') : '';
    const failed = props.status === 'failed';
    const marker = [props.status === 'running' ? 'running' : failed ? 'failed' : props.status === 'interrupted' ? 'interrupted' : 'ok',
      props.output_lines != null && props.status !== 'running' ? `${props.output_lines} lines` : null,
      props.duration_ms ? `${(props.duration_ms / 1000).toFixed(1)}s` : null].filter(Boolean).join(' · ');
    const room = Math.max(10, Math.min(viewport.columns, 256) - marker.length - 14);
    const line: TerminalComponent = {
      type: 'line', id: 'omd_browse_row', label: clip(`Browse ${command}`, 120),
      spans: [
        { text: failed ? '✗' : '◍', tone: failed ? 'failure' : props.status === 'running' ? 'accent' : 'muted' },
        { text: ' Browse', bold: true },
        { text: ` ${clip(command.replace(/\s+/g, ' '), room)}` },
        { text: ` · ${marker}`, tone: failed ? 'failure' : 'muted' },
      ],
    };
    return { tree: [line] };
  });

  api.on('terminal', () => {
    const state = browser.get();
    const view = pane.get();
    const status: string[] = [];
    if (state.calls) status.push(clip(`◍ ${state.tab} ${state.title || host(state.url)}`, 40));
    if (state.recording) status.push('● rec');
    if (state.learned.length) status.push(clip(`api: ${state.learned.slice(-3).join(', ')}`, 40));
    const patch: TerminalPatch = status.length ? { status } : {};
    if (!view.open) return status.length ? patch : null;
    const layout: LayoutNode = { split: 'horizontal', ratio: [55, 45], children: [
      { split: 'vertical', ratio: [5, 1], children: [{ content: 'transcript' }, { content: 'composer' }] },
      { content: `site:${SERVER}/live`, title: view.user ? 'Browser · your turn' : 'Browser' },
    ] };
    return { ...patch, layout, sites: { [`${SERVER}/live`]: { mode: 'replace', components: [
      { type: 'line', id: 'omd_browse_live_status', label: 'Browser tab', spans: [
        { text: view.user ? '● your turn ' : '◍ ', tone: view.user ? 'attention' : 'muted' },
        { text: view.line },
      ] },
      { type: 'pane', id: KEYS, label: 'Agent browser', keys: true, children: [
        { type: 'raster', id: RASTER, label: 'Agent browser', alt: 'The agent browser appears here', pointer: true },
      ] },
    ] } } };
  });

  api.command('browse', input => {
    const word = typeof input === 'string' ? input.trim() : '';
    if (word === 'off' || (word === '' && pane.get().open)) return { display: close() };
    if (word === 'on' || word === '') return { display: open() };
    const state = browser.get();
    if (word !== 'status') return { display: 'Usage: /browse [on|off|status]' };
    return { display: [state.calls ? `Tab ${state.tab}: ${state.title} — ${state.url}` : 'The agent has not used the browser in this thread.',
      state.recording ? 'Recording.' : '',
      state.learned.length ? `Endpoints learned this thread: ${state.learned.join(', ')}` : '',
      pane.get().error].filter(Boolean).join('\n') };
  }, { description: 'Show the agent browser live beside the chat and use it yourself; /browse again closes it', args_hint: '[on|off|status]' });
}
