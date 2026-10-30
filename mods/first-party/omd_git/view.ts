import type { TerminalClient, TerminalComponent, TerminalSpan, TerminalTone } from '../../api.d.ts';
import { DOING, ago, cut, headline, size } from './git.ts';
import type { Branch, Change, Commit, Head, Operation, Stash } from './git.ts';

export type Hunk = { staged: boolean; header: string; line: number };
export type Repo = {
  dir: string; top: string; gitdir: string; error: string | null; notice: string | null;
  panel: number; sel: number[]; head: Head; op: Operation | null; files: Change[]; more?: boolean; branches: Branch[]; commits: Commit[]; stash: Stash[];
  hunks: { path: string; list: Hunk[] } | null; hunk: number; main: string; scroll: number; signin?: boolean; echo?: number;
};
export type Area = { columns: number; rows: number };

export const SITE = 'omd_git/main';
export const SIGNIN = 'omd_git_signin';
export const PANELS = ['Status', 'Files', 'Local branches', 'Commits', 'Stash'];
const LIST = 'omd_git_list';
const MAIN = 'omd_git_main';
const HINTS = [
  'Push: P | Pull: p | Refresh: R | Keybindings: ?',
  'Stage: Space | All: a | Hunks: Enter | Commit: c | Amend: A | Stash: s | Discard: d | Edit: e | Keybindings: ?',
  'Checkout: Space | New: n | Delete: d | Push: P | Pull: p | Keybindings: ?',
  'Reword: r | Amend: A | Add to prompt: @ | Keybindings: ?',
  'Apply: Space | Pop: g | Drop: d | Keybindings: ?',
];
const HUNK_HINT = 'Stage hunk: Space | Discard hunk: d | Back: Esc | Add to prompt: @ | Keybindings: ?';
const EMPTY = ['', 'No changes', 'No branches', 'No commits', 'No stashes'];
const MAIN_TITLES = ['Log', 'Diff', 'Log', 'Patch', 'Stash'];

const SIDE_BY_SIDE = 85;
const SHORT = 3;
const TALL = 10;
const BORDER = 2;
const NOTICE_ROWS = 1;
const MAX_ROWS = 100;
const WINDOW = 80;
const SIGNIN_ROWS = 10;
const LINE_BYTES = 200;
const TITLE_BYTES = 120;
const BUDGET = 56_000;
const DOCKED = 84;
const DOCK_SHARE = 1 / 3;
const DOCK_CHROME = 3;
const BAND_SHARE = 0.4;

const lists = (r: Repo): unknown[][] => [[r.head], r.files, r.branches, r.commits, r.stash];
export const rows = (r: Repo) => lists(r)[r.panel];
export const selected = (r: Repo) => Math.min(r.sel[r.panel], Math.max(0, rows(r).length - 1));

export const area = (client: TerminalClient | null | undefined): Area => {
  const own = client?.sites?.[SITE];
  if (own) return own;
  const columns = client?.columns ?? 160;
  const height = client?.rows ?? 40;
  if (columns >= DOCKED) return { columns: Math.floor(columns * DOCK_SHARE), rows: height - DOCK_CHROME };
  return { columns, rows: Math.floor(height * BAND_SHARE) };
};

const tone = (line: string): TerminalTone | undefined => {
  if (/^(diff --git|index |--- |\+\+\+ |commit |stash@)/.test(line)) return 'muted';
  if (line.startsWith('@@')) return 'accent';
  if (line.startsWith('+')) return 'success';
  if (line.startsWith('-')) return 'failure';
  return undefined;
};
const span = (text: string, extra: Partial<TerminalSpan> = {}): TerminalSpan => ({ text: cut(text, LINE_BYTES), ...extra });
const line = (id: string, spans: TerminalSpan[]): TerminalComponent => ({ type: 'line', id: `omd_git_${id}`, label: id, spans });
const frame = (id: string, title: string, active: boolean, children: TerminalComponent[], flex?: number): TerminalComponent => ({
  type: 'box', id: `omd_git_${id}_box`, label: cut(title, TITLE_BYTES), title: cut(title, TITLE_BYTES), style: { border: active ? 'thick' : 'rounded' }, children, ...(flex ? { flex } : {}),
});

const listLines = (r: Repo, panel: number, now: number, from: number, count: number): TerminalSpan[][] => {
  const active = panel === r.panel;
  const mark = (index: number) => span(active && index === (r.hunks ? r.hunk : selected(r)) ? '▶ ' : '  ', { tone: 'accent' });
  const each = <T>(items: T[], row: (item: T) => TerminalSpan[]) => items.slice(from, from + count).map((item, index) => [mark(from + index), ...row(item)]);
  if (panel === 1 && r.hunks) return each(r.hunks.list, h => [span(h.staged ? 'staged   ' : 'unstaged ', { tone: h.staged ? 'success' : 'attention' }), span(h.header)]);
  if (panel === 0) {
    const doing = r.op ? [span(` (${DOING[r.op]})`, { tone: 'attention', bold: true })] : [];
    return [[span(`${r.top.split('/').at(-1)} → `, { tone: 'muted' }), span(headline(r.head), { bold: true }), ...doing]];
  }
  if (panel === 1) return each(r.files, f => [span(f.x, { tone: f.x === '?' ? 'failure' : 'success' }), span(f.y, { tone: 'failure' }), span(` ${f.orig ? `${f.orig} → ` : ''}${f.path}`)]);
  if (panel === 2) return each(r.branches, b => [span(b.head ? '* ' : '  ', { tone: 'success' }), span(b.name, { bold: b.head }), span(b.track ? ` ${b.track}` : '', { tone: 'muted' })]);
  if (panel === 3) return each(r.commits, c => [span(`${c.sha} `, { tone: 'attention' }), span(c.subject), span(`  ${c.author}, ${ago(c.at, now)}`, { tone: 'muted' })]);
  return each(r.stash, s => [span(`${s.ref} `, { tone: 'attention' }), span(s.subject)]);
};

