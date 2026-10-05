import type { Json, ModAPI } from '../../api.d.ts';

type Rule = { id: string; regex: RegExp; reminder: string; max_activations: number };
type State = { thread: string | null; counts: Record<string, number>; stops: number; tools: boolean; active: Record<string, string> };

const MAX_STOPS_PER_TURN = 2;
const MAX_REPEAT = 64;
const MATCH_WORK = 2048;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const line = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);

// Worst-case backtracking steps per start position; each node yields [match paths, steps].
function work(pattern: string): number {
  let index = 0;
  const alternation = (): [number, number] => {
    let paths = 0, steps = 0;
    for (;;) {
      let branchPaths = 1, branchSteps = 0;
      while (index < pattern.length && pattern[index] !== '|' && pattern[index] !== ')') {
        const [p, s] = quantified(atom());
        branchSteps += branchPaths * s;
        branchPaths *= p;
      }
      paths += branchPaths;
      steps += branchSteps;
      if (pattern[index] !== '|') return [paths, steps];
      index++;
    }
  };
  const atom = (): [number, number] => {
    const character = pattern[index++];
    if (character === '(') {
      index += /^(?:\?(?:[:=!]|<[=!]|<[^>]*>))?/.exec(pattern.slice(index))![0].length;
      const inner = alternation();
      index++;
      return inner;
    }
    if (character === '[') {
      while (index < pattern.length && pattern[index] !== ']') index += pattern[index] === '\\' ? 2 : 1;
      index++;
    } else if (character === '\\' && /[1-9k]/.test(pattern[index++] ?? '')) return [Infinity, Infinity];
    return [1, 1];
  };
  const quantified = ([paths, steps]: [number, number]): [number, number] => {
    const quantifier = /^(?:([?*+])|\{(\d+)(,(\d*))?\})\??/.exec(pattern.slice(index));
    if (!quantifier) return [paths, steps];
    index += quantifier[0].length;
    const min = quantifier[1] ? Number(quantifier[1] === '+') : Number(quantifier[2]);
    const max = quantifier[1] ? (quantifier[1] === '?' ? 1 : Infinity) : quantifier[3] === undefined ? min : quantifier[4] ? Number(quantifier[4]) : Infinity;
    if (max > MAX_REPEAT) return [Infinity, Infinity];
    let repeated = 0, iterations = 0;
    for (let count = 0, power = 1; count <= max; count++, power *= paths) {
      if (count >= min) repeated += power;
      if (count < max) iterations += power * steps;
    }
    return [repeated, iterations];
  };
  return alternation()[1];
}

function rules(value: Json | undefined): Rule[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('rules_invalid: at most 16 rules');
  const ids = new Set<string>(), patterns = new Set<string>();
  let budget = MATCH_WORK;
  return value.map(rule => {
    if (!object(rule) || Object.keys(rule).some(key => !['id', 'pattern', 'flags', 'reminder', 'max_activations'].includes(key))) throw new Error('rule_invalid');
    const { id, pattern, flags = '', reminder, max_activations = 1 } = rule;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || ids.has(id)) throw new Error(`rule_id_invalid_or_duplicate: ${String(id)}`);
    if (!line(pattern, 128)) throw new Error(`rule_pattern_unbounded: ${id}`);
    budget -= work(pattern);
    if (!(budget >= 0)) throw new Error(`rule_pattern_unbounded: ${id}`);
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
  const configured = rules(api.settings.rules ?? []);
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
  api.intercept('response_stream', { match: { kind: 'message' } }, async (event, next) => {
    const result = await next(event);
    if (event.kind !== 'message' || !event.text) return result;
    const text = event.text;
    const matched = configured.filter(rule => rule.regex.test(text));
    if (matched.length !== 1) return result;
    const rule = matched[0];
    const state = load();
    const count = state.counts[rule.id] ?? 0;
    if (count >= rule.max_activations || state.stops >= MAX_STOPS_PER_TURN) return result;
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
