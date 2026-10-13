import type { Json, ModAPI } from '../../api.d.ts';

type Files = { tick: number; files: Record<string, [number, number]> };

const LIMIT = 50;
const KEPT = 512;
const HALF_LIFE = 64;
const STAT_BATCH = 64;
const STAT_BATCHES = 4;
// Reading and rewriting the history must fit one callback's 128 KiB receipt budget.
const STORED = 48_000;

function serializedBytes(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function common(query: string, path: string): number {
  let row = new Array<number>(path.length + 1).fill(0);
  for (const character of query) {
    const next = [0];
    for (let index = 0; index < path.length; index++) next.push(character === path[index] ? row[index] + 1 : Math.max(row[index + 1], next[index]));
    row = next;
  }
  return row[path.length];
}

// Smart case; tiers: name prefix, name substring, path substring, subsequence, then up to one typo per four query characters.
function fuzzy(query: string, path: string): number | null {
  if (!query) return 0;
  const exact = query !== query.toLowerCase();
  const [q, p] = exact ? [query, path] : [query.toLowerCase(), path.toLowerCase()];
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (name.startsWith(q)) return 100;
  if (name.includes(q)) return 90;
  if (p.includes(q)) return 80;
  const typos = q.length - common(q, p);
  if (typos > Math.floor(q.length / 4)) return null;
  return (typos ? 50 - typos * 10 : 60) + (common(q, name) === q.length ? 10 : 0);
}

const mentioned = (text: string) => [...new Set([...text.matchAll(/"([^"\n]{1,256})"|(\S{1,256})/g)]
  .map(match => (match[1] ?? match[2]).replace(/^[(\['"`<]*@?/, '').replace(/^\.\//, '').replace(/[,;:.!?)\]'"`>]+$/, '').replace(/(:\d+)+$/, ''))
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

  const git = () => {
    const boosts = new Map<string, number>();
    const run = api.host.tryCall('exec.run', { program: 'git', argv: ['-c', 'core.quotePath=false', 'status', '--short', '--untracked-files=all'], timeout_ms: 3000 });
    if (!run.ok || run.value.exit_code !== 0) return boosts;
    for (const line of run.value.stdout.split('\n')) {
      const raw = line.slice(3).split(' -> ').pop() ?? '';
      const path = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
      if (path && !line.slice(0, 2).includes('D') && !path.startsWith('../')) boosts.set(path, line.startsWith('??') ? 10 : 20);
    }
    return boosts;
  };

  const rank = (query: string, upstream: string[], limit: number) => {
    const { files, revision } = load();
    const boosts = git();
    const known = new Set([...upstream, ...boosts.keys()]);
    const order = new Map(upstream.map((path, index) => [path, index]));
    const scored = [...new Set([...known, ...Object.keys(files.files)])]
      .map(path => ({ path, score: fuzzy(query, path) ?? (order.has(path) ? 0 : null) }))
      .filter((item): item is { path: string; score: number } => item.score !== null)
      .map(item => ({ path: item.path, score: item.score + weight(files, item.path) + (boosts.get(item.path) ?? 0) }))
      .sort((a, b) => b.score - a.score || (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity))
      .map(item => item.path);
    const ranked: string[] = [];
    const missing: string[] = [];
    let checks = 0;
    for (let at = 0; ranked.length < limit && at < scored.length;) {
      const page = scored.slice(at, at + Math.min(STAT_BATCH, limit - ranked.length));
      at += page.length;
      const unknown = page.filter(path => !known.has(path));
      const stat = unknown.length && checks < STAT_BATCHES ? (checks++, api.host.tryCall('workspace.stat', { paths: unknown })) : null;
      const present = new Set(stat?.ok ? unknown.filter(path => stat.value.files[path]?.kind === 'file') : []);
      if (stat?.ok) missing.push(...unknown.filter(path => !present.has(path)));
      ranked.push(...page.filter(path => known.has(path) || present.has(path)));
    }
    if (missing.length) {
      missing.forEach(path => delete files.files[path]);
      save(files, revision);
    }
    return ranked;
  };

  api.replace('completion', event => event.kind === 'mention'
    ? { items: rank(event.query, event.candidates.map(candidate => candidate.path), LIMIT).map(path => ({ path })) }
    : null);

  api.provide({ name: 'omd.frecency', version: '1.0.0', methods: { rank: { input: 'object', output: 'object' } } }, {
    rank: input => {
      const request = input as { query?: unknown; paths?: unknown };
      const paths = Array.isArray(request.paths) ? request.paths.filter((path): path is string => typeof path === 'string').slice(0, 1000) : [];
      return { paths: rank(String(request.query ?? ''), paths, Math.max(paths.length, LIMIT)) };
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