const side = (r: Repo, panel: number, collapsed: number, tall: number, now: number): [TerminalComponent, number] => {
  const total = (panel === 1 && r.hunks ? r.hunks.list : lists(r)[panel]).length;
  const empty = [[span(EMPTY[panel], { tone: 'muted' })]];
  const title = `[${panel + 1}] ${panel === 1 && r.hunks ? `Hunks of ${r.hunks.path}` : PANELS[panel]}`;
  if (panel !== r.panel) {
    const at = Math.max(0, Math.min(r.sel[panel], total - 1));
    const from = Math.max(0, Math.min(at - 1, total - collapsed));
    const shown = listLines(r, panel, now, from, collapsed);
    const height = Math.max(1, shown.length);
    const document: TerminalComponent = { type: 'document', id: `omd_git_side${panel}`, label: PANELS[panel], lines: shown.length ? shown : empty, keys: true, height };
    return [frame(`side${panel}`, title, false, [document]), height + BORDER];
  }
  const at = r.hunks ? r.hunk : selected(r);
  const height = panel === 0 ? 1 : Math.max(SHORT, Math.min(total, tall));
  const from = Math.max(0, Math.min(at - WINDOW / 2, total - WINDOW));
  const shown = listLines(r, panel, now, from, WINDOW);
  const document: TerminalComponent = { type: 'document', id: LIST, label: PANELS[panel], lines: shown.length ? shown : empty, keys: true, height, selected: { start: at - from, end: at - from } };
  return [frame(`side${panel}`, title, true, [document]), height + BORDER];
};

const mainLines = (r: Repo, budget: number) => {
  const all = r.main.split('\n');
  const kept: TerminalSpan[][] = [];
  let room = budget;
  for (const text of all.slice(Math.min(r.scroll, Math.max(0, all.length - 1)))) {
    const kind = tone(text);
    const row = [span(text || ' ', kind ? { tone: kind } : {})];
    room -= size(row) + 1;
    if (room < 0) break;
    kept.push(row);
  }
  return kept;
};

export const draw = (r: Repo | undefined, where: Area, now: number): TerminalComponent[] => {
  if (!r?.top) return [line('missing', [span(r?.error ?? 'Not loaded yet', { tone: 'muted' })]), line('hints', [span('Refresh: R', { tone: 'muted' })])];
  const wide = where.columns >= SIDE_BY_SIDE;
  const collapsed = (panel: number) => (panel === 0 || !wide ? 1 : SHORT);
  const others = PANELS.reduce((total, _, panel) => (panel === r.panel ? total : total + collapsed(panel) + BORDER), 0);
  const free = where.rows - NOTICE_ROWS - others - BORDER;
  const tall = Math.max(SHORT, wide ? free : Math.min(TALL, free - SHORT - BORDER));
  const sides = PANELS.map((_, panel) => side(r, panel, collapsed(panel), tall, now));
  const panels = sides.map(([component]) => component);
  const used = sides.reduce((total, [, height]) => total + height, 0);
  const height = Math.min(MAX_ROWS, Math.max(SHORT, wide ? used - BORDER : where.rows - NOTICE_ROWS - used - BORDER));
  const main = mainLines(r, BUDGET - size(panels));
  const padding = Array.from({ length: Math.max(0, height - main.length) }, () => [span(' ')]);
  const untracked = r.panel === 1 && r.files[selected(r)]?.kind === '?';
  const title = r.signin ? 'Sign in' : r.hunks ? 'Patch' : untracked ? 'Untracked file' : MAIN_TITLES[r.panel];
  const body: TerminalComponent = r.signin
    ? { type: 'terminal', id: SIGNIN, label: 'Sign in', session: 'signin', height: SIGNIN_ROWS }
    : { type: 'document', id: MAIN, label: 'Main view', lines: [...main, ...padding], keys: true, height };
  const layout: TerminalComponent = wide
    ? { type: 'box', id: 'omd_git_layout', label: 'Git', style: { direction: 'row' }, children: [{ type: 'box', id: 'omd_git_sides', label: 'Panels', flex: 2, children: panels }, frame('main', title, false, [body], 3)] }
    : { type: 'box', id: 'omd_git_layout', label: 'Git', children: [...panels, frame('main', title, false, [body])] };
  const hint = `${r.op ? `${DOING[r.op]}: continue or abort with m | ` : ''}${r.hunks ? HUNK_HINT : HINTS[r.panel]}`;
  const message = r.error ?? r.notice;
  return [layout, message ? line('notice', [span(message, { tone: r.error ? 'failure' : 'attention' })]) : line('hints', [span(hint, { tone: 'muted' })])];
};
