import type { Json, ModAPI } from '../../api.d.ts';

type Files = { tick: number; files: Record<string, [number, number]> };
type Status = { at: number; prefix?: string; head?: string; boosts: [string, number, number?][]; recent?: [string, number][] };

const LIMIT = 50;
const KEPT = 512;
const HALF_LIFE = 64;
const STAT_BATCH = 64;
const STAT_BATCHES = 4;
const STORED = 32_000;
const STATUS_BYTES = 12_000;
const LOG_BYTES = 6_000;
const ENTRY_BYTES = 8_000;
const STATUS_TTL_MS = 30_000;
const DIRTY_STATS = 64;
const RECENT_COMMITS = 10;
const HUGE_COMMIT = 50;
const MODIFIED = [[120_000, 16], [900_000, 8], [3_600_000, 4], [86_400_000, 2], [604_800_000, 1]];
const DEFAULT_BRANCHES = ['remotes/origin/HEA[D]', 'remotes/origin/mai[n]', 'remotes/origin/maste[r]', 'heads/mai[n]', 'heads/maste[r]'].map(ref => `--glob=refs/${ref}`);

const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const fit = <T,>(items: T[], room: number) => {
  let bytes = 2;
  return items.filter(item => (bytes += serializedBytes(item) + 1) <= room);
};

function common(query: string, path: string): number {
  let row = new Array<number>(path.length + 1).fill(0);
  for (const character of query) {
    const next = [0];
    for (let index = 0; index < path.length; index++) next.push(character === path[index] ? row[index] + 1 : Math.max(row[index + 1], next[index]));
    row = next;
  }
  return row[path.length];
}

// Smart case; tiers: exact name with or without extension, name prefix, name substring, path substring, subsequence, then up to one typo per four query characters.
function fuzzy(query: string, path: string): number | null {
  if (!query) return 0;
  const exact = query !== query.toLowerCase();
  const [q, p] = exact ? [query, path] : [query.toLowerCase(), path.toLowerCase()];
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (name === q || name.replace(/\.[^.]*$/, '') === q) return 110;
  if (name.startsWith(q)) return 100;
  if (name.includes(q)) return 90;
  if (p.includes(q)) return 80;
  const typos = q.length - common(q, p);
  if (typos > Math.floor(q.length / 4)) return null;
  return (typos ? 50 - typos * 10 : 60) + (common(q, name) === q.length ? 10 : 0);
}

