import type { Json, TerminalSpan, TerminalTone } from '../../api.d.ts';

export const SEGMENTS = ['model', 'effort', 'provider', 'context', 'tokens', 'cache', 'cost', 'limits', 'git', 'changes', 'pr', 'ci', 'session', 'tools', 'agents', 'plan', 'cwd', 'omd'] as const;
export const PRESETS = {
  compact: 'model context limits cost cache git omd',
  detailed: 'model effort provider context tokens cache cost limits; git changes pr ci session tools agents plan omd',
};
export type Mods = { installed: number; enabled: number; active: number; failed?: number };
const TONES: TerminalTone[] = ['normal', 'accent', 'success', 'attention', 'failure', 'muted'];
const MAX_LINES = 4;

export type Settings = {
  placement: 'below' | 'above'; preset: 'compact' | 'detailed' | 'custom'; layout: string; hidden: string; glyphs: 'unicode' | 'ascii'; bars: boolean;
  thresholds: string; tones: string; github: boolean; refresh_s: number; scripts: string;
};
export const DEFAULTS: Settings = {
  placement: 'below', preset: 'compact', layout: PRESETS.detailed, hidden: '', glyphs: 'unicode', bars: true,
  thresholds: 'context=70,90 limits=70,90 cost=5,20', tones: '', github: true, refresh_s: 30, scripts: '',
};
export type Script = { id: string; command: string[]; interval_s: number; timeout_ms: number };

export type Charge = 'billed' | 'estimate' | 'included' | 'pending' | 'unknown' | 'none';
export type Git = {
  key: string; branch: string | null; oid: string | null; ahead: number; behind: number; staged: number; unstaged: number; untracked: number; conflicts: number;
  added: number; removed: number; worktree: string | null; remote: { owner: string; repo: string } | null; error: string | null;
};
export type GithubStatus = 'idle' | 'loading' | 'ok' | 'auth' | 'offline' | 'rate_limited' | 'error';
export type Pull = { number: number; title: string; url: string; state: string; draft: boolean; review: string | null; merge: string | null };
export type Checks = { state: string; passed: number; failed: number; pending: number; url: string | null };
export type Github = { key: string | null; status: GithubStatus; at: number | null; next: number; failures: number; pr: Pull | null; ci: Checks | null; detail: string | null };
export type ScriptResult = { spec: string; at: number; status: 'ok' | 'failed' | 'timeout' | 'empty'; spans: TerminalSpan[] };
export type Data = {
  thread: string | null; started: number | null; cwd: string | null;
  model: { requested: string | null; served: string | null; effort: string | null; provider: string | null; billing: Charge | null };
  context: { used: number | null; window: number | null; compactions: number; at: number | null; compacted: number | null; reverted: number | null; switched: boolean };
  tokens: { input: number; output: number; reasoning: number; cached: number; write: number; requests: number };
  cache: { ratio: number | null; expires: number | null };
  cost: Record<Exclude<Charge, 'none'>, number>;
  seen: Record<string, [number, number, number, number, number, Charge, number]>;
  limits: { minutes: number | null; used: number; resets: number | null }[]; credits: string | null;
  tools: Record<string, number>; agents: Record<string, string>; plan: { done: number; total: number; step: string | null } | null;
  git: Git | null; github: Github; scripts: Record<string, ScriptResult>; tick: number; beat: number | null; armed: string | null; viewport: { columns: number; rows: number } | null; mods: Mods | null;
  pending: { from: string[]; to: Settings; turns: number } | null;
};
export const EMPTY: Data = {
  thread: null, started: null, cwd: null, model: { requested: null, served: null, effort: null, provider: null, billing: null },
  context: { used: null, window: null, compactions: 0, at: null, compacted: null, reverted: null, switched: false },
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, write: 0, requests: 0 }, cache: { ratio: null, expires: null },
  cost: { billed: 0, estimate: 0, included: 0, pending: 0, unknown: 0 }, seen: {}, limits: [], credits: null, tools: {}, agents: {}, plan: null,
  git: null, github: { key: null, status: 'idle', at: null, next: 0, failures: 0, pr: null, ci: null, detail: null }, scripts: {}, tick: 0, beat: null, armed: null, viewport: null, mods: null, pending: null,
};

