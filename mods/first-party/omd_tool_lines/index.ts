import type { Json, ModAPI, RenderEvent, RenderExecCall, RenderParsedCommand, RenderToolCall, TerminalComponent, TerminalSpan } from '../../api.d.ts';

type Row = { name: string; args: string; marker: (string | null)[]; failed: boolean; running: boolean };

const ASCII = /^[\x20-\x7e]*$/;
const bytes = (text: string) => { let size = 0; for (const char of text) { const point = char.codePointAt(0)!; size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; } return size; };

const WIDE = /[ᄀ-ᅟ\u17A4⺀-꓏ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3ffff}]|\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
const ZERO = /[\u1160-\u11ff\uD7B0-\uD7FF\p{Grapheme_Extend}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}]|[#*0-9]\uFE0F?\u20E3)[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{Grapheme_Extend}\p{Default_Ignorable_Code_Point}]*$/u;
// ICU objects are built on first use: every callback evaluates the module in a fresh context.
let segments: Intl.Segmenter | undefined;
const segmenter = () => segments ??= new Intl.Segmenter();
// The native renderer treats variation-selector-1 quotes as two cells.
const widthOf = (text: string) => ASCII.test(text) ? text.length : [...segmenter().segment(text)].reduce((sum, { segment }) => sum + (EMOJI.test(segment) ? 2
  : [...segment.replace(/([‘’“”])\uFE01/gu, '$1$1')].reduce((width, char) => width + (char !== '\u115F' && ZERO.test(char) ? 0 : char === '\u17D8' ? 3 : WIDE.test(char) ? 2 : 1), 0)), 0);

const fit = (text: string, cells: number, chars = cells, limit = 240) => {
  if (cells < 1 || chars < 1 || limit < 3) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (ASCII.test(flat)) return flat.length <= Math.min(cells, chars, limit) ? flat : `${flat.slice(0, Math.min(cells - 1, chars - 1, limit - 3))}…`;
  const all = [...flat];
  if (all.length <= chars && widthOf(flat) <= cells && bytes(flat) <= limit) return flat;
  const kept: string[] = [];
  let width = 1;
  let size = 3;
  let count = 1;
  for (const { segment: char } of segmenter().segment(flat)) {
    const cost = widthOf(char);
    const length = [...char].length;
    const weight = bytes(char);
    if (width + cost > cells || count + length > chars || size + weight > limit) break;
    kept.push(char);
    width += cost;
    size += weight;
    count += length;
  }
  return `${kept.join('')}…`;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const lines = (count: number | null, status: RenderToolCall['status']) => count == null || status === 'running' ? null : plural(count, 'line');

const duration = (ms: number | null) => {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

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
  parsed.type === 'read' ? parsed.name ?? ''
    : parsed.type === 'list_files' ? parsed.path ?? '.'
    : parsed.type === 'search' ? `${parsed.query ?? ''}${parsed.path ? ` in ${parsed.path}` : ''}`.trim()
    : parsed.cmd;

const exec = (call: RenderExecCall): Row => {
  const parsed = Array.isArray(call.parsed) ? call.parsed : [];
  const name = parsed.length && parsed.every(item => item.type === parsed[0].type) ? parsedName(parsed[0]) : 'Shell';
  return {
    name, args: name === 'Shell' ? call.command : parsed.map(parsedArgs).join(', '),
    marker: [outcome(call.status, call.exit_code), lines(call.output_lines, call.status), duration(call.duration_ms)],
    failed: call.status === 'failed', running: call.status === 'running',
  };
};

const AGENT_TOOLS: Record<string, string> = { spawn_agent: 'Spawn agent', send_input: 'Message agent', resume_agent: 'Resume agent', wait: 'Wait for agents', close_agent: 'Close agent', agent: 'Agent' };
const SEARCH_ACTIONS: Record<string, string> = { search: 'Web search', open_page: 'Open page', find_in_page: 'Find in page', other: 'Web' };

const row = (props: Exclude<RenderToolCall, { kind: 'explore' }>): Row | null => {
  const base = { failed: props.status === 'failed', running: props.status === 'running' };
  switch (props.kind) {
    case 'exec': return exec(props);
    case 'patch': {
      if (props.error != null) return { name: 'Patch', args: props.error.split('\n')[0], marker: ['failed'], ...base };
      if (!props.files.length) return { name: 'Patch', args: '', marker: [outcome(props.status)], ...base };
      const { added, removed } = props;
      const only = props.file_count === 1 ? props.files[0] : null;
      const name = only?.change === 'add' ? 'Add' : only?.change === 'delete' ? 'Delete' : 'Edit';
      return { name, args: only ? only.path : plural(props.file_count, 'file'), marker: [props.status === 'completed' ? null : outcome(props.status), `+${added} −${removed}`], ...base };
    }
    case 'web_search': return { name: SEARCH_ACTIONS[props.action] ?? 'Web', args: props.query, marker: [outcome(props.status)], ...base };
    case 'agent': return { name: AGENT_TOOLS[props.tool] ?? 'Agent', args: [props.agents.join(', '), props.prompt].filter(Boolean).join(' · '), marker: [outcome(props.status)], ...base };
    case 'mcp': return { name: `${props.server}.${props.tool}`, args: argument(props.arguments), marker: [outcome(props.status), lines(props.output_lines, props.status), duration(props.duration_ms)], ...base };
    case 'dynamic': return { name: props.tool, args: argument(props.arguments), marker: [outcome(props.status), lines(props.output_lines, props.status), duration(props.duration_ms)], ...base };
    case 'image': return { name: props.tool === 'view_image' ? 'View image' : 'Generate image', args: props.path ?? props.prompt ?? '', marker: [outcome(props.status)], ...base };
    default: return null;
  }
};

const line = (id: string, item: Row, columns: number): TerminalComponent => {
  const available = Math.max(0, Math.min(columns, 256));
  const bullet = fit(item.failed ? '✗' : '•', available);
  const marker = fit(item.marker.filter(Boolean).join(' · '), available - 5 - Math.min(12, widthOf(item.name)), 96);
  const name = fit(item.name, Math.min(48, available - 2 - (marker ? widthOf(marker) + 3 : 0)));
  const used = widthOf(bullet) + (name ? widthOf(name) + 1 : 0) + (marker ? widthOf(marker) + 3 : 0);
  // A line holds at most 256 characters across its spans.
  const args = fit(item.args, Math.max(0, available - used - 1), 249 - [...name].length - [...marker].length);
  const spans: TerminalSpan[] = [
    { text: bullet, tone: item.failed ? 'failure' : item.running ? 'accent' : 'muted' },
    { text: name ? ` ${name}` : '', bold: true },
  ];
  if (args) spans.push({ text: ` ${args}` });
  if (marker) spans.push({ text: ` · ${marker}`, tone: item.failed ? 'failure' : 'muted' });
  return { type: 'line', id, label: fit(`${item.name} ${args}`, 120, 120, 120), spans };
};

export default function activate(api: ModAPI) {
  api.intercept('render', { match: { component: 'tool_call' } }, (event, next) => {
    const { props, viewport } = event as RenderEvent<'tool_call'>;
    if (props.expanded || (props.kind === 'exec' && props.user_shell)) return next(event);
    try {
      const rows = props.kind === 'explore' ? props.calls.map(exec) : [row(props)];
      if (rows.length && rows.every((item): item is Row => item !== null)) {
        return { tree: rows.map((item, index) => line(`tool_lines_${index}`, item, viewport.columns)) };
      }
    } catch {}
    return next(event);
  });
}
