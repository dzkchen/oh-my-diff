import type { Json, ModAPI, RenderEvent, RenderExecCall, RenderToolStep, TerminalComponent, TerminalSpan } from '../../api.d.ts';

const ASCII = /^[\x20-\x7e]*$/;
const bytes = (text: string) => { let size = 0; for (const char of text) { const point = char.codePointAt(0)!; size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; } return size; };

const WIDE = /[ᄀ-ᅟ\u17A4⺀-꓏ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3ffff}]|\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
const ZERO = /[\u1160-\u11ff\uD7B0-\uD7FF\p{Grapheme_Extend}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}]|[#*0-9]\uFE0F?\u20E3)[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{Grapheme_Extend}\p{Default_Ignorable_Code_Point}]*$/u;
let segments: Intl.Segmenter | undefined;
const segmenter = () => segments ??= new Intl.Segmenter();
const widthOf = (text: string) => ASCII.test(text) ? text.length : [...segmenter().segment(text)].reduce((sum, { segment }) => sum + (EMOJI.test(segment) ? 2
  : [...segment.replace(/([‘’“”])\uFE01/gu, '$1$1')].reduce((width, char) => width + (char !== '\u115F' && ZERO.test(char) ? 0 : char === '\u17D8' ? 3 : WIDE.test(char) ? 2 : 1), 0)), 0);

const fit = (text: string, cells: number, chars = cells, limit = 240) => {
  if (cells < 1 || chars < 1 || limit < 3) return '';
  const bound = Math.min(chars, limit) + 1;
  const cut = text.length > bound;
  let sliced = cut ? text.slice(0, bound) : text;
  if (cut && sliced.charCodeAt(sliced.length - 1) >= 0xd800 && sliced.charCodeAt(sliced.length - 1) <= 0xdbff) sliced = sliced.slice(0, -1);
  const flat = sliced.replace(/\s+/g, ' ').trim();
  if (ASCII.test(flat)) return !cut && flat.length <= Math.min(cells, chars, limit) ? flat : `${flat.slice(0, Math.min(cells - 1, chars - 1, limit - 3))}…`;
  const all = [...flat];
  if (!cut && all.length <= chars && widthOf(flat) <= cells && bytes(flat) <= limit) return flat;
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

type Row = { text: string; marker?: string | null; failed: boolean; running: boolean };
type Step = Exclude<RenderToolStep, { kind: 'explore' }>;

const names = (agents: string[]) => agents.length > 1 ? `${agents.slice(0, -1).join(', ')} and ${agents.at(-1)}` : agents[0] ?? 'an agent';
const capital = (text: string) => text[0].toUpperCase() + text.slice(1);

const argument = (value: Json): string => value === null || value === undefined ? ''
  : typeof value === 'string' ? value
  : Array.isArray(value) || typeof value !== 'object' ? JSON.stringify(value)
  : Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`).join(', ');

const kind = (call: RenderExecCall) => {
  const parsed = Array.isArray(call.parsed) ? call.parsed : [];
  return parsed.length && parsed.every(item => item.type === parsed[0].type) && parsed[0].type !== 'unknown' ? parsed[0].type : 'command';
};

const STEP: Record<string, [string, string]> = { read: ['Read', 'Reading'], list_files: ['Listed', 'Listing'], search: ['Searched for', 'Searching for'] };
const step = (call: RenderExecCall, running = call.status === 'running') => {
  const type = kind(call);
  if (type === 'command') return running ? `Running ${call.command}` : call.command;
  const args = call.parsed.map(parsed => parsed.type === 'read' ? parsed.name ?? ''
    : parsed.type === 'list_files' ? parsed.path ?? '.'
    : parsed.type === 'search' ? `${parsed.query ?? ''}${parsed.path ? ` in ${parsed.path}` : ''}`.trim() : parsed.cmd).join(', ');
  return `${STEP[type][running ? 1 : 0]} ${args}`;
};

const exec = (call: RenderExecCall): Row => ({
  text: call.status === 'failed' ? `Command failed (${call.command})` : call.status === 'interrupted' ? `Command interrupted (${call.command})` : step(call),
  marker: call.status === 'failed' && call.exit_code ? `exit ${call.exit_code}` : null,
  failed: call.status === 'failed' || call.status === 'interrupted', running: call.status === 'running',
});

const PHRASES: Record<string, [string, string]> = { read: ['read a file', 'read files'], list_files: ['listed a folder', 'listed folders'], search: ['searched files', 'searched files'], command: ['ran a command', 'ran commands'] };
const group = (calls: RenderExecCall[]): Row => {
  const failed = calls.filter(call => call.status === 'failed');
  const interrupted = calls.filter(call => call.status === 'interrupted').length;
  const live = calls.filter(call => call.status === 'running').at(-1);
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(kind(call), (counts.get(kind(call)) ?? 0) + (kind(call) === 'command' ? 1 : call.parsed.length));
  const text = [...counts].map(([type, count]) => PHRASES[type][count === 1 ? 0 : 1]).join(', ');
  return {
    text: live ? step(live, true) : capital(text),
    marker: [failed.length ? `${failed.length} failed` : null, failed.at(-1)?.exit_code ? `exit ${failed.at(-1)!.exit_code}` : null,
      interrupted ? `${interrupted} interrupted` : null].filter(Boolean).join(' · '),
    failed: failed.length + interrupted > 0, running: !!live,
  };
};

const web = (action: string, query: string, running: boolean) => {
  const [done, live] = action === 'open_page' ? query ? ['Opened', 'Opening'] : ['Opened page', 'Opening page']
    : action === 'find_in_page' ? query.startsWith("'") ? ['Searched for', 'Searching for'] : ['Searched page', 'Searching page']
    : query ? ['Searched the web for', 'Searching the web for'] : ['Searched the web', 'Browsing the web'];
  return `${running ? live : done} ${query}`.trim();
};
const AGENT: Record<string, [string, string]> = { send_input: ['Messaged', 'Messaging'], resume_agent: ['Resumed', 'Resuming'], wait: ['Waited for', 'Waiting for'], close_agent: ['Closed', 'Closing'], agent: ['Ran', 'Running'] };
const LIFE: Record<string, string> = { started: 'started working', completed: 'finished', interrupted: 'stopped' };
const life = (activity: string, who: string) => activity === 'interacted' ? `messaged ${who}` : `${who} ${LIFE[activity]}`;

const row = (props: Step): Row | null => {
  const running = props.status === 'running';
  const failed = props.status === 'failed' || props.status === 'interrupted';
  const done = (text: string, error?: string | null): Row => ({ text, marker: failed ? error || props.status : null, failed, running });
  switch (props.kind) {
    case 'exec': return exec(props);
    case 'patch': {
      if (props.error != null) {
        const error = props.error.split('\n').map(part => part.trim()).find(Boolean);
        return { text: error ? `Edit failed (${error})` : 'Edit failed', failed: true, running };
      }
      const only = props.file_count === 1 ? props.files[0] : null;
      const verb = only?.change === 'add' ? 'Added' : only?.change === 'delete' ? 'Deleted' : 'Edited';
      return { text: `${running ? 'Editing' : verb} ${only ? only.path : `${props.file_count} files`}`, marker: `+${props.added} −${props.removed}`, failed, running };
    }
    case 'web_search': return done(web(props.action, props.query, running));
    case 'agent': {
      const who = names(props.agents);
      if (props.tool !== 'spawn_agent') return done(`${(AGENT[props.tool] ?? AGENT.agent)[running ? 1 : 0]} ${who}`);
      return { text: props.status === 'failed' ? `Couldn't start ${who}` : props.status === 'interrupted' ? `Stopped starting ${who}`
        : running ? `Starting ${who}` : capital(`${who} started working`), failed, running };
    }
    case 'mcp': return done(`${running ? 'Calling' : 'Called'} ${props.server}.${props.tool} ${argument(props.arguments)}`.trim(), props.error);
    case 'dynamic': return done(`${running ? 'Calling' : 'Called'} ${props.tool} ${argument(props.arguments)}`.trim(), props.error);
    case 'image': return props.tool === 'view_image' ? null : done(`${running ? 'Generating' : 'Generated'} image ${props.path ?? props.prompt ?? ''}`.trim());
    case 'subagent': return { text: capital(life(props.activity, props.agent ?? 'an agent')), failed: false, running: false };
    default: return null;
  }
};