const unquote = (quoted: string) => {
  try {
    return JSON.parse(`"${quoted}"`) as string;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return quoted;
  }
};
const mentioned = (text: string) => [...new Set([...text.matchAll(/@?"((?:[^"\\\n]|\\.){1,256})"|(\S{1,256})/g)]
  .map(match => (match[1] !== undefined ? unquote(match[1]) : match[2]).replace(/^[(\['"`<]*@?/, '').replace(/^\.\//, '').replace(/[,;:.!?)\]'"`>]+$/, '').replace(/(:\d+)+$/, ''))
  .filter(path => /\/|\.\w{1,10}$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..')))].slice(0, 16);

export default function activate(api: ModAPI) {
  const load = () => {
    const stored = api.host.tryCall('store.get', { key: 'files', scope: 'repository' });
    const value = stored.ok && stored.value ? stored.value.value as unknown as Files : null;
    return { files: value?.files ? value : { tick: 0, files: {} }, revision: stored.ok && stored.value ? stored.value.revision : null };
  };
  const save = (files: Files, revision: number | null) => api.host.tryCall('store.put', { key: 'files', value: files as unknown as Exclude<Json, null>, expected_revision: revision, scope: 'repository' });
  const weight = (files: Files, path: string) => {
    const entry = files.files[path];
    return entry ? Math.min(30, 10 * Math.log2(1 + entry[0])) * 0.5 ** ((files.tick - entry[1]) / HALF_LIFE) : 0;
  };

  // Git status walks the worktree, so one result serves every query typed within STATUS_TTL_MS; the commit log reruns only when HEAD moves.
  const git = (): Status => {
    const cached = api.host.tryCall('store.get', { key: 'status', scope: 'repository' });
    const entry = cached.ok && cached.value ? cached.value.value as unknown as Status : null;
    const age = entry ? Date.now() - entry.at : -1;
    if (entry && age >= 0 && age < STATUS_TTL_MS) return entry;
    const exec = (argv: string[], max: number, timeout_ms = 3000) => {
      const run = api.host.tryCall('exec.run', { program: 'git', argv, timeout_ms, max_output_bytes: max });
      return run.ok && run.value.exit_code === 0 ? run.value : null;
    };
    const status = exec(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], STATUS_BYTES);
    if (!status) return { at: 0, boosts: [] };
    const prefix = entry?.prefix ?? exec(['rev-parse', '--show-prefix'], 4096)?.stdout.replace(/\n$/, '');
    const records = status.stdout.split('\0');
    if (status.stdout_truncated) records.pop();
    const header = (key: string) => records.find(record => record.startsWith(`# branch.${key} `))?.slice(key.length + 10);
    const dirty: [string, number][] = [];
    for (let index = 0; index < records.length; index++) {
      const fields = records[index].split(' ');
      const at = ({ '1': 8, '2': 9, u: 10, '?': 1 } as Record<string, number>)[fields[0]];
      const path = at ? fields.slice(at).join(' ') : '';
      if (fields[0] === '2') index++;
      if (prefix !== undefined && path.startsWith(prefix) && path !== prefix && !(at > 1 && fields[1].includes('D'))) dirty.push([path.slice(prefix.length), at === 1 ? 10 : 20]);
    }
    dirty.sort((a, b) => b[1] - a[1]);
    const head = header('oid');
    let recent = entry?.head === head ? entry?.recent : head === '(initial)' ? [] : undefined;
    if (!recent) {
      const history = (range: string[], skip = 0): string[][] | undefined => {
        const log = exec(['log', '-z', '--no-merges', `--skip=${skip}`, '-n', '64', '--relative', '--name-only', '--format=format:/', 'HEAD', ...range], LOG_BYTES, 1000);
        if (!log) return undefined;
        // Each commit starts with a "/" record (a path never does); its first name follows the newline and the rest are NUL-separated.
        const commits: string[][] = [];
        for (const record of log.stdout.split('\0')) if (record.startsWith('/')) commits.push(record.slice(2) ? [record.slice(2)] : []); else if (record) commits.at(-1)?.push(record);
        if (log.stdout_truncated) commits.pop();
        const kept = commits.filter(files => files.length && files.length <= HUGE_COMMIT);
        return log.stdout_truncated && !skip && kept.length < RECENT_COMMITS ? [...kept, ...history(range, Math.max(1, commits.length)) ?? []] : kept;
      };
      let commits = ['main', 'master'].includes(header('head') ?? '') ? undefined : history(['--not', ...DEFAULT_BRANCHES]);
      if (!commits?.length) commits = history([]);
      const counts = new Map<string, number>();
      for (const files of commits?.slice(0, RECENT_COMMITS) ?? []) files.forEach(path => counts.set(path, (counts.get(path) ?? 0) + 1));
      recent = commits && [...counts];
    }
    const paths = fit(dirty.map(([path]) => path), 2_000).slice(0, DIRTY_STATS);
    const stat = paths.length ? api.host.tryCall('workspace.stat', { paths }) : null;
    const boosts = dirty.map(([path, boost]): [string, number, number?] => {
      const time = stat?.ok ? stat.value.files[path]?.mtime_ms : undefined;
      return time ? [path, boost, time] : [path, boost];
    });
    const value: Status = { at: Date.now(), prefix, head: recent ? head : undefined, boosts: fit(boosts, ENTRY_BYTES * 3 / 4), recent: [] };
    value.recent = fit(recent ?? [], ENTRY_BYTES - serializedBytes(value));
    api.host.tryCall('store.put', { key: 'status', value: value as unknown as Exclude<Json, null>, expected_revision: cached.ok && cached.value ? cached.value.revision : null, scope: 'repository' });
    return value;
  };

  const rank = (query: string, upstream: string[]) => {
    const { files, revision } = load();
    const status = git();
    const boosts = new Map(status.boosts.map(([path, boost, time]) => [path, boost + (MODIFIED.find(([age]) => Date.now() - (time ?? -Infinity) <= age)?.[1] ?? 0)]));
    const recent = new Map(status.recent ?? []);
    const known = new Set([...upstream, ...boosts.keys()]);
    const order = new Map(upstream.map((path, index) => [path, index]));
    const scored = [...new Set([...known, ...Object.keys(files.files)])]
      .map(path => ({ path, score: fuzzy(query, path) ?? (order.has(path) ? 0 : null) }))
      .filter((item): item is { path: string; score: number } => item.score !== null)
      .map(item => ({ path: item.path, score: item.score + Math.min(50, weight(files, item.path) + (boosts.get(item.path) ?? 0) + Math.min(12, 4 * (recent.get(item.path) ?? 0))) }))
      .sort((a, b) => b.score - a.score || (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity))
      .map(item => item.path);
    const ranked: string[] = [];
    const missing: string[] = [];
    let checks = 0;
    for (let at = 0; ranked.length < LIMIT && at < scored.length;) {
      const page = scored.slice(at, at + Math.min(STAT_BATCH, LIMIT - ranked.length));
      at += page.length;
      const unknown = page.filter(path => !known.has(path));
      const stat = unknown.length && checks < STAT_BATCHES ? (checks++, api.host.tryCall('workspace.stat', { paths: unknown })) : null;
      const present = new Set(!stat ? [] : stat.ok ? unknown.filter(path => stat.value.files[path]?.kind === 'file') : unknown);
      if (stat && stat.ok) missing.push(...unknown.filter(path => !present.has(path)));
      ranked.push(...page.filter(path => known.has(path) || present.has(path)));
    }
    if (missing.length) {
      missing.forEach(path => delete files.files[path]);
      save(files, revision);
    }
    return ranked;
  };

  api.replace('completion', event => event.kind === 'mention'
    ? { items: rank(event.query, event.candidates.map(candidate => candidate.path)).map(path => ({ path })) }
    : null);

  api.provide({ name: 'omd.frecency', version: '1.0.0', methods: { rank: { input: 'object', output: 'object' } } }, {
    rank: input => {
      const query = (input as { query?: unknown } | null)?.query;
      return { paths: rank(typeof query === 'string' ? query.slice(0, 256) : '', []) };
    },
  });

  api.intercept('input', (event, next) => {
    const tokens = mentioned(event.text);
    if (tokens.length) api.state.set([...new Set([...(api.state.get() as string[] | null ?? []), ...tokens])].slice(-16));
    return next(event);
  });

  api.on('turn_start', () => {
    const tokens = api.state.get() as string[] | null;
    if (!tokens?.length) return;
    api.state.set(null);
    const listed = api.host.tryCall('exec.run', { program: 'git', argv: ['--literal-pathspecs', 'ls-files', '-z', '-co', '--exclude-standard', '--', ...tokens], timeout_ms: 3000 });
    let found: string[];
    if (listed.ok && listed.value.exit_code === 0) {
      const names = new Set(listed.value.stdout.split('\0'));
      found = tokens.filter(path => names.has(path));
    } else {
      const stat = api.host.tryCall('workspace.stat', { paths: tokens });
      found = stat.ok ? tokens.filter(path => stat.value.files[path]?.kind === 'file') : [];
    }
    if (!found.length) return;
    const { files, revision } = load();
    files.tick++;
    for (const path of found) files.files[path] = [(files.files[path]?.[0] ?? 0) + 1, files.tick];
    let bytes = serializedBytes({ tick: files.tick, files: {} });
    const kept: string[] = [];
    for (const path of Object.keys(files.files).sort((a, b) => weight(files, b) - weight(files, a)).slice(0, KEPT)) {
      bytes += serializedBytes({ [path]: files.files[path] }) - 2 + (kept.length ? 1 : 0);
      if (bytes >= STORED) break;
      kept.push(path);
    }
    files.files = Object.fromEntries(kept.map(path => [path, files.files[path]]));
    save(files, revision);
  });
}