export const visible = (value: string, limit = 160) => value.replace(/[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').slice(0, limit);
const cells = (char: string) => /\p{M}|\u200D|\uFE0F/u.test(char) ? 0
  : /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u.test(char) ? 2 : 1;
const width = (text: string) => [...text].reduce((sum, char) => sum + cells(char), 0);
const clip = (text: string, max: number) => {
  if (width(text) <= max) return text;
  let kept = '';
  let used = 0;
  for (const char of text) {
    if (used + cells(char) > max - 1) break;
    kept += char;
    used += cells(char);
  }
  return `${kept}…`;
};
export const count = (n: number) => n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
export const usd = (value: number) => `$${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
export const span = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.round(minutes / 1440)}d`;
};
const windowName = (minutes: number | null) => minutes === null ? 'limit' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

export function settings(raw: Readonly<Record<string, Json>>, fallback: Settings = DEFAULTS): Settings {
  const pick = <K extends keyof Settings>(key: K, valid: (value: Json) => boolean) => (valid(raw[key]) ? raw[key] : fallback[key]) as Settings[K];
  const text = (value: Json) => typeof value === 'string' && value.length <= 2048;
  return {
    placement: pick('placement', value => value === 'below' || value === 'above'),
    preset: pick('preset', value => value === 'compact' || value === 'detailed' || value === 'custom'),
    layout: pick('layout', text), hidden: pick('hidden', text), thresholds: pick('thresholds', text), tones: pick('tones', text), scripts: pick('scripts', text),
    glyphs: pick('glyphs', value => value === 'unicode' || value === 'ascii'),
    bars: pick('bars', value => typeof value === 'boolean'), github: pick('github', value => typeof value === 'boolean'),
    refresh_s: Math.min(3600, Math.max(5, Math.round(pick('refresh_s', value => typeof value === 'number' && Number.isFinite(value))))),
  };
}

export function scripts(text: string): { scripts: Script[]; error: string | null } {
  if (!text.trim()) return { scripts: [], error: null };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { scripts: [], error: 'scripts is not valid JSON' }; }
  if (!Array.isArray(parsed)) return { scripts: [], error: 'scripts must be a JSON array' };
  const list: Script[] = [];
  for (const item of parsed.slice(0, 4)) {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const command = Array.isArray(entry.command) && entry.command.length && entry.command.every(part => typeof part === 'string' && part.length <= 2048) ? entry.command as string[] : null;
    if (typeof entry.id !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(entry.id) || !command || list.some(script => script.id === entry.id)) return { scripts: list, error: 'each script needs a unique id (a-z, 0-9, _ or -) and a command array' };
    const interval = typeof entry.interval_s === 'number' ? entry.interval_s : 30;
    const timeout = typeof entry.timeout_ms === 'number' ? entry.timeout_ms : 2000;
    list.push({ id: entry.id, command: command.slice(0, 32), interval_s: Math.min(3600, Math.max(5, Math.round(interval))), timeout_ms: Math.min(5000, Math.max(100, Math.round(timeout))) });
  }
  return { scripts: list, error: parsed.length > 4 ? 'at most 4 scripts run' : null };
}

export function layout(config: Settings, known: string[] = []): string[][] {
  const hidden = new Set(config.hidden.split(/\s+/).filter(Boolean));
  const valid = (id: string) => (SEGMENTS as readonly string[]).includes(id) || id.startsWith('script:') && known.includes(id.slice(7));
  const source = config.preset === 'custom' ? config.layout : PRESETS[config.preset];
  return source.split(';').map(line => [...new Set(line.split(/\s+/).filter(id => id && valid(id) && !hidden.has(id)))].slice(0, 16)).filter(line => line.length).slice(0, MAX_LINES);
}

export function thresholds(text: string): Record<string, [number, number]> {
  const result: Record<string, [number, number]> = {};
  for (const [, name, warn, alert] of text.matchAll(/([a-z]+)=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g)) result[name] = [Number(warn), Number(alert)];
  return result;
}

export function tones(text: string): Record<string, TerminalTone> {
  const result: Record<string, TerminalTone> = {};
  for (const [, name, tone] of text.matchAll(/([a-z0-9:_-]+)=([a-z]+)/g)) if ((TONES as string[]).includes(tone)) result[name] = tone as TerminalTone;
  return result;
}

export const charge = (basis: string, microusd: number | null, reported: { usd: number; basis: string } | null): [Charge, number] =>
  basis === 'synthetic' ? ['none', 0]
    : reported?.basis === 'provider_billed' ? ['billed', reported.usd]
    : basis === 'provider_reported' && microusd !== null ? ['billed', microusd / 1e6]
    : basis === 'settled' && microusd !== null ? ['estimate', microusd / 1e6]
    : basis === 'unsettled' ? ['pending', 0]
    : basis === 'included_subscription' ? ['included', 0]
    : ['unknown', 0];

