import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Call = { call_id: string; tool: string; arguments: Json };
type Flight = { key: string; status: 'running' } | { key: string; status: 'done'; output: string; value: Json };
type Merge = { batch: string; calls: number; ran: number; invoked: Record<string, string> };
type State = {
  batches: number; absorbed: number; deduplicated: number; overflowed: number; saved_bytes: number; recent: Merge[];
};

const EXEC_KEYS = ['cmd', 'workdir', 'max_output_tokens', 'yield_time_ms'];
const FILE_READERS = ['cat', 'head', 'tail', 'wc', 'sed'];
const HISTORY = /^(--stat|--shortstat|--numstat|--name-only|--name-status|--cached|--staged|--oneline|--no-color|--no-ext-diff|--no-textconv|-p|--patch|--graph|--decorate|--all|-U\d+|--unified=\d+|-\d+|-n\d+|--max-count=\d+|--(format|pretty)=\S*)$/;
type Spec = { flags: RegExp; valued?: string[]; min: number };
const SPECS: Record<string, Spec> = {
  cat: { flags: /^-[AbeEnstTuv]+$/, min: 1 },
  head: { flags: /^-([nc]\d+|\d+)$/, valued: ['-n', '-c'], min: 1 },
  tail: { flags: /^-([nc]\+?\d+|\d+)$/, valued: ['-n', '-c'], min: 1 },
  wc: { flags: /^-[clmwL]+$/, min: 1 },
  ls: { flags: /^-[a-zA-Z1]+$/, min: 0 },
  grep: { flags: /^(-[a-zA-Z0-9]+|--[a-z][a-z-]*(=.*)?)$/, valued: ['-e', '-f', '-A', '-B', '-C', '-m'], min: 2 },
  rg: {
    flags: /^(-[a-yA-Z0-9]+|--(?!pre|search-zip|hostname-bin)[a-z][a-z-]*(=.*)?)$/,
    valued: ['-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-r', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--after-context', '--before-context', '--max-columns', '--replace'],
    min: 2,
  },
  sed: { flags: /^$/, min: 1 },
};
const GIT: Record<string, Spec> = {
  status: { flags: /^(-s|--short|-b|--branch|--porcelain(=v[12])?|-u(no|normal|all)|--untracked-files=(no|normal|all))$/, min: 0 },
  diff: { flags: HISTORY, min: 0 },
  log: { flags: HISTORY, valued: ['-n'], min: 0 },
  show: { flags: HISTORY, min: 0 },
  blame: { flags: /^(-w|-s|--porcelain|-L\d+,\d+)$/, valued: ['-L'], min: 1 },
  'ls-files': { flags: /^(-[cdmo]|--cached|--deleted|--modified|--others|--exclude-standard)$/, min: 0 },
  'rev-parse': { flags: /^(--show-toplevel|--abbrev-ref|--short|--git-dir|--is-inside-work-tree|--verify)$/, min: 0 },
};
const RECENT = 8;
const OUTPUT_BYTES = 16_384;
const HASH_BYTES = 1_048_576;
const BACKOFF_MS = [25, 50, 100, 200, 400, 400, 400, 400, 400];
const STALE_MS = 600_000;
const META_STALE_MS = 86_400_000;
const LIST = 32;
const SWEEP = 8;
const MERGES = 32;
const DISTINCT = 8;

const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const canonical = (value: Json): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : isObject(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const keyOf = (tool: string, arguments_: Json) => `${tool} ${canonical(arguments_)}`;

function words(command: string): string[] | null {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of command) {
    if (quote === "'") {
      if (char === "'") quote = null; else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if ('$`\\!'.includes(char)) return null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === ' ' || char === '\t') {
      if (word !== null) out.push(word);
      word = null;
    } else if ('|&;<>$`\\(){}[]*?~!#'.includes(char) || /[\s\p{Cc}]/u.test(char)) {
      return null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quote) return null;
  if (word !== null) out.push(word);
  return out;
}

const unsafe = (word: string) => word === '-' || word.startsWith('/dev/');

function readCommand(arguments_: Json): { program: string; operands: string[] } | null {
  if (!isObject(arguments_) || typeof arguments_.cmd !== 'string' || Object.keys(arguments_).some(key => !EXEC_KEYS.includes(key))) return null;
  const argv = words(arguments_.cmd);
  if (!argv?.length) return null;
  const [program, ...rest] = argv;
  let args = rest;
  let spec = Object.hasOwn(SPECS, program) ? SPECS[program] : undefined;
  if (program === 'git') {
    spec = Object.hasOwn(GIT, rest[0] ?? '') ? GIT[rest[0]] : undefined;
    args = rest.slice(1);
  }
  if (program === 'sed') {
    if (rest[0] !== '-n' || !/^\d+(,\d+)?p$/.test(rest[1] ?? '')) return null;
    args = rest.slice(2);
  }
  if (!spec) return null;
  const operands: string[] = [];
  let ended = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (!ended && word === '--') {
      ended = true;
    } else if (!ended && word.startsWith('-') && word !== '-') {
      if (spec.valued?.includes(word)) {
        const value = args[++index];
        if (value === undefined || unsafe(value)) return null;
      } else if (!spec.flags.test(word) || (word.includes('=') && unsafe(word.slice(word.indexOf('=') + 1)))) {
        return null;
      }
    } else if (unsafe(word)) {
      return null;
    } else {
      operands.push(word);
    }
  }
  return operands.length >= spec.min ? { program, operands } : null;
}

const absorbable = (call: { tool: string; arguments: Json }) => call.tool === 'exec_command' && readCommand(call.arguments) !== null;

function sources(arguments_: Json): string[] | null {
  if (!isObject(arguments_) || arguments_.workdir !== undefined) return null;
  const read = readCommand(arguments_);
  return read && FILE_READERS.includes(read.program) ? read.operands : null;
}

function relative(path: string, root: string, cwd: string): string | null {
  if (path.split('/').includes('..')) return null;
  if (path.startsWith('/')) return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  if (cwd === root) return path.replace(/^\.\//, '');
  return cwd.startsWith(`${root}/`) ? `${cwd.slice(root.length + 1)}/${path.replace(/^\.\//, '')}` : null;
}

const finished = (value: Json) => isObject(value) && value.exit_code === 0;

function fnv(text: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

const hash = (text: string) => `${fnv(text, 0x811c9dc5)}${fnv(text, 0x9e3779b9)}`;

function sweep(api: ModAPI, thread: string, cell: string) {
  const now = Date.now();
  const listed = (prefix: string, drop: (entry: { key: string; provenance: { at: number } }) => boolean) => {
    const got = api.host.tryCall('store.list', { prefix, limit: LIST });
    return got.ok ? got.value.keys.filter(drop) : [];
  };
  [
    ...listed(`flight:${thread}:`, entry => !entry.key.startsWith(`flight:${thread}:${cell}:`)),
    ...listed('flight:', entry => !entry.key.startsWith(`flight:${thread}:`) && now - entry.provenance.at > STALE_MS),
    ...listed('meta:', entry => !entry.key.startsWith(`meta:${thread}:`) && now - entry.provenance.at > META_STALE_MS),
  ].slice(0, SWEEP).forEach(entry => api.host.tryCall('store.delete', { key: entry.key, expected_revision: entry.revision }));
}

function clear(api: ModAPI, thread: string) {
  for (let round = 0; round < 3; round++) {
    const listed = api.host.tryCall('store.list', { prefix: `flight:${thread}:`, limit: LIST });
    if (!listed.ok) return;
    listed.value.keys.forEach(entry => api.host.tryCall('store.delete', { key: entry.key, expected_revision: entry.revision }));
    if (listed.value.keys.length < LIST) return;
  }
}

function update(api: ModAPI, key: string, change: (value: Record<string, Json>) => Record<string, Json>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = api.host.tryCall('store.get', { key });
    if (!got.ok) return;
    const current = got.value && isObject(got.value.value) ? got.value.value : {};
    if (api.host.tryCall('store.put', { key, value: change(current), expected_revision: got.value?.revision ?? null }).ok) return;
  }
}

const reuseKey = (thread: string) => `meta:${thread}:reuse`;

function share(api: ModAPI, id: string, full: string): { output: string; value: Json } | null {
  for (const wait of [0, ...BACKOFF_MS]) {
    if (wait && !api.host.tryCall('time.sleep', { ms: wait }).ok) return null;
    const got = api.host.tryCall('store.get', { key: id });
    if (!got.ok || !got.value) return null;
    const flight = got.value.value as Flight;
    if (!isObject(flight) || flight.key !== full) return null;
    if (flight.status === 'done') return { output: flight.output, value: flight.value };
  }
  const last = api.host.tryCall('store.get', { key: id });
  if (last.ok && last.value && isObject(last.value.value) && last.value.value.status === 'running') {
    api.host.tryCall('store.delete', { key: id, expected_revision: last.value.revision });
  }
  return null;
}

function load(api: ModAPI): State {
  const state = api.state.get();
  return isObject(state) ? state as unknown as State
    : { batches: 0, absorbed: 0, deduplicated: 0, overflowed: 0, saved_bytes: 0, recent: [] };
}

const save = (api: ModAPI, state: State) => api.state.set(state as unknown as Json);

export default function activate(api: ModAPI) {
  api.replace('tool_batch', batch => {
    if (batch.calls.length < 2 || !batch.calls.every(absorbable)) return null;
    const size = Math.min(8, Math.max(2, Number(api.settings.max_calls) || 4));
    const groups = new Map<string, string[]>();
    for (const call of batch.calls) {
      const key = keyOf(call.tool, call.arguments);
      groups.set(key, [...(groups.get(key) ?? []), call.call_id]);
    }
    const merges: { call_ids: string[]; tool: string; arguments: Json; success_per_call: boolean }[] = [];
    const keys = [...groups.keys()];
    for (let start = 0; start < keys.length && merges.length < MERGES; start += size) {
      const ids = new Set(keys.slice(start, start + size).flatMap(key => groups.get(key) ?? []));
      const calls = batch.calls.filter(call => ids.has(call.call_id));
      if (calls.length >= 2) merges.push({ call_ids: calls.map(call => call.call_id), tool: 'batch', arguments: { batch: batch.batch_id, calls: calls as unknown as Json }, success_per_call: true });
    }
    return merges.length ? { merge: merges } : null;
  });

  api.tool({
    name: 'batch',
    description: 'Runs read-only calls that omd_tool_absorb merged from one response; the host calls it, so do not call it yourself',
    parameters: { type: 'object', properties: { batch: { type: 'string' }, calls: { type: 'array', items: { type: 'object' } } }, required: ['calls'], additionalProperties: false },
  }, input => {
    const request = input as { batch?: string; calls?: Call[] };
    const calls = Array.isArray(request.calls) ? request.calls : [];
    const out: Record<string, { output: string; success: boolean }> = {};
    const first = new Map<string, string>();
    const invoked: Record<string, string> = {};
    let deduplicated = 0;
    let overflowed = 0;
    let saved = 0;
    for (const call of calls) {
      if (!isObject(call) || typeof call.call_id !== 'string' || typeof call.tool !== 'string') continue;
      if (!absorbable(call)) {
        out[call.call_id] = { output: `omd_tool_absorb did not run ${call.tool}: it only runs read-only calls. Call the tool directly.`, success: false };
        continue;
      }
      const key = keyOf(call.tool, call.arguments);
      const earlier = first.get(key);
      if (!earlier && first.size >= DISTINCT) {
        out[call.call_id] = { output: `omd_tool_absorb did not run this ${call.tool} call: a merged step runs at most ${DISTINCT} distinct reads. Call it again on its own.`, success: false };
        continue;
      }
      if (earlier && !invoked[earlier]) {
        out[call.call_id] = out[earlier];
        continue;
      }
      if (earlier) {
        out[call.call_id] = { output: `Same call as ${earlier} in this response (same tool and arguments, nothing changed in between), so it ran once: see the output for ${earlier}.`, success: out[earlier].success };
        saved += bytes(out[earlier].output);
        deduplicated++;
        continue;
      }
      first.set(key, call.call_id);
      const run = api.host.tryCall('tools.invoke', { tool: call.tool, arguments: call.arguments });
      if (run.ok) {
        out[call.call_id] = { output: run.value.output, success: run.value.success };
        invoked[call.call_id] = run.value.call_id;
      } else if (run.error.startsWith('host_result_limit')) {
        out[call.call_id] = { output: `This ${call.tool} call ran, but its output did not fit in the merged result. Call it again on its own to read the output.`, success: false };
        overflowed++;
      } else {
        out[call.call_id] = { output: `${call.tool} failed: ${run.error}`, success: false };
      }
    }
    const state = load(api);
    save(api, {
      ...state, batches: state.batches + 1, absorbed: state.absorbed + calls.length, deduplicated: state.deduplicated + deduplicated,
      overflowed: state.overflowed + overflowed, saved_bytes: state.saved_bytes + saved,
      recent: [{ batch: String(request.batch ?? ''), calls: calls.length, ran: Object.keys(invoked).length, invoked }, ...state.recent].slice(0, RECENT),
    });
    return out;
  });

  api.intercept('tool', { match: { tool: 'exec_command' } }, async (e, next) => {
    const named = next.origin.caller === 'code_mode' && next.origin.cell_id && next.origin.thread_id ? sources(e.arguments) : null;
    if (!named) return next(e);
    const session = api.host.tryCall('session.info', null);
    if (!session.ok || session.value.thread_id !== next.origin.thread_id) return next(e);
    const files = named.map(path => relative(path, session.value.root, session.value.cwd));
    if (files.some(path => path === null)) return next(e);
    const paths = files as string[];
    const sizes = api.host.tryCall('workspace.stat', { paths });
    if (!sizes.ok || paths.some(path => sizes.value.files[path]?.kind !== 'file' || (sizes.value.files[path]?.size ?? Infinity) > HASH_BYTES)) return next(e);
    const stat = api.host.tryCall('workspace.stat', { paths, hash: true });
    const revision = stat.ok ? paths.map(path => stat.value.files[path]?.sha256 ?? '') : [];
    if (!stat.ok || revision.some(sha => !sha)) return next(e);
    const cell = hash(String(next.origin.cell_id));
    const thread = hash(session.value.thread_id);
    const full = `${keyOf(e.tool, e.arguments)}\n${revision.join(',')}`;
    const id = `flight:${thread}:${cell}:${hash(full)}`;
    const claim = api.host.tryCall('store.put', { key: id, value: { key: full, status: 'running' }, expected_revision: null });
    if (claim.ok) {
      const marker = api.host.tryCall('store.get', { key: `meta:${thread}:cell` });
      if (marker.ok && marker.value?.value !== cell) {
        sweep(api, thread, cell);
        api.host.tryCall('store.put', { key: `meta:${thread}:cell`, value: cell, expected_revision: marker.value?.revision ?? null });
      }
    } else {
      const shared = share(api, id, full);
      if (shared) {
        update(api, reuseKey(thread), counts => ({ reused: Number(counts.reused ?? 0) + 1, saved_bytes: Number(counts.saved_bytes ?? 0) + bytes(shared.output) }));
        return { output: shared.output, success: true, value: shared.value };
      }
      return next(e);
    }
    let published = false;
    let suspended = false;
    try {
      const result = await next(e);
      const done = result.success && !result.truncated && result.value !== undefined && finished(result.value) && bytes(result.output) <= OUTPUT_BYTES;
      const after = done ? api.host.tryCall('workspace.stat', { paths, hash: true }) : null;
      if (after?.ok && paths.every((path, index) => after.value.files[path]?.sha256 === revision[index])) {
        published = api.host.tryCall('store.put', { key: id, value: { key: full, status: 'done', output: result.output, value: result.value ?? null }, expected_revision: claim.value.revision }).ok;
      }
      return result;
    } catch (error) {
      suspended = !(error instanceof Error);
      throw error;
    } finally {
      if (!published && !suspended) api.host.tryCall('store.delete', { key: id, expected_revision: claim.value.revision });
    }
  });

  api.on('turn_end', () => {
    const session = api.host.tryCall('session.info', null);
    if (session.ok) clear(api, hash(session.value.thread_id));
  });

  api.command('absorb', () => {
    const state = load(api);
    const session = api.host.tryCall('session.info', null);
    const counts = session.ok ? api.host.tryCall('store.get', { key: reuseKey(hash(session.value.thread_id)) }) : null;
    const reuse = counts?.ok && counts.value && isObject(counts.value.value) ? counts.value.value : {};
    const lines = [
      `Tool-call absorption: ${state.batches} merged batches · ${state.absorbed} calls · ${state.deduplicated} duplicate calls run once · ${Number(reuse.reused ?? 0)} repeated code-mode reads reused · ${state.overflowed} outputs too large to merge · about ${state.saved_bytes + Number(reuse.saved_bytes ?? 0)} bytes not repeated`,
      ...state.recent.map(merge => `${merge.batch}: ${merge.calls} calls, ${merge.ran} ran · ${Object.entries(merge.invoked).map(([call, run]) => `${call}→${run}`).join(', ')}`),
    ];
    return { display: lines.join('\n') };
  }, { description: 'Show merged read calls in this thread' });
}
