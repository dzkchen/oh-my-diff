import type { Json, ModAPI, TerminalComponent, TerminalSpan, TerminalView } from '@oh-my-diff/mod-api';

type Spend = { micro: number; priced: number; included: number; unknown: number };
type Turn = { usd: number; note: '' | 'included' | 'unknown' };
type Limit = { name: string; minutes: number | null; used: number; resets: number | null };
type Tally = { input: number; output: number };
type State = {
  spend: Spend; seen: string[]; fired: number[]; turns: Turn[]; mark: Spend | null; models: Record<string, Tally>;
  limits: Limit[]; lifetime: number; hidden: boolean; demo: number | null; from: number; rev: number;
};
type Props = { id: string; rows: number; from: number; goal: number; demo: number | null; level: number | null; text: string | null; extra: string; reduced: boolean };
type Fire = { shown: number; goal: number; demo: number | null; aim: number; frame: number; fired: number[]; done: boolean };
type Cell = { g: string; fg: number | null };

const NONE: Spend = { micro: 0, priced: 0, included: 0, unknown: 0 };
const EMPTY: State = { spend: NONE, seen: [], fired: [], turns: [], mark: null, models: {}, limits: [], lifetime: 0, hidden: false, demo: null, from: 0, rev: 0 };
const THRESHOLDS = [1, 5, 10, 25, 50];
const THINGS = [{ one: 'burrito', many: 'burritos', usd: 11 }, { one: 'McDouble', many: 'McDoubles', usd: 3.19 }];
const TURNS_KEPT = 12;
const SEEN_KEPT = 64;
const DEMO_MS = 20_000;
const DEMO_HOLD_MS = 6_000;
const DEMO_TOP = 30.5;
const FRAME_MS = 70;
const GOLD = 0xc2a87e;
const ORANGE = 0xe8833a;
const RED = 0xe5484d;
const WHITE = 0xfff4e0;
const YELLOW = 0xffd166;
const EMPTY_BAR = 0x2a2724;
const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const hex = (n: number): `#${string}` => `#${n.toString(16).padStart(6, '0')}`;
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const money = (usd: number) => '$' + (usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
const compare = (usd: number, index: number) => {
  const thing = THINGS[((index % THINGS.length) + THINGS.length) % THINGS.length]!;
  const count = usd / thing.usd;
  const shown = count >= 10 ? count.toFixed(0) : count >= 1 ? count.toFixed(1) : count.toFixed(2);
  return `= ${shown} ${shown === '1.0' || shown === '1' ? thing.one : thing.many}`;
};
const tokenCount = (n: number) => n < 1000 ? `${Math.round(n)}` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;
const modelName = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id);
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
};
const modelsLine = (models: Record<string, Tally>, max: number) => Object.entries(models)
  .sort((a, b) => b[1].output - a[1].output).slice(0, max)
  .map(([id, t]) => `${modelName(id)} ${tokenCount(t.input)} in ${tokenCount(t.output)} out`).join(' · ');