export const githubKey = (git: Git | null) => git?.remote && git.branch ? `${git.remote.owner}/${git.remote.repo}#${git.branch}` : null;

type Part = TerminalSpan[] | null;
type Env = { data: Data; config: Settings; now: number; ascii: boolean; limits: Record<string, [number, number]>; cwd: string | null; settled: number | null; mods: Mods | null; single: boolean };

const level = (env: Env, name: string, value: number): TerminalTone => {
  const [warn, alert] = env.limits[name] ?? [Infinity, Infinity];
  return value >= alert ? 'failure' : value >= warn ? 'attention' : 'success';
};
const bar = (env: Env, ratio: number, tone: TerminalTone): TerminalSpan[] => {
  if (!env.config.bars) return [];
  const filled = Math.max(0, Math.min(8, Math.round(ratio * 8)));
  return env.ascii ? [{ text: `[${'#'.repeat(filled)}${'-'.repeat(8 - filled)}] `, tone }] : [{ text: '█'.repeat(filled), tone }, { text: `${'░'.repeat(8 - filled)} `, tone: 'muted' }];
};

const parts: Record<string, (env: Env) => Part> = {
  model: ({ data }) => {
    const { requested, served } = data.model;
    if (!requested && !served) return null;
    return [{ text: served && requested && served !== requested ? `${requested}→${served}` : (served ?? requested)!, bold: true }];
  },
  effort: ({ data }) => data.model.effort ? [{ text: data.model.effort, tone: 'muted' }] : null,
  provider: ({ data }) => {
    if (!data.model.provider) return null;
    const billing = { billed: 'billed', estimate: 'API est.', included: 'subscription', pending: 'unsettled', unknown: 'unpriced', none: null }[data.model.billing ?? 'none'];
    return [{ text: data.model.provider }, ...billing ? [{ text: ` ${billing}`, tone: 'muted' as const }] : []];
  },
  context: env => {
    const { used, window, compactions, at, compacted, reverted, switched } = env.data.context;
    if (used === null) return null;
    const stale = switched || at !== null && (compacted !== null && compacted > at || reverted !== null && reverted > at);
    const mark = compactions ? [{ text: env.ascii ? ` c${compactions}` : ` ⟳${compactions}`, tone: 'muted' as const }] : [];
    if (!window) return [{ text: `${stale ? '~' : ''}${count(used)} ctx`, tone: stale ? 'muted' : 'normal' }, ...mark];
    const ratio = used / window;
    const tone = stale ? 'muted' : level(env, 'context', ratio * 100);
    return [...bar(env, ratio, tone), { text: `${stale ? '~' : ''}${Math.round(ratio * 100)}%`, tone }, { text: ` ${count(Math.max(0, window - used))} left`, tone: 'muted' }, ...mark];
  },
  tokens: ({ data, ascii }) => data.tokens.requests ? [{ text: ascii ? `in ${count(data.tokens.input)} out ${count(data.tokens.output)}` : `↑${count(data.tokens.input)} ↓${count(data.tokens.output)}` },
    ...data.tokens.reasoning ? [{ text: ` r${count(data.tokens.reasoning)}`, tone: 'muted' as const }] : [], ...data.tokens.cached ? [{ text: ` c${count(data.tokens.cached)}`, tone: 'muted' as const }] : []] : null,
  cache: ({ data, now }) => data.cache.ratio === null ? null : [{ text: `cache ${Math.round(data.cache.ratio * 100)}%` },
    ...data.cache.expires !== null && data.cache.expires > now ? [{ text: ` ${span(data.cache.expires - now)}`, tone: 'muted' as const }] : []],
  cost: env => {
    const { billed, estimate, included, pending, unknown } = env.data.cost;
    const total = Math.max(env.settled ?? 0, billed + estimate);
    if (!total && !included && !pending && !unknown) return null;
    if (!total) return [{ text: included ? 'included' : pending ? 'cost pending' : 'cost unknown', tone: 'muted' }];
    return [{ text: `${estimate ? '~' : ''}${usd(total)}`, tone: level(env, 'cost', total) }, ...estimate && !billed ? [{ text: ' est.', tone: 'muted' as const }] : [],
      ...pending || unknown ? [{ text: ' +?', tone: 'muted' as const }] : []];
  },
  limits: env => {
    const windows = env.data.limits.filter(item => item.resets === null || item.resets > env.now);
    if (!windows.length) return null;
    const shown = env.single ? [windows.reduce((a, b) => b.used > a.used ? b : a)] : windows;
    return shown.flatMap((item, index) => [...index ? [{ text: ' ' }] : [], { text: `${windowName(item.minutes)} ` }, { text: `${Math.round(item.used)}%`, tone: level(env, 'limits', item.used) },
      ...item.resets !== null ? [{ text: env.ascii ? ` r${span(item.resets - env.now)}` : ` ↻${span(item.resets - env.now)}`, tone: 'muted' as const }] : []]);
  },
  git: ({ data, ascii, cwd }) => {
    const git = data.git;
    if (!git || git.error || cwd !== null && git.key !== cwd) return null;
    const dirty = git.staged + git.unstaged + git.untracked + git.conflicts > 0;
    const head = git.branch ?? (git.oid ? `@${git.oid.slice(0, 7)}` : 'no commits');
    return [{ text: `${ascii ? '' : '⎇ '}${head}${dirty ? '*' : ''}`, tone: git.conflicts ? 'failure' : dirty ? 'attention' : 'normal' },
      ...git.ahead || git.behind ? [{ text: ascii ? ` +${git.ahead}/-${git.behind}` : ` ↑${git.ahead}↓${git.behind}`, tone: 'muted' as const }] : [],
      ...git.worktree ? [{ text: ` wt:${git.worktree}`, tone: 'muted' as const }] : []];
  },
  changes: ({ data, cwd }) => {
    const git = data.git;
    if (!git || git.error || cwd !== null && git.key !== cwd) return null;
    const files = git.staged + git.unstaged + git.untracked;
    return files || git.added || git.removed ? [{ text: `+${git.added}`, tone: 'success' }, { text: ` -${git.removed}`, tone: 'failure' }, { text: ` ${files}f`, tone: 'muted' }] : null;
  },
  pr: ({ data, ascii, config }) => {
    const github = data.github;
    if (github.status === 'idle' || !config.github) return null;
    if (github.status === 'auth') return [{ text: 'PR: /statusline github', tone: 'muted' }];
    if (github.status === 'loading') return [{ text: 'PR …', tone: 'muted' }];
    if (github.status !== 'ok') return [{ text: `PR ${github.status === 'rate_limited' ? 'rate-limited' : github.status}`, tone: 'muted' }, ...github.pr ? [{ text: ` #${github.pr.number}`, tone: 'muted' as const, link: github.pr.url }] : []];
    const pr = github.pr;
    if (!pr) return [{ text: 'no PR', tone: 'muted' }];
    const state = pr.state === 'MERGED' ? ['merged', 'accent'] : pr.state === 'CLOSED' ? ['closed', 'muted'] : pr.draft ? ['draft', 'muted'] : ['open', 'success'];
    const review = { APPROVED: [ascii ? 'approved' : '✓ approved', 'success'], CHANGES_REQUESTED: ['changes requested', 'failure'], REVIEW_REQUIRED: ['review required', 'attention'] }[pr.review ?? ''];
    const merge = pr.state === 'OPEN' && pr.merge && ['DIRTY', 'BLOCKED', 'BEHIND'].includes(pr.merge) ? pr.merge.toLowerCase() : null;
    return [{ text: `PR #${pr.number}`, bold: true, link: pr.url }, { text: ` ${state[0]}`, tone: state[1] as TerminalTone },
      ...review ? [{ text: ` ${review[0]}`, tone: review[1] as TerminalTone }] : [], ...merge ? [{ text: ` ${merge}`, tone: 'attention' as const }] : []];
  },
  ci: ({ data, ascii, config }) => {
    const ci = data.github.status === 'ok' && config.github ? data.github.ci : null;
    if (!ci) return null;
    const link = ci.url ?? undefined;
    if (ci.failed) return [{ text: `CI ${ascii ? 'x' : '✗'} ${ci.failed}`, tone: 'failure', link }];
    if (ci.pending) return [{ text: `CI ${ascii ? '...' : '●'} ${ci.pending}`, tone: 'attention', link }];
    return [{ text: `CI ${ascii ? 'ok' : '✓'}`, tone: 'success', link }];
  },
  session: ({ data, now }) => data.thread ? [{ text: data.thread.slice(0, 8), tone: 'muted' }, ...data.started !== null ? [{ text: ` ${span(now - data.started)}` }] : []] : null,
  tools: ({ data, ascii }) => {
    const running = Object.keys(data.tools).length;
    return running ? [{ text: `${ascii ? 'tools ' : '⚒ '}${running}`, tone: 'accent' }] : null;
  },
  agents: ({ data }) => {
    const states = Object.values(data.agents);
    const running = states.filter(state => state === 'running' || state === 'started' || state === 'pending').length;
    return states.length ? [{ text: `agents ${running}/${states.length}`, tone: running ? 'accent' : 'muted' }] : null;
  },
  plan: ({ data }) => data.plan ? [{ text: `plan ${data.plan.done}/${data.plan.total}`, tone: data.plan.done === data.plan.total ? 'success' : 'normal' }, ...data.plan.step ? [{ text: ` ${clip(data.plan.step, 32)}`, tone: 'muted' as const }] : []] : null,
  cwd: ({ cwd }) => cwd ? [{ text: cwd.split('/').filter(Boolean).at(-1) ?? '/', tone: 'muted' }] : null,
  omd: ({ mods }) => mods ? [{ text: `${mods.active} mod${mods.active === 1 ? '' : 's'} on`, tone: 'muted' },
    ...mods.failed ? [{ text: ` ${mods.failed} failed · /omd`, tone: 'failure' as const }] : []] : null,
};

