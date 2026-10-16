import type { ModAPI, ModelResponse } from '../../api.d.ts';

type Waiting = 'approval' | 'question';
type State = { at: number; ttl: number; reported: boolean; provider: string; tokens: number; running: boolean; pending: Record<string, Waiting>; compacted: number;
  requested: 'idle' | Waiting | null };

// OpenAI keeps a prefix at least 30 minutes after its last use on GPT-5.5 and later; earlier models default to 24h retention (typically about 30 minutes) outside Zero Data Retention.
const OPENAI_TTL_MS = 30 * 60_000;
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'oss']);
const FIRE_AT = 0.9;
const MAX_DELAY_MS = 24 * 3_600_000;
const RETRY_MS = 15_000;
const RETRYABLE = /^client(_surface)?_context_changed/;
const NOTICE = 'Compacted while idle, before the prompt cache expired';
const CANCELLED = { approval: 'The pending approval was cancelled.', question: 'The unanswered question was cancelled.' };

export default function activate(api: ModAPI) {
  const minutes = Number(api.settings.cache_ttl_minutes) || 0;
  const minTokens = Number(api.settings.min_tokens ?? 100_000);
  const load = (): State => ({ at: 0, ttl: 0, reported: false, provider: '', tokens: 0, running: false, pending: {}, compacted: 0, requested: null,
    ...(api.state.get() as Partial<State> | null) });
  const save = (patch: Partial<State>) => api.state.set({ ...load(), ...patch });
  const live = (state: State) => state.ttl > 0 && state.tokens > 0 && state.tokens >= minTokens && Date.now() < state.at + state.ttl;
  const arm = (state: State) =>
    api.host.tryCall('events.schedule', { key: 'idle', delay_ms: Math.min(MAX_DELAY_MS, Math.max(1000, Math.round(state.at + state.ttl * FIRE_AT - Date.now()))) });

  // A provider reports its TTL only on responses that write the cache; reads keep the TTL it last reported.
  const ttlFor = (response: ModelResponse, state: State): [number, boolean] => {
    if (LOCAL_PROVIDERS.has(response.provider)) return [0, false];
    if (minutes > 0) return [minutes * 60_000, false];
    const reported = (response.usage as { omd_cache_ttl_seconds?: unknown } | null)?.omd_cache_ttl_seconds;
    if (typeof reported === 'number' && reported > 0) return [reported * 1000, true];
    if (state.reported && state.provider === response.provider) return [state.ttl, true];
    return [OPENAI_TTL_MS, false];
  };

  api.on('model_response', response => {
    if (response.scope.kind !== 'main' || response.scope.agent_id || response.synthetic) return;
    if (response.status !== 'completed' && response.status !== 'incomplete') return;
    const previous = load();
    if (response.timing.started_at_ms <= previous.compacted) return;
    const { context, tokens } = api.usage.summarize(response);
    const [ttl, reported] = ttlFor(response, previous);
    const state = { ...previous, at: response.timing.started_at_ms, ttl, reported, provider: response.provider,
      tokens: context?.used ?? (tokens.input ?? 0) + (tokens.output ?? 0) };
    save(state);
    if (live(state)) arm(state);
    else api.host.tryCall('events.cancel', { key: 'idle' });
  });

  api.on('timer', () => {
    const state = load();
    if (!live(state)) return;
    if (state.at + state.ttl * FIRE_AT - Date.now() > 1000) return void arm(state);
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
