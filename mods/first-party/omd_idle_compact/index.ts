import type { ModAPI } from '../../api.d.ts';
import { cacheLifetime, flatBilling } from './cache_ttl.ts';

type Waiting = 'approval' | 'question';
type State = { at: number; ttl: number; expires: number; reported: boolean; identity: string; tokens: number; running: boolean; pending: Record<string, Waiting>; compacted: number;
  requested: 'idle' | Waiting | null; limited: boolean; flat: boolean };

const FIRE_AT = 0.9;
const MAX_DELAY_MS = 24 * 3_600_000;
const RETRY_MS = 15_000;
const RETRYABLE = /^client(_surface)?_context_changed/;
const NOTICE = 'Compacted after the estimated prompt-cache idle interval';
const LIMITED = 'Idle compaction is off for this thread: other threads hold all of this mod\'s timers';
const FLAT = {
  included_subscription: 'Idle compaction is inactive here: ChatGPT plans keep their own prompt cache. To compact anyway, set Estimated cache lifetime in /mods',
  unpriced: 'Idle compaction is inactive here: no price is known for this model or provider, so its cache can\'t be told apart from a ChatGPT plan\'s. To compact anyway, set Estimated cache lifetime in /mods',
};
const CANCELLED = { approval: 'The pending approval was cancelled.', question: 'The unanswered question was cancelled.' };

export default function activate(api: ModAPI) {
  const minutes = Number(api.settings.cache_ttl_minutes) || 0;
  const minTokens = Number(api.settings.min_tokens ?? 100_000);
  const load = (): State => ({ at: 0, ttl: 0, expires: 0, reported: false, identity: '', tokens: 0, running: false, pending: {}, compacted: 0, requested: null, limited: false, flat: false,
    ...(api.state.get() as Partial<State> | null) });
  const save = (patch: Partial<State>) => api.state.set({ ...load(), ...patch });
  const live = (state: State) => state.ttl > 0 && state.tokens > 0 && state.tokens >= minTokens && Date.now() < state.expires;
  const arm = (state: State) => {
    const armed = api.host.tryCall('events.schedule', { key: 'idle', delay_ms: Math.min(MAX_DELAY_MS, Math.max(1000, Math.round(state.at + (state.expires - state.at) * FIRE_AT - Date.now()))) });
    const limited = !armed.ok && armed.error.startsWith('timer_limit');
    if (limited === state.limited) return;
    save({ limited });
    if (limited) api.host.tryCall('terminal.notice', { text: LIMITED, kind: 'warning', placement: 'toast', ttl_ms: 8000 });
  };

  api.on('model_response', response => {
    if (response.scope.kind !== 'main' || response.scope.agent_id || response.synthetic) return;
    if (response.status !== 'completed' && response.status !== 'incomplete') return;
    const previous = load();
    if (response.timing.started_at_ms <= previous.compacted) return;
    const { context, tokens } = api.usage.summarize(response);
    const at = response.timing.started_at_ms;
    const memo = cacheLifetime(response, minutes, at, previous);
    const told = minutes <= 0 && flatBilling(response);
    if (told && !previous.flat) api.host.tryCall('terminal.notice', { text: FLAT[response.cost.basis as keyof typeof FLAT], kind: 'info', placement: 'transcript' });
    const state = { ...previous, at, ttl: memo.ttl, expires: memo.expires, reported: memo.reported, identity: memo.identity, flat: previous.flat || told,
      tokens: context?.used ?? (tokens.input ?? 0) + (tokens.output ?? 0) };
    save(state);
    if (live(state)) arm(state);
    else api.host.tryCall('events.cancel', { key: 'idle' });
  });

  api.on('timer', () => {
    const state = load();
    if (!live(state)) return;
    if (state.at + (state.expires - state.at) * FIRE_AT - Date.now() > 1000) return void arm(state);
    const waiting = Object.values(state.pending);
    if (state.running && !waiting.length) return;
    const started = api.host.tryCall('app.request', { method: 'thread/compact/start', params: { threadId: api.session().thread_id } });
    if (!started.ok) return void (RETRYABLE.test(started.error) && api.host.tryCall('events.schedule', { key: 'idle', delay_ms: RETRY_MS }));
    if ((started.value as { status?: unknown } | null)?.status === 'declined') return;
    save({ requested: waiting.includes('question') ? 'question' : waiting[0] ?? 'idle' });
  });

  api.on('app_server_request', event => {
    const thread = (event.params as { threadId?: unknown } | null)?.threadId;
    if (typeof thread === 'string' && thread !== api.session().thread_id) return;
    const pending = { ...load().pending }, key = JSON.stringify(event.request_id);
    if (event.phase === 'resolved') delete pending[key];
    else pending[key] = event.method.endsWith('requestApproval') ? 'approval' : 'question';
    save({ pending });
  });

  api.on('compaction_end', event => {
    const { requested } = load();
    const compacted = event.outcome === 'compacted' || event.outcome === 'replaced';
    save(compacted ? { requested: null, tokens: 0, compacted: Date.now() } : { requested: null });
    if (compacted) api.host.tryCall('events.cancel', { key: 'idle' });
    if (compacted && requested) {
      api.host.tryCall('terminal.notice', { text: requested === 'idle' ? NOTICE : `${NOTICE}. ${CANCELLED[requested]}`, kind: 'info', placement: 'transcript' });
    }
  });

  api.on('turn_start', () => save({ running: true, pending: {} }));
  api.on('turn_end', () => {
    const state = { ...load(), running: false, pending: {} };
    save(state);
    if (!state.requested && live(state)) arm(state);
  });
  for (const event of ['start', 'resume'] as const) api.on(event, () => save({ running: false, pending: {}, requested: null }));
}