const STEPS: Record<string, [string, string]> = { web: ['searched the web', 'searched the web'], patch: ['edited a file', 'edited files'], tool: ['called a tool', 'called tools'],
  view_image: ['viewed an image', 'viewed images'], image_generation: ['generated an image', 'generated images'], spawn_agent: ['started an agent', 'started agents'],
  send_input: ['messaged an agent', 'messaged agents'], wait: ['waited for an agent', 'waited for agents'], resume_agent: ['resumed an agent', 'resumed agents'],
  close_agent: ['closed an agent', 'closed agents'], agent: ['used an agent', 'used agents'] };
const phrase = (call: Exclude<Step, { kind: 'subagent' }>): [string, number] => {
  switch (call.kind) {
    case 'exec': { const type = kind(call); return [type, type === 'command' ? 1 : call.parsed.length]; }
    case 'web_search': return ['web', 1];
    case 'patch': return ['patch', Math.max(1, call.file_count)];
    case 'mcp': case 'dynamic': return ['tool', 1];
    case 'image': return [call.tool, 1];
    case 'agent': return [call.tool, Math.max(1, call.agents.length)];
    default: return ['tool', 1];
  }
};
const summary = (calls: Step[]) => {
  const parts: { key?: string; count: number; text?: string }[] = [];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    if (call.kind === 'subagent') {
      const agents = [call.agent ?? 'an agent'];
      for (let next = calls[index + 1]; next?.kind === 'subagent' && next.activity === call.activity; next = calls[++index + 1]) agents.push(next.agent ?? 'an agent');
      parts.push({ count: 1, text: life(call.activity, names(agents)) });
      continue;
    }
    const [key, count] = phrase(call);
    const part = parts.find(part => part.key === key);
    if (part) part.count += count; else parts.push({ key, count });
  }
  return parts.map(part => part.text ?? (PHRASES[part.key!] ?? STEPS[part.key!])[part.count === 1 ? 0 : 1]).join(', ');
};
const run = (calls: Step[], status: string): Row => {
  const failed = calls.filter(call => call.status === 'failed');
  const interrupted = calls.filter(call => call.status === 'interrupted').length;
  const live = calls.filter(call => call.status === 'running').at(-1);
  const last = failed.at(-1);
  const exit = last?.kind === 'exec' ? last.exit_code : null;
  return {
    text: (live && row(live)?.text) || capital(summary(calls)),
    marker: [failed.length ? `${failed.length} failed` : null, exit ? `exit ${exit}` : null, interrupted ? `${interrupted} interrupted` : null].filter(Boolean).join(' · '),
    failed: failed.length + interrupted > 0 || status === 'failed', running: !!live,
  };
};

