import type { Json, ModAPI } from '../../api.d.ts';

type Rule = { id: string; regex: RegExp; reminder: string; max_activations: number };
type State = { thread: string | null; counts: Record<string, number>; stops: number; tools: boolean; active: Record<string, string> };

const MAX_STOPS_PER_TURN = 2;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const line = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);

function unbounded(pattern: string) {
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\') {
      if (/[1-9k]/.test(pattern[++index] ?? '')) return true;
    } else if (character === '*' || character === '+') return true;
    else if (character === '{') {
      const quantifier = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
      if (quantifier && quantifier[2] !== undefined && (quantifier[3] === '' || Number(quantifier[3]) > 64)) return true;
    }
  }
  return false;
}

function rules(value: Json | undefined): Rule[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('rules_invalid: at most 16 rules');
  const ids = new Set<string>(), patterns = new Set<string>();
  return value.map(rule => {
    if (!object(rule) || Object.keys(rule).some(key => !['id', 'pattern', 'flags', 'reminder', 'max_activations'].includes(key))) throw new Error('rule_invalid');
    const { id, pattern, flags = '', reminder, max_activations = 1 } = rule;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || ids.has(id)) throw new Error(`rule_id_invalid_or_duplicate: ${String(id)}`);
    if (!line(pattern, 128) || unbounded(pattern)) throw new Error(`rule_pattern_unbounded: ${id}`);
    if (flags !== '' && flags !== 'i') throw new Error(`rule_flags_invalid: ${id}`);
    if (!line(reminder, 512)) throw new Error(`rule_reminder_invalid: ${id}`);
    if (typeof max_activations !== 'number' || !Number.isInteger(max_activations) || max_activations < 1 || max_activations > MAX_STOPS_PER_TURN) throw new Error(`rule_max_activations_invalid: ${id}`);
    const regex = new RegExp(pattern, flags);
    const key = `${flags}/${pattern}`;
    if (regex.test('') || patterns.has(key)) throw new Error(`rule_pattern_ambiguous: ${id}`);
    ids.add(id);
    patterns.add(key);
    return { id, regex, reminder, max_activations };
  });
}

export default function activate(api: ModAPI) {
  const configured = rules(api.settings.rules);
  if (!configured.length) return;
  const fresh = (thread: string | null = null): State => ({ thread, counts: {}, stops: 0, tools: false, active: {} });
  const load = () => (api.state.get() as State | null) ?? fresh();
  const save = (state: State) => api.state.set(state as unknown as Json);

  api.on('start', () => save(fresh()));
  api.on('resume', ({ thread_id }) => {
    if (load().thread !== thread_id) save(fresh(thread_id));
  });
  api.on('turn_start', () => save({ ...load(), counts: {}, stops: 0, tools: false }));
  api.on('tool_result', ({ outcome }) => {
    if (outcome === 'blocked' || outcome === 'failed_before_handler') return;
    const state = load();
    if (!state.tools) save({ ...state, tools: true });
  });
  api.middleware('response_stream', event => {
    if (!event.boundary || !event.text) return null;
    const matched = configured.filter(rule => rule.regex.test(event.text!));
    if (matched.length !== 1) return null;
    const rule = matched[0];
    const state = load();
    const count = state.counts[rule.id] ?? 0;
    if (count >= rule.max_activations || state.stops >= MAX_STOPS_PER_TURN) return null;
    save({ ...state, counts: { ...state.counts, [rule.id]: count + 1 }, stops: state.stops + 1, active: { ...state.active, [rule.id]: rule.reminder } });
    const effects = state.tools ? ' Tool calls that completed earlier in this turn remain in effect; they were not undone.' : '';
    return { stop: { reason: `reactive rule ${rule.id}` }, retry: { inject: `Reactive rule ${rule.id}: ${rule.reminder}${effects}` } };
  });
  api.on('context', ({ thread_id }) => {
    const state = load();
    if (state.thread === null) save({ ...state, thread: thread_id });
    const active = Object.entries(state.active);
    return active.length ? { text: `Reactive rules activated earlier in this session:\n${active.map(([id, reminder]) => `- ${id}: ${reminder}`).join('\n')}` } : null;
  });
}
