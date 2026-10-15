import type { Json, ModAPI } from '../../api.d.ts';

type Kind = 'approval' | 'permission' | 'question' | 'elicitation';
type Pending = { request_id: Json; kind: Kind; questions: string[]; deadline: number };
type State = { pending: Record<string, Pending> };

const CHANNEL = 'request';
const KINDS: Record<string, Kind> = {
  'item/commandExecution/requestApproval': 'approval',
  'item/fileChange/requestApproval': 'approval',
  'item/permissions/requestApproval': 'permission',
  'item/tool/requestUserInput': 'question',
  'mcpServer/elicitation/request': 'elicitation',
};
const ANSWER = 'No answer within the time limit (the user may be away). Proceed with your best judgment, preferring the recommended option, and state the assumption you made.';
const RETRY_MS = 10_000;
const FINAL = /^app_(request_not_pending|request_not_subscribed|response_refused|request_id_invalid)/;
const WHAT: Record<Kind, string> = { approval: 'the approval was declined', permission: 'the permission request was denied', question: 'the question was answered with "use your best judgment"', elicitation: 'the MCP request was declined' };

export default function activate(api: ModAPI) {
  const seconds = Number(api.settings.timeout_seconds ?? 120);
  const limit = Number.isFinite(seconds) && seconds > 0 ? Math.round(Math.min(Math.max(seconds, 1), 86_400) * 1000) : 0;
  const load = (): State => ({ pending: {}, ...(api.state.get() as Partial<State> | null) });
  const arm = (state: State) => {
    const next = Math.min(...Object.values(state.pending).map(item => item.deadline));
    if (Number.isFinite(next)) api.host.tryCall('events.schedule', { key: 'deadline', delay_ms: Math.max(1000, next - Date.now()) });
    else api.host.tryCall('events.cancel', { key: 'deadline' });
  };
  const result = (item: Pending): Json => {
    if (item.kind === 'approval') return { decision: 'decline' };
    if (item.kind === 'permission') return { permissions: {} };
    if (item.kind === 'elicitation') return { action: 'decline' };
    return { answers: Object.fromEntries(item.questions.map(id => [id, { answers: [ANSWER] }])) };
  };

  api.on('app_server_request', event => {
    const kind = KINDS[event.method];
    if (!limit || !kind) return;
    const questions = event.phase === 'requested' && kind === 'question'
      ? ((event.params as { questions?: { id?: unknown }[] } | null)?.questions ?? []).map(question => question.id).filter((id): id is string => typeof id === 'string')
      : [];
    api.host.tryCall('events.publish', { channel: CHANNEL, data: { request_id: event.request_id, phase: event.phase, kind, questions } });
    if (event.phase === 'requested') {
      api.host.tryCall('terminal.notice', { text: `Auto-continues in ${Math.round(limit / 1000)} s if unanswered`, kind: 'info', placement: 'toast', ttl_ms: 8000 });
    }
  });

  // Request ids restart with the app-server, and a fork inherits its parent's state: neither may answer a stale id.
  const reset = () => {
    api.state.set({ pending: {} });
    api.host.tryCall('events.cancel', { key: 'deadline' });
  };

  api.on('channel', event => {
    if (event.channel !== `omd_auto_continue/${CHANNEL}`) return;
    if (!limit) return reset();
    const data = event.data as { request_id: Json; phase: string; kind: Kind; questions: string[] };
    const state = load(), key = JSON.stringify(data.request_id);
    if (data.phase === 'requested') state.pending[key] = { request_id: data.request_id, kind: data.kind, questions: data.questions, deadline: Date.now() + limit };
    else delete state.pending[key];
    api.state.set(state);
    arm(state);
  });

  api.on('timer', () => {
    if (!limit) return reset();
    const state = load(), now = Date.now();
    for (const [key, item] of Object.entries(state.pending)) {
      if (item.deadline > now) continue;
      const answered = api.host.tryCall('app.respond', { request_id: item.request_id, result: result(item) });
      if (!answered.ok && !FINAL.test(answered.error)) {
        item.deadline = now + RETRY_MS;
        continue;
      }
      delete state.pending[key];
      if (!answered.ok) continue;
      api.host.tryCall('terminal.notice', { text: `No answer within ${Math.round(limit / 1000)} s (the user may be away), so ${WHAT[item.kind]} automatically. Continue with work that does not depend on it.`,
        kind: 'info', placement: 'transcript', audience: 'model' });
    }
    api.state.set(state);
    arm(state);
  });

  api.on('start', reset);
  api.on('resume', event => { if (event.restarted) reset(); });
}
