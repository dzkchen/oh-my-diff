import type { ModAPI, ModelResponse } from '../../api.d.ts';

type Waiting = 'approval' | 'question';
type State = { at: number; ttl: number; expires: number; reported: boolean; identity: string; tokens: number; running: boolean; pending: Record<string, Waiting>; compacted: number;
  requested: 'idle' | Waiting | null };

const OPENAI_TTL_MS = 30 * 60_000;
const OPENAI_LONG_TTL_MS = 12 * 3_600_000;
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'oss']);
const FIRE_AT = 0.9;
const MAX_DELAY_MS = 24 * 3_600_000;
const RETRY_MS = 15_000;
const RETRYABLE = /^client(_surface)?_context_changed/;
const NOTICE = 'Compacted after the estimated prompt-cache idle interval';
const CANCELLED = { approval: 'The pending approval was cancelled.', question: 'The unanswered question was cancelled.' };

export default function activate(api: ModAPI) {
  const minutes = Number(api.settings.cache_ttl_minutes) || 0;
  const minTokens = Number(api.settings.min_tokens ?? 100_000);
  const load = (): State => ({ at: 0, ttl: 0, expires: 0, reported: false, identity: '', tokens: 0, running: false, pending: {}, compacted: 0, requested: null,
    ...(api.state.get() as Partial<State> | null) });
  const save = (patch: Partial<State>) => api.state.set({ ...load(), ...patch });
  const live = (state: State) => state.ttl > 0 && state.tokens > 0 && state.tokens >= minTokens && Date.now() < state.expires;
  const arm = (state: State) =>
    api.host.tryCall('events.schedule', { key: 'idle', delay_ms: Math.min(MAX_DELAY_MS, Math.max(1000, Math.round(state.at + (state.expires - state.at) * FIRE_AT - Date.now()))) });

  const identity = (response: ModelResponse) => JSON.stringify([response.provider, response.route, response.credential, response.requested_model, response.served_model]);
  const ttlFor = (response: ModelResponse, state: State): [number, boolean] => {
    if (LOCAL_PROVIDERS.has(response.provider)) return [0, false];
    if (minutes > 0) return [minutes * 60_000, false];
    if (response.provider === 'openai' && (response.cost.basis === 'included_subscription' || response.cost.basis === 'unpriced')) return [0, false];
    const reported = (response.usage as { omd_cache_ttl_seconds?: unknown } | null)?.omd_cache_ttl_seconds;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return [reported * 1000, true];
    const read = (response.cache.read_tokens ?? 0) > 0;
    if (read && state.reported && state.identity === identity(response)) return [state.ttl, true];
    if (response.provider === 'openai' && (read || (response.cache.write_tokens ?? 0) > 0)) return [OPENAI_TTL_MS, false];
    return [0, false];
  };

  api.on('model_response', response => {
    if (response.scope.kind !== 'main' || response.scope.agent_id || response.synthetic) return;
    if (response.status !== 'completed' && response.status !== 'incomplete') return;
    const previous = load();
    if (response.timing.started_at_ms <= previous.compacted) return;
    const { context, tokens } = api.usage.summarize(response);
    const [ttl, reported] = ttlFor(response, previous);
    const at = response.timing.started_at_ms, key = identity(response);
    const expires = response.provider === 'openai' && response.cost.basis !== 'included_subscription' && ttl === OPENAI_LONG_TTL_MS
      && (response.cache.read_tokens ?? 0) > 0
      ? Math.max(previous.ttl === ttl && previous.identity === key ? previous.expires : 0, at + OPENAI_TTL_MS) : at + ttl;
    const state = { ...previous, at, ttl, expires, reported, identity: key,
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
    // Fails while another thread is displayed; retry until the cache expires. Other failures are final.
    if (!started.ok) return void (RETRYABLE.test(started.error) && api.host.tryCall('events.schedule', { key: 'idle', delay_ms: RETRY_MS }));
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