const crossed = (from: number, to: number, fired: number[]) => THRESHOLDS.filter(t => from < t && to >= t && !fired.includes(t));
const heat = (usd: number) => clamp(Math.log10(1 + usd) / 2);
const tween = (shown: number, goal: number) => {
  const gap = goal - shown;
  if (Math.abs(gap) < 0.0005) return goal;
  const step = gap * 0.22;
  return shown + (Math.abs(step) < 0.0005 ? Math.sign(gap) * 0.0005 : step);
};
const barText = (columns: number, fraction: number) => {
  const filled = Math.max(1, Math.round(clamp(fraction) * columns));
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, columns - filled));
};
const resetsIn = (at: number | null, now: number) => {
  if (at === null) return '';
  if (at <= now) return 'now';
  const m = Math.floor((at - now) / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m % 60}m` : `in ${m}m`;
};
const windowName = (minutes: number | null) =>
  minutes === null ? 'window' : minutes === 10080 ? 'wk' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
const windows = (value: Json): Limit[] => {
  const snapshot = object(object(value).rateLimits);
  return ['primary', 'secondary'].flatMap(slot => {
    const item = object(snapshot[slot]);
    if (typeof item.usedPercent !== 'number') return [];
    const minutes = typeof item.windowDurationMins === 'number' ? item.windowDurationMins : null;
    const at = typeof item.resetsAt === 'number' ? item.resetsAt : null;
    return [{ name: windowName(minutes), minutes, used: item.usedPercent, resets: at === null ? null : at < 1e12 ? at * 1000 : at }];
  }).sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9));
};
const demoUsd = (elapsed: number) => {
  const t = clamp(elapsed / DEMO_MS);
  return DEMO_TOP * t * t * (0.35 + 0.65 * t);
};

const mix = (a: number, b: number, t: number) => {
  const ch = (shift: number) => Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const flame = (h: number) => (h < 0.5 ? mix(GOLD, ORANGE, h * 2) : mix(ORANGE, RED, (h - 0.5) * 2));
const wobble = (x: number, t: number) => 0.5 + 0.25 * Math.sin(t * 9.1 + x * 1.7) + 0.25 * Math.sin(t * 5.3 - x * 2.9 + Math.sin(t * 2 + x));
const flameAt = (y: number, h: number) => {
  const tip = mix(ORANGE, RED, Math.min(1, 0.3 + h));
  return y < 0.25 ? mix(WHITE, YELLOW, y * 4) : y < 0.6 ? mix(YELLOW, ORANGE, (y - 0.25) / 0.35) : mix(ORANGE, tip, (y - 0.6) / 0.4);
};

const fireCells = (columns: number, rows: number, h: number, t: number): Cell[][] => {
  const grid: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ g: ' ', fg: null })));
  const filled = Math.max(1, Math.round(h * columns));
  const flameRows = rows - 1;
  for (let x = 0; x < columns; x++) {
    if (x >= filled) {
      grid[rows - 1]![x] = { g: '░', fg: EMPTY_BAR };
      continue;
    }
    const along = filled <= 1 ? 1 : x / (filled - 1);
    grid[rows - 1]![x] = { g: '█', fg: mix(GOLD, flame(along * h), along) };
    const lead = 1 - Math.min(1, (filled - 1 - x) / Math.max(4, filled * 0.6));
    const height = flameRows * 8 * Math.min(1, (0.35 + 0.4 * h + 0.45 * lead) * (0.35 + 0.9 * wobble(x, t)));
    for (let y = 0; y < flameRows; y++) {
      const fromBottom = flameRows - 1 - y;
      const eighths = Math.max(0, Math.min(8, Math.round(height - fromBottom * 8)));
      if (eighths > 0) grid[y]![x] = { g: EIGHTHS[eighths]!, fg: flameAt(fromBottom / flameRows + eighths / (8 * flameRows), h) };
    }
    if (height < 9 && wobble(x * 3.1, t * 1.7) > 0.86) grid[0]![x] = { g: Math.floor(t * 10 + x) % 2 ? '·' : '*', fg: mix(YELLOW, ORANGE, h) };
  }
  return grid;
};

// A line holds at most 12 spans, so each row is split into at most 12 runs, one color per run.
const fireLine = (id: string, row: Cell[]): TerminalComponent => {
  const size = Math.ceil(row.length / 12);
  const spans: TerminalSpan[] = [];
  for (let i = 0; i < row.length; i += size) {
    const run = row.slice(i, i + size);
    const lit = run.find(cell => cell.fg !== null && cell.g !== ' ');
    spans.push({ text: run.map(cell => cell.g).join(''), ...(lit ? { fg: hex(lit.fg!) } : {}) });
  }
  return { type: 'line', id, label: 'Fire', spans };
};

const tint = (level: number): `#${string}` => hex(level > 0.75 ? RED : level > 0.45 ? ORANGE : GOLD);

export default function activate(api: ModAPI) {
  const saved = (): State => ({ ...EMPTY, ...object(api.state.get()) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const open = () => object(api.uiState.get()).open === true;

  const toast = (top: number) => api.host.tryCall('terminal.notice', {
    text: `${money(top)} burned this session ${compare(top, top)}`, kind: 'info', placement: 'toast', ttl_ms: 6000, id: 'burn_meter_threshold',
  });

  const refresh = (clear = false) => {
    const read = api.usage.rateLimits();
    const stored = api.host.tryCall('store.get', { key: 'lifetime', scope: 'user' });
    const state = saved();
    save({ ...state, ...(clear && state.demo !== null ? { demo: null, from: 0, rev: state.rev + 1 } : {}), limits: read.available ? windows(read.value) : state.limits,
      lifetime: stored.ok && stored.value ? Number(stored.value.value) || 0 : state.lifetime });
  };

  const addLifetime = (micro: number) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = api.host.tryCall('store.get', { key: 'lifetime', scope: 'user' });
      if (!read.ok) return null;
      const total = (Number(read.value?.value) || 0) + micro;
      if (api.host.tryCall('store.put', { key: 'lifetime', value: total, expected_revision: read.value?.revision ?? null, scope: 'user' }).ok) return total;
    }
    return null;
  };

  const note = (spend: Spend) => spend.unknown ? `cost unknown${spend.included ? ` · ${spend.included} included` : ''}` : spend.included ? 'included in plan' : 'no model turns yet';
  const extra = (spend: Spend) => [spend.included ? `${spend.included} included` : '', spend.unknown ? `${spend.unknown} unpriced` : ''].filter(Boolean).join(', ');
  const spendText = (spend: Spend) => spend.priced ? `${money(spend.micro / 1e6)} ${compare(spend.micro / 1e6, 0)}${extra(spend) ? ` (+${extra(spend)})` : ''}` : note(spend);

  const props = (state: State, id: string, rows: number, reduced: boolean): Props => ({
    id, rows, reduced, extra: extra(state.spend), from: state.from, goal: state.spend.micro / 1e6, demo: state.demo,
    level: state.demo === null && state.limits[0] ? Math.max(0.02, clamp(state.limits[0].used / 100)) : null,
    text: state.demo === null && !state.spend.priced ? note(state.spend) : null,
  });

  const aim = (s: Fire) => s.demo !== null ? demoUsd(Date.now() - s.demo) : s.goal;
  api.component<Fire, Props>('fire', {
    init: p => {
      const start = p.demo !== null ? demoUsd(Date.now() - p.demo) : p.goal;
      return { shown: p.demo !== null ? start : p.from, goal: p.goal, demo: p.demo, aim: start, frame: 0, fired: [], done: false };
    },
    every: {
      ms: s => s.shown !== aim(s) ? FRAME_MS : s.demo !== null && !s.done ? 500 : null,
      tick: (s, ui) => {
        const goal = aim(s);
        const hits = s.demo !== null ? crossed(s.aim, goal, s.fired) : [];
        const over = s.demo !== null && Date.now() - s.demo >= DEMO_MS + DEMO_HOLD_MS;
        if (hits.length) ui.post({ notice: hits[hits.length - 1]! });
        else if (over && !s.done) ui.post({ done: true });
        return { ...s, aim: goal, shown: ui.props.reduced ? goal : tween(s.shown, goal), frame: ui.props.reduced ? s.frame : s.frame + 1,
          fired: [...s.fired, ...hits], done: s.done || over };
      },
    },
    view: (s, ui) => {
      const p = ui.props;
      const level = p.level ?? heat(s.shown);
      const which = Math.floor(Date.now() / 6000) % THINGS.length;
      const spans: TerminalSpan[] = p.text !== null ? [{ text: p.text, tone: 'muted' }] : [
        { text: money(s.shown), bold: true, ...(s.shown !== s.goal ? { fg: tint(level) } : {}) },
        { text: ` ${compare(s.shown, which)}`, fg: hex(GOLD) },
        ...(p.extra ? [{ text: ` (+${p.extra})`, tone: 'muted' as const }] : []),
      ];
      const columns = Math.max(12, Math.min(ui.columns, 96));
      return [
        { type: 'line', id: `burn_${p.id}_money`, label: 'Session spend', spans },
        ...fireCells(columns, p.rows, level, s.frame * (FRAME_MS / 1000)).map((row, y) => fireLine(`burn_${p.id}_fire_${y}`, row)),
      ];
    },
  });

  api.on('component_post', ({ data }) => {
    const post = object(data);
    if (typeof post.notice === 'number') toast(post.notice);
    if (post.done === true) save({ ...saved(), demo: null, from: DEMO_TOP, rev: saved().rev + 1 });
  });

  api.on('model_response', response => {
    const state = saved();
    const key = `${response.request_id}#${response.attempt}`;
    if (response.synthetic || state.seen.includes(key)) return;
    const { microusd, basis } = response.cost;
    const priced = microusd !== null && (basis === 'settled' || basis === 'provider_reported');
    const spend: Spend = {
      micro: state.spend.micro + (priced ? microusd : 0), priced: state.spend.priced + (priced ? 1 : 0),
      included: state.spend.included + (basis === 'included_subscription' ? 1 : 0),
      unknown: state.spend.unknown + (!priced && basis !== 'included_subscription' ? 1 : 0),
    };
    const { tokens, served_model, requested_model } = api.usage.summarize(response);
    const model = served_model ?? requested_model ?? 'model';
    const was = state.models[model] ?? { input: 0, output: 0 };
    const models = { ...state.models, [model]: { input: was.input + (tokens.input ?? 0), output: was.output + (tokens.output ?? 0) } };
    const hits = crossed(state.spend.micro / 1e6, spend.micro / 1e6, state.fired);
    const lifetime = priced && microusd > 0 ? addLifetime(microusd) : null;
    save({ ...state, spend, models, seen: [...state.seen, key].slice(-SEEN_KEPT), fired: [...state.fired, ...hits], lifetime: lifetime ?? state.lifetime, from: state.spend.micro / 1e6, rev: state.rev + 1 });
    if (hits.length) toast(hits[hits.length - 1]!);
  });

  api.on('turn_start', () => save({ ...saved(), mark: saved().spend }));
  api.on('turn_end', () => {
    const state = saved();
    const from = state.mark ?? NONE;
    const micro = Math.max(0, state.spend.micro - from.micro);
    const turn: Turn = { usd: micro / 1e6, note: state.spend.unknown > from.unknown ? 'unknown' : state.spend.included > from.included && !micro ? 'included' : '' };
    save({ ...state, turns: [...state.turns, turn].slice(-TURNS_KEPT), mark: state.spend });
    refresh();
  });
  api.on('start', () => refresh(true));
  api.on('resume', () => refresh(true));

  const summary = (state: State) => {
    const limits = state.limits.length ? state.limits.map(l => `${l.name} ${Math.round(l.used)}%`).join(', ') : 'plan limits unavailable';
    const used = modelsLine(state.models, 6);
    return `This session: ${spendText(state.spend)}. ${limits}. Lifetime: ${money(state.lifetime / 1e6)}.${used ? `\nModels: ${used}` : ''}`;
  };

  api.command('burn', value => {
    const arg = String(value ?? '').trim().toLowerCase();
    const state = saved();
    if (arg === 'lifetime') return { display: `Lifetime burn: ${money(state.lifetime / 1e6)} ${compare(state.lifetime / 1e6, 2)}.` };
    if (arg === 'close') {
      api.uiState.set({ open: false });
      return null;
    }
    if (arg === 'hide') {
      save({ ...state, hidden: true });
      return { display: 'Burn meter hidden. /burn show brings it back.' };
    }
    if (arg === 'demo') {
      save({ ...state, hidden: false, demo: Date.now(), from: 0, rev: state.rev + 1 });
      api.uiState.set({ open: true });
      return { display: 'Burn demo: $0 to $30 in 20 seconds.' };
    }
    if (arg !== '' && arg !== 'panel' && arg !== 'show') return { display: 'usage: /burn [panel|show|hide|demo|lifetime]' };
    save({ ...state, hidden: false });
    if (arg !== 'show') api.uiState.set({ open: true });
    return { display: summary(saved()) };
  }, { description: 'Burn meter: /burn opens the panel; [panel|show|hide|demo|lifetime]', args_hint: '[panel|show|hide|demo|lifetime]' });

  const text = (id: string, label: string, lines: string[]): TerminalComponent => ({ type: 'text', id, label, text: lines.join('\n') });
  const button = (id: string, label: string, args: string): TerminalComponent => ({ type: 'button', id, label, text: label, action: { command: 'burn_meter:burn', args } });

  const band = (state: State, reduced: boolean, columns: number): TerminalComponent => {
    const now = Date.now();
    const level = state.demo === null && state.limits[0] ? Math.max(0.02, clamp(state.limits[0].used / 100)) : heat(state.spend.micro / 1e6);
    const color = tint(level);
    const left: TerminalSpan[][] = [
      [{ text: state.demo !== null ? 'DEMO' : 'BURN', bold: true, fg: color }],
      ...state.limits.map((l, i): TerminalSpan[] => [{ text: `${l.name} ${Math.round(l.used)}% ${resetsIn(l.resets, now)}`.trim(), ...(i === 0 ? { bold: true, fg: color } : { tone: 'muted' as const }) }]),
    ];
    return { type: 'box', id: 'burn_band', label: 'Burn meter', style: { direction: 'row', gap: 2, padding: [0, 1] }, children: [
      { type: 'box', id: 'burn_band_limits', label: 'Plan limits', children: left.map((spans, i) => ({ type: 'line' as const, id: `burn_band_limit_${i}`, label: 'Plan limit', spans })) },
      { type: 'box', id: 'burn_band_fuse', label: 'Burning fuse', flex: 1, min_width: 12, max_width: 64, children: [
        { type: 'module', id: `burn_band_fire_${state.rev}`, label: 'Burning fuse', module: 'fire', props: props(state, 'band', 3, reduced), height: 4 },
      ] },
      { type: 'box', id: 'burn_band_side', label: 'Lifetime', children: [
        { type: 'line', id: 'burn_band_models', label: 'Models', spans: [{ text: modelsLine(state.models, columns >= 140 ? 2 : 1) || 'no model turns yet', tone: 'muted' }] },
        { type: 'line', id: 'burn_band_lifetime', label: 'Lifetime', spans: [{ text: `lifetime ${money(state.lifetime / 1e6)}`, tone: 'muted' }] },
        button('burn_band_hide', 'hide', 'hide'),
      ] },
    ] };
  };

  const dialog = (state: State, reduced: boolean, columns: number): TerminalComponent => {
    const now = Date.now();
    const meter = Math.max(10, Math.min(40, columns - 40));
    const top = Math.max(0.01, ...state.turns.map(t => t.usd));
    const dollars = state.spend.micro / 1e6;
    const turns = state.turns.map((t, i) => `#${String(i + 1).padStart(2)}  ${t.usd || !t.note ? `${barText(meter, t.usd / top)} ${money(t.usd)}${t.note ? ` (+${t.note})` : ''}` : `(${t.note === 'included' ? 'included in plan' : 'cost unknown'})`}`);
    return { type: 'dialog', id: 'burn_dialog', label: 'Burn meter', title: state.demo !== null ? 'Burn meter (demo)' : 'Burn meter', children: [
      text('burn_dialog_head', 'Session', [`Session: ${spendText(state.spend)}`, `Lifetime: ${money(state.lifetime / 1e6)} (priced requests only)`,
        ...(modelsLine(state.models, 6) ? [`Models: ${modelsLine(state.models, 6)}`] : [])]),
      { type: 'module', id: `burn_dialog_fire_${state.rev}`, label: 'Burning fuse', module: 'fire', props: props(state, 'dialog', 6, reduced), height: 7 },
      ...(state.limits.length ? [text('burn_dialog_limits', 'Limits', state.limits.map(l => `${l.name.padEnd(4)} ${barText(meter, l.used / 100)} ${Math.round(l.used)}% ${resetsIn(l.resets, now)}`.trimEnd()))] : []),
      text('burn_dialog_turns', 'Per turn', turns.length ? turns : ['No finished turns yet.']),
      ...(state.spend.priced ? [text('burn_dialog_things', 'That is', THINGS.map((_, i) => compare(dollars, i)))] : []),
      { type: 'box', id: 'burn_dialog_buttons', label: 'Actions', style: { direction: 'row', gap: 2 }, children: [
        button('burn_dialog_toggle', state.hidden ? 'show band' : 'hide band', state.hidden ? 'show' : 'hide'),
        button('burn_dialog_close', 'close', 'close'),
      ] },
    ] };
  };

  api.on('terminal', input => {
    const state = saved();
    const reduced = input.client?.reduced_motion === true;
    const seen = state.spend.priced + state.spend.included + state.spend.unknown > 0 || state.limits.length > 0 || state.demo !== null;
    const sites: NonNullable<TerminalView['sites']> = {};
    if (seen && !state.hidden) sites.above_composer = { mode: 'wrap', components: [{ type: 'slot' }, band(state, reduced, input.client?.columns ?? 80)] };
    if (open()) sites.dialog = { mode: 'replace', components: [dialog(state, reduced, input.client?.columns ?? 80)] };
    return { sites };
  });
}
