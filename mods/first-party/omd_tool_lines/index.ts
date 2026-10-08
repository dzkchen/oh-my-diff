import type { Json, ModAPI, RenderEvent, RenderExecCall, RenderParsedCommand, RenderToolCall, TerminalComponent, TerminalSpan } from '../../api.d.ts';

type Row = { name: string; args: string; marker: (string | null)[]; failed: boolean; running: boolean };

const bytes = (text: string) => {
  let total = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    total += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return total;
};

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u;

// Keeps `cells` display columns, `chars` characters and `limit` UTF-8 bytes, ending in `…` when cut.
const fit = (text: string, cells: number, chars = cells, limit = 240) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const all = [...flat];
  const widthOf = (char: string) => WIDE.test(char) ? 2 : 1;
  if (all.length <= chars && all.reduce((sum, char) => sum + widthOf(char), 0) <= cells && bytes(flat) <= limit) return flat;
  const kept: string[] = [];
  let width = 1;
  let size = 3;
  for (const char of all) {
    if (width + widthOf(char) > cells || kept.length + 2 > chars || size + bytes(char) > limit) break;
    kept.push(char);
    width += widthOf(char);
    size += bytes(char);
  }
  return `${kept.join('')}…`;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const duration = (ms: number | null) => !ms ? null
  : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const outcome = (status: RenderToolCall['status'], exit: number | null = null) =>
  status === 'running' ? 'running' : status === 'interrupted' ? 'interrupted'
    : status === 'failed' ? (exit !== null && exit !== 0 ? `exit ${exit}` : 'failed') : 'ok';

const argument = (value: Json): string => value === null || value === undefined ? ''
  : typeof value === 'string' ? value
  : Array.isArray(value) || typeof value !== 'object' ? JSON.stringify(value)
  : Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`).join(', ');

const parsedName = (parsed: RenderParsedCommand) =>
  parsed.type === 'read' ? 'Read' : parsed.type === 'list_files' ? 'List' : parsed.type === 'search' ? 'Search' : 'Shell';

const parsedArgs = (parsed: RenderParsedCommand) =>
  parsed.type === 'read' ? parsed.name
    : parsed.type === 'list_files' ? parsed.path ?? '.'
    : parsed.type === 'search' ? `${parsed.query ?? ''}${parsed.path ? ` in ${parsed.path}` : ''}`.trim()
    : parsed.cmd;

const exec = (call: RenderExecCall): Row => {
  const parsed = Array.isArray(call.parsed) ? call.parsed : [];
  const name = parsed.length && parsed.every(item => item.type === parsed[0].type) ? parsedName(parsed[0]) : 'Shell';
  return {
    name, args: name === 'Shell' ? call.command : parsed.map(parsedArgs).join(', '),
    marker: [outcome(call.status, call.exit_code), call.status === 'running' ? null : plural(call.output_lines, 'line'), duration(call.duration_ms)],
    failed: call.status === 'failed', running: call.status === 'running',
  };
};

const AGENT_TOOLS: Record<string, string> = { spawn_agent: 'Spawn agent', send_input: 'Message agent', resume_agent: 'Resume agent', wait: 'Wait for agents', close_agent: 'Close agent', agent: 'Agent' };
const SEARCH_ACTIONS: Record<string, string> = { search: 'Web search', open_page: 'Open page', find_in_page: 'Find in page', other: 'Web' };

const row = (props: Exclude<RenderToolCall, { kind: 'explore' }>): Row => {
  const base = { failed: props.status === 'failed', running: props.status === 'running' };
  const lines = (count: number | null) => count === null || props.status === 'running' ? null : plural(count, 'line');
  switch (props.kind) {
    case 'exec': return exec(props);
    case 'patch': {
      if (props.error !== null) return { name: 'Patch', args: props.error.split('\n')[0] ?? '', marker: ['failed'], ...base };
      const added = props.files.reduce((sum, file) => sum + file.added, 0);
      const removed = props.files.reduce((sum, file) => sum + file.removed, 0);
      const only = props.files.length === 1 ? props.files[0] : null;
      const name = only?.change === 'add' ? 'Add' : only?.change === 'delete' ? 'Delete' : 'Edit';
      return { name, args: only ? only.path : plural(props.files.length, 'file'), marker: [`+${added} −${removed}`], ...base };
    }
    case 'web_search': return { name: SEARCH_ACTIONS[props.action] ?? 'Web', args: props.query, marker: [outcome(props.status)], ...base };
    case 'agent': return { name: AGENT_TOOLS[props.tool] ?? 'Agent', args: [props.agents.join(', '), props.prompt].filter(Boolean).join(' · '), marker: [outcome(props.status)], ...base };
    case 'mcp': return { name: `${props.server}.${props.tool}`, args: argument(props.arguments), marker: [outcome(props.status), lines(props.output_lines), duration(props.duration_ms)], ...base };
    case 'dynamic': return { name: props.tool, args: argument(props.arguments), marker: [outcome(props.status), lines(props.output_lines), duration(props.duration_ms)], ...base };
    case 'image': return { name: props.tool === 'view_image' ? 'View image' : 'Generate image', args: props.path ?? props.prompt ?? '', marker: [outcome(props.status)], ...base };
  }
};

const line = (id: string, item: Row, columns: number): TerminalComponent => {
  const marker = item.marker.filter(Boolean).join(' · ');
  const name = fit(item.name, 48);
  const used = [...name].length + [...marker].length;
  // A line holds at most 256 characters across its spans.
  const args = fit(item.args, columns - used - 7, 244 - used);
  const spans: TerminalSpan[] = [
    { text: item.failed ? '✗ ' : '• ', tone: item.failed ? 'failure' : item.running ? 'accent' : 'muted' },
    { text: name, bold: true },
  ];
  if (args) spans.push({ text: ` ${args}` });
  if (marker) spans.push({ text: ` · ${marker}`, tone: item.failed ? 'failure' : 'muted' });
  return { type: 'line', id, label: fit(`${item.name} ${args}`, 120, 120, 120), spans };
};

export default function activate(api: ModAPI) {
  api.intercept('render', { match: { component: 'tool_call' } }, (event, next) => {
    const { props, viewport } = event as RenderEvent<'tool_call'>;
    if (props.expanded || (props.kind === 'exec' && props.user_shell)) return next(event);
    const rows = props.kind === 'explore' ? props.calls.map(exec) : [row(props)];
    return { tree: rows.map((item, index) => line(`tool_lines_${index}`, item, viewport.columns)) };
  });
}