const line = (item: Row, columns: number): TerminalComponent => {
  const available = Math.max(0, Math.min(columns, 256));
  const marker = fit(item.marker ?? '', available - 14, 96);
  const text = fit(item.text, Math.max(0, available - 2 - (marker ? widthOf(marker) + 3 : 0)), 249 - [...marker].length);
  const spans: TerminalSpan[] = [
    { text: fit(item.failed ? '✗' : '•', available), tone: item.failed ? 'failure' : item.running ? 'accent' : 'muted' },
    { text: text ? ` ${text}` : '', tone: 'muted' },
  ];
  if (marker) spans.push({ text: ` · ${marker}`, tone: item.failed ? 'failure' : 'muted' });
  return { type: 'line', id: 'tool_lines', label: fit(item.text, 120, 120, 120), spans };
};

export default function activate(api: ModAPI) {
  api.builtins({ group_exec: true, group_tools: true });
  api.intercept('render', { match: { component: 'tool_call' } }, (event, next) => {
    const { props, viewport } = event as RenderEvent<'tool_call'>;
    if (props.presentation === 'transcript' || (props.expanded && props.kind !== 'run') || (props.kind === 'exec' && props.user_shell)) return next(event);
    try {
      const item = props.kind === 'run' ? run(props.calls, props.status)
        : props.kind === 'explore' ? props.calls.length > 1 ? group(props.calls) : props.calls[0] && exec(props.calls[0]) : row(props);
      if (item) return { tree: [line(item, viewport.columns)] };
    } catch {}
    return next(event);
  });
}
