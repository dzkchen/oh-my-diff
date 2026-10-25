import type { Json, ModAPI } from '../../api.d.ts';

type Schema = { [key: string]: Json };
type Change = { path: string; rule: string; from: Json; to: Json };
type Repair = { value: Json; changes: Change[]; ambiguous: string[] };
type Entry = { tool: string; call_id: string; kind: 'corrected' | 'json' | 'ambiguous'; detail: string; evidence: string | null; outcome: string | null };
type State = { corrected: number; json: number; ambiguous: number; ran: number; failed: number; rejected: number; unrepaired: number; released: number; loops: Record<string, number>; recent: Entry[] };

const RECENT = 12;
const LOOP_KEYS = 32;
const ASKS = 2;
const EVIDENCE_BYTES = 32_768;

const isObject = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);
const kind = (value: Json) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const isType = (value: Json, name: Json) => name === 'integer' ? typeof value === 'number' && Number.isInteger(value) : kind(value) === name;
const types = (schema: Schema): Json[] => Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
const properties = (schema: Schema): Schema => isObject(schema.properties) ? schema.properties : {};
const required = (schema: Schema) => Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [];
const same = (left: Json, right: Json) => JSON.stringify(left) === JSON.stringify(right);
const pointer = (path: string, name: string | number) => `${path}/${String(name).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const normal = (name: string) => name.toLowerCase().replace(/[_-]/g, '');
const unmodeled = (schema: Json): boolean => Array.isArray(schema) ? schema.some(unmodeled)
  : isObject(schema) && Object.entries(schema).some(([key, value]) => ['oneOf', 'allOf', '$ref'].includes(key) || unmodeled(value));
const show = (value: Json) => { const text = JSON.stringify(value); return text.length > 60 ? `${text.slice(0, 57)}...` : text; };

function valid(schema: Json, value: Json): boolean {
  if (!isObject(schema)) return true;
  const allowed = types(schema);
  if (allowed.length && !allowed.some(name => isType(value, name))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => same(item, value))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(variant => valid(variant, value))) return false;
  if (isObject(value)) {
    if (required(schema).some(name => !Object.hasOwn(value, name))) return false;
    const known = properties(schema);
    for (const [name, member] of Object.entries(value)) {
      if (Object.hasOwn(known, name)) { if (!valid(known[name], member)) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (isObject(schema.additionalProperties) && !valid(schema.additionalProperties, member)) return false;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) return value.every(member => valid(schema.items, member));
  return true;
}

function candidates(schema: Schema, value: string): { value: Json; rule: string }[] {
  const allowed = types(schema);
  const found: { value: Json; rule: string }[] = [];
  if (allowed.includes('integer') && /^-?(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) found.push({ value: Number(value), rule: 'integer_string' });
  if (allowed.includes('number') && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value) && value.replace(/[eE].*$/, '').replace(/\D/g, '').replace(/^0+/, '').length <= 15
    && Number.isFinite(Number(value))) found.push({ value: Number(value), rule: 'number_string' });
  if (allowed.includes('boolean') && (value === 'true' || value === 'false')) found.push({ value: value === 'true', rule: 'boolean_string' });
  if ((allowed.includes('object') || allowed.includes('array')) && /^\s*[[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value) as Json;
      if (allowed.includes(kind(parsed))) found.push({ value: parsed, rule: 'json_string' });
    } catch {}
  }
  if (Array.isArray(schema.enum)) {
    const matches = schema.enum.filter(item => typeof item === 'string' && item.toLowerCase() === value.toLowerCase());
    for (const item of matches) found.push({ value: item, rule: 'enum_case' });
  }
  return found.filter((entry, index) => found.findIndex(other => same(other.value, entry.value)) === index);
}

function repairObject(schema: Schema, value: Schema, path: string): Repair {
  const known = properties(schema);
  const out: [string, Json][] = [];
  const changes: Change[] = [];
  const ambiguous: string[] = [];
  const renamed = new Map<string, string>();
  for (const name of Object.keys(value)) {
    if (Object.hasOwn(known, name) || schema.additionalProperties !== false) continue;
    const matches = Object.keys(known).filter(target => normal(target) === normal(name));
    if (matches.length > 1) ambiguous.push(`${pointer(path, name)}: matches the properties ${matches.join(', ')}`);
    else if (matches.length === 1 && Object.hasOwn(value, matches[0])) ambiguous.push(`${pointer(path, name)}: conflicts with ${matches[0]}, which is also set`);
    else if (matches.length === 1 && [...renamed.values()].includes(matches[0])) ambiguous.push(`${pointer(path, name)}: another key also names ${matches[0]}`);
    else if (matches.length === 1) renamed.set(name, matches[0]);
  }
  for (const [name, member] of Object.entries(value)) {
    const target = renamed.get(name) ?? name;
    if (renamed.has(name)) changes.push({ path: pointer(path, name), rule: 'key_name', from: name, to: target });
    const nested = Object.hasOwn(known, target) ? known[target] : isObject(schema.additionalProperties) ? schema.additionalProperties : null;
    const inner = nested === null ? { value: member, changes: [], ambiguous: [] } : repair(nested, member, pointer(path, target));
    out.push([target, inner.value]);
    changes.push(...inner.changes);
    ambiguous.push(...inner.ambiguous);
  }
  return { value: Object.fromEntries(out), changes, ambiguous };
}

function repair(schema: Json, value: Json, path = ''): Repair {
  if (!isObject(schema) || valid(schema, value)) return { value, changes: [], ambiguous: [] };
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf.map(variant => repair(variant, value, path)).filter(option => !option.ambiguous.length && option.changes.length && valid(schema, option.value));
    const distinct = options.filter((option, index) => options.findIndex(other => same(other.value, option.value)) === index);
    if (distinct.length === 1) return distinct[0];
    if (distinct.length > 1) return { value, changes: [], ambiguous: [`${path || '/'}: ${show(value)} fits ${distinct.length} anyOf variants`] };
  }
  if (typeof value === 'string') {
    const found = candidates(schema, value);
    if (found.length > 1) return { value, changes: [], ambiguous: [`${path || '/'}: ${show(value)} could be ${found.map(entry => show(entry.value)).join(' or ')}`] };
    if (found.length === 1) {
      const inner = repair(schema, found[0].value, path);
      return { value: inner.value, changes: [{ path: path || '/', rule: found[0].rule, from: value, to: found[0].value }, ...inner.changes], ambiguous: inner.ambiguous };
    }
  }
  if (isObject(value)) return repairObject(schema, value, path);
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = value.map((member, index) => repair(schema.items, member, pointer(path, index)));
    return { value: items.map(item => item.value), changes: items.flatMap(item => item.changes), ambiguous: items.flatMap(item => item.ambiguous) };
  }
  return { value, changes: [], ambiguous: [] };
}

function repairJson(text: string): { text: string; rules: string[] } | null {
  try { JSON.parse(text); return null; } catch {}
  const rules: string[] = [];
  let out = text.trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(out);
  if (fence) { out = fence[1]; rules.push('code_fence'); }
  let stripped = '';
  let quoted = false;
  for (let index = 0; index < out.length; index++) {
    const char = out[index];
    if (quoted) {
      stripped += char;
      if (char === '\\') stripped += out[++index] ?? '';
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === ',') {
      let ahead = index + 1;
      while (' \t\r\n'.includes(out[ahead] ?? 'x')) ahead++;
      if (out[ahead] === '}' || out[ahead] === ']') continue;
    }
    stripped += char;
  }
  if (stripped !== out) { out = stripped; rules.push('trailing_comma'); }
  if (!rules.length) return null;
  try {
    return isObject(JSON.parse(out)) ? { text: out, rules } : null;
  } catch {
    return null;
  }
}

function load(api: ModAPI): State {
  const state = api.state.get();
  return isObject(state) ? state as unknown as State
    : { corrected: 0, json: 0, ambiguous: 0, ran: 0, failed: 0, rejected: 0, unrepaired: 0, released: 0, loops: {}, recent: [] };
}

function save(api: ModAPI, state: State, entry?: Entry) {
  const recent = entry ? [entry, ...state.recent].slice(0, RECENT) : state.recent;
  const loops = Object.fromEntries(Object.entries(state.loops).slice(-LOOP_KEYS));
  api.state.set({ ...state, recent, loops } as unknown as Json);
}

function record(api: ModAPI, content: Record<string, Json>, tool: string) {
  if (new TextEncoder().encode(JSON.stringify(content)).length > EVIDENCE_BYTES) {
    const changes = Array.isArray(content.changes) ? content.changes.map(change => isObject(change) ? { path: change.path, rule: change.rule } : change) : content.changes;
    content = { ...content, original: '(too large to keep)', raw: '(too large to keep)', corrected: '(too large to keep)', ...(changes === undefined ? {} : { changes }) };
  }
  const written = api.host.tryCall('evidence.write', { media_type: 'application/json', content, label: `omd_tool_fix ${tool}` });
  return written.ok ? written.value.reference : null;
}

const bump = (loops: Record<string, number>, key: string) => { const { [key]: seen = 0, ...rest } = loops; return { ...rest, [key]: seen + 1 }; };
const loopKey = (tool: string, raw: string) => `${tool}:${raw.length}:${raw.slice(0, 160)}`;

export default function activate(api: ModAPI) {
  api.intercept('response_stream', { match: { kind: 'tool_done', format: 'json' } }, (e, next) => {
    if (e.kind !== 'tool_done') return next(e);
    const fixed = repairJson(e.arguments);
    if (!fixed) return next(e);
    const state = load(api);
    const evidence = record(api, { stage: 'json', tool: e.tool, call_id: e.call_id, original: e.arguments, corrected: fixed.text, rules: fixed.rules }, e.tool);
    save(api, { ...state, json: state.json + 1 }, { tool: e.tool, call_id: e.call_id, kind: 'json', detail: fixed.rules.join(', '), evidence, outcome: null });
    return next({ ...e, arguments: fixed.text });
  });

  api.intercept('tool', async (e, next) => {
    if (!isObject(e.schema) || !isObject(e.arguments) || valid(e.schema, e.arguments) || unmodeled(e.schema)) return next(e);
    const fix = repair(e.schema, e.arguments);
    const state = load(api);
    const key = loopKey(e.tool, e.raw_arguments);
    const seen = state.loops[key] ?? 0;
    if (seen >= ASKS) {
      save(api, { ...state, released: state.released + 1, loops: bump(state.loops, key) });
      return next(e);
    }
    if (fix.ambiguous.length) {
      const detail = fix.ambiguous.join('; ');
      save(api, { ...state, ambiguous: state.ambiguous + 1, loops: bump(state.loops, key) },
        { tool: e.tool, call_id: e.call_id, kind: 'ambiguous', detail, evidence: null, outcome: 'not run' });
      return { output: `${e.tool} was not run: its arguments don't match the tool's schema and the fix is ambiguous. ${detail}. Send the call again with exact values.`, success: false };
    }
    if (!fix.changes.length || !valid(e.schema, fix.value)) {
      save(api, { ...state, unrepaired: state.unrepaired + 1 });
      return next(e);
    }
    const result = await next({ ...e, arguments: fix.value });
    const evidence = record(api, { stage: 'schema', tool: e.tool, call_id: e.call_id, original: e.arguments, raw: e.raw_arguments, corrected: fix.value, changes: fix.changes as unknown as Json }, e.tool);
    const outcome = result.success ? 'ran' : /^tool_arguments_invalid: /.test(result.output) ? 'rejected' : 'failed';
    const after = load(api);
    save(api, {
      ...after, corrected: after.corrected + 1, [outcome]: after[outcome] + 1,
      loops: outcome === 'rejected' ? bump(after.loops, key) : after.loops,
    }, { tool: e.tool, call_id: e.call_id, kind: 'corrected', detail: fix.changes.map(change => `${change.path} ${change.rule}`).join(', '), evidence, outcome });
    return result;
  });

  api.command('toolfix', () => {
    const state = load(api);
    const lines = [
      `Tool-call correction: ${state.corrected} corrected (${state.ran} ran, ${state.failed} failed in the tool, ${state.rejected} rejected by the host) · ${state.json} JSON repairs · ${state.ambiguous} sent back as ambiguous · ${state.unrepaired} left to the tool · ${state.released} repeats passed through`,
      ...state.recent.map(entry => `${entry.kind} ${entry.tool} ${entry.call_id}: ${entry.detail}${entry.outcome ? ` → ${entry.outcome}` : ''}${entry.evidence ? ` · ${entry.evidence}` : ''}`),
    ];
    return { display: lines.join('\n') };
  }, { description: 'Show tool-call corrections in this thread' });
}