const script = (env: Env, id: string, spec: string | undefined): Part => {
  const result = env.data.scripts[id];
  if (!result || result.spec !== spec) return null;
  if (result.status === 'ok') return result.spans;
  return result.status === 'empty' ? null : [{ text: `${id}: ${result.status === 'timeout' ? 'timed out' : 'failed'}`, tone: 'muted' }];
};

export function render(data: Data, config: Settings, input: { now: number; columns: number; cwd: string | null; settled: number | null }): TerminalSpan[][] {
  const configured = scripts(config.scripts).scripts;
  const specs = Object.fromEntries(configured.map(item => [item.id, JSON.stringify(item)]));
  const rows = layout(config, configured.map(item => item.id));
  const env: Env = { data, config, now: input.now, ascii: config.glyphs === 'ascii', limits: { ...thresholds(DEFAULTS.thresholds), ...thresholds(config.thresholds) },
    cwd: input.cwd, settled: input.settled, mods: data.mods, single: rows.length === 1 };
  const custom = tones(config.tones);
  const separator: TerminalSpan = { text: env.ascii ? ' | ' : ' · ', tone: 'muted' };
  const columns = Math.max(10, input.columns);
  return rows.map(ids => {
    const pieces = ids.map(id => {
      const spans = id.startsWith('script:') ? script(env, id.slice(7), specs[id.slice(7)]) : parts[id](env);
      const tone = custom[id];
      return spans?.length ? spans.map(item => ({ ...item, text: visible(item.text, 256), ...tone && !item.tone ? { tone } : {} })) : null;
    }).filter((spans): spans is TerminalSpan[] => spans !== null);
    const join = (list: TerminalSpan[][]) => list.flatMap((spans, index) => index ? [separator, ...spans] : spans);
    while (pieces.length > 1 && width(join(pieces).map(item => item.text).join('')) > columns) pieces.pop();
    let room = columns;
    return pack(join(pieces).map(item => {
      const text = room > 0 ? clip(item.text, room) : '';
      room -= width(text);
      return { ...item, text };
    }).filter(item => item.text));
  }).filter(line => line.length);
}

