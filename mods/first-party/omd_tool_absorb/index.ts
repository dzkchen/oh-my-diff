import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Call = { call_id: string; tool: string; arguments: Json };
type Merge = { batch: string; calls: number; ran: number; invoked: Record<string, string> };
type State = {
  batches: number; absorbed: number; deduplicated: number; overflowed: number; saved_bytes: number; recent: Merge[];
};

const READ_TOOLS = ['read_file', 'list_dir', 'grep_files'];
const EXEC_KEYS = ['cmd', 'workdir', 'max_output_tokens', 'yield_time_ms'];
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

function isRead(arguments_: Json): boolean {
  if (!isObject(arguments_) || typeof arguments_.cmd !== 'string' || Object.keys(arguments_).some(key => !EXEC_KEYS.includes(key))) return false;
  const argv = words(arguments_.cmd);
  if (!argv?.length) return false;
  const [program, ...rest] = argv;
  let args = rest;
  let spec = Object.hasOwn(SPECS, program) ? SPECS[program] : undefined;
  if (program === 'git') {
    spec = Object.hasOwn(GIT, rest[0] ?? '') ? GIT[rest[0]] : undefined;
    args = rest.slice(1);
  }
  if (program === 'sed') {
    if (rest[0] !== '-n' || !/^\d+(,\d+)?p$/.test(rest[1] ?? '')) return false;
    args = rest.slice(2);
  }
  if (!spec) return false;
  let operands = 0;
  let ended = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (!ended && word === '--') {
      ended = true;
    } else if (!ended && word.startsWith('-') && word !== '-') {
      if (spec.valued?.includes(word)) {
        const value = args[++index];
        if (value === undefined || unsafe(value)) return false;
      } else if (!spec.flags.test(word)) {
        return false;
      }
    } else if (unsafe(word)) {
      return false;
    } else {
      operands++;
    }
  }
  return operands >= spec.min;
}

const absorbable = (call: { tool: string; arguments: Json }) =>
  READ_TOOLS.includes(call.tool) ? isObject(call.arguments) : call.tool === 'exec_command' && isRead(call.arguments);

function load(api: ModAPI): State {
  const state = api.state.get();
  return isObject(state) ? state as unknown as State
    : { batches: 0, absorbed: 0, deduplicated: 0, overflowed: 0, saved_bytes: 0, recent: [] };
}

const save = (api: ModAPI, state: State) => api.state.set(state as unknown as Json);

export default function activate(api: ModAPI) {
  const max = () => Math.min(8, Math.max(2, Number(api.settings.max_calls) || 4));

  api.replace('tool_batch', batch => {
    if (batch.calls.length < 2 || !batch.calls.every(absorbable)) return null;
    const groups = new Map<string, string[]>();
    for (const call of batch.calls) groups.set(keyOf(call.tool, call.arguments), [...(groups.get(keyOf(call.tool, call.arguments)) ?? []), call.call_id]);
    const merges: { call_ids: string[]; tool: string; arguments: Json }[] = [];
    const keys = [...groups.keys()];
    for (let start = 0; start < keys.length && merges.length < MERGES; start += max()) {
      const ids = new Set(keys.slice(start, start + max()).flatMap(key => groups.get(key) ?? []));
      const calls = batch.calls.filter(call => ids.has(call.call_id));
      if (calls.length >= 2) merges.push({ call_ids: calls.map(call => call.call_id), tool: 'batch', arguments: { batch: batch.batch_id, calls: calls as unknown as Json } });
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
    const out: Record<string, string> = {};
    const first = new Map<string, string>();
    const invoked: Record<string, string> = {};
    let deduplicated = 0;
    let overflowed = 0;
    let saved = 0;
    for (const call of calls) {
      if (!isObject(call) || typeof call.call_id !== 'string' || typeof call.tool !== 'string') continue;
      if (!absorbable(call)) {
        out[call.call_id] = `omd_tool_absorb did not run ${call.tool}: it only runs read-only calls. Call the tool directly.`;
        continue;
      }
      const key = keyOf(call.tool, call.arguments);
      const earlier = first.get(key);
      if (!earlier && first.size >= DISTINCT) {
        out[call.call_id] = `omd_tool_absorb did not run this ${call.tool} call: a merged step runs at most ${DISTINCT} distinct reads. Call it again on its own.`;
        continue;
      }
      if (earlier) {
        out[call.call_id] = `Same call as ${earlier} in this response (same tool and arguments, nothing changed in between), so it ran once: see the output for ${earlier}.`;
        saved += bytes(out[earlier] ?? '');
        deduplicated++;
        continue;
      }
      first.set(key, call.call_id);
      const run = api.host.tryCall('tools.invoke', { tool: call.tool, arguments: call.arguments });
      if (run.ok) {
        out[call.call_id] = run.value.output;
        invoked[call.call_id] = run.value.call_id;
      } else if (run.error.startsWith('host_result_limit')) {
        out[call.call_id] = `This ${call.tool} call ran, but its output did not fit in the merged result. Call it again on its own to read the output.`;
        overflowed++;
      } else {
        out[call.call_id] = `${call.tool} failed: ${run.error}`;
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

  api.command('absorb', () => {
    const state = load(api);
    const lines = [
      `Tool-call absorption: ${state.batches} merged batches · ${state.absorbed} calls · ${state.deduplicated} duplicate calls run once · ${state.overflowed} outputs too large to merge · about ${state.saved_bytes} bytes not repeated`,
      ...state.recent.map(merge => `${merge.batch}: ${merge.calls} calls, ${merge.ran} ran · ${Object.entries(merge.invoked).map(([call, run]) => `${call}→${run}`).join(', ')}`),
    ];
    return { display: lines.join('\n') };
  }, { description: 'Show merged read calls in this thread' });
}