const MAX_SPANS = 12;
// The view refuses a span over 256 bytes, so merged spans are split there.
const SPAN_BYTES = 256;
const utf8 = new TextEncoder();
const cut = (text: string) => text.slice(0, utf8.encodeInto(text, new Uint8Array(SPAN_BYTES)).read);
const split = (item: TerminalSpan): TerminalSpan[] => {
  const parts: TerminalSpan[] = [];
  let rest = item.text;
  while (utf8.encode(rest).length > SPAN_BYTES) {
    const head = cut(rest);
    parts.push({ ...item, text: head });
    rest = rest.slice(head.length);
  }
  return [...parts, { ...item, text: rest }];
};
const style = (item: TerminalSpan) => JSON.stringify([item.tone ?? 'normal', item.bold, item.italic, item.underline, item.fg, item.bg, item.link]);
export function pack(spans: TerminalSpan[]): TerminalSpan[] {
  const merged: TerminalSpan[] = [];
  for (const item of spans) {
    const last = merged.at(-1);
    if (last && style(last) === style(item)) merged[merged.length - 1] = { ...last, text: last.text + item.text };
    else merged.push(item);
  }
  const parts = merged.flatMap(split);
  return parts.length <= MAX_SPANS ? parts : [...parts.slice(0, MAX_SPANS - 1), { text: cut(parts.slice(MAX_SPANS - 1).map(item => item.text).join('')), tone: 'muted' }];
}
