import type { Json, ModAPI } from '../../api.d.ts';

const service = 'cursor';
const settleKey = 'settle';
// The shared log only grows; its newest rows fit one host result with room for the settle calls.
const LOG_TAIL_BYTES = 32_768;

type Row = Record<string, any>;
type State = { ours: boolean; applied: string[]; polls: number; data?: string | null; thread?: string | null };

// The transport settles a run at 0, 15, 60 and 300 s after it ends; polling at turn end, 75 s and 330 s later reads each of those.
const SETTLE_POLLS_MS = [75_000, 255_000];

function lines(text: string): Row[] {
  return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; } });
}

const cents = (value: number) => `${value.toFixed(2)}¢`;

function leaves(value: unknown, prefix: string): string[] {
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
  return value === null || value === undefined || value === '' ? [] : [`${prefix}: ${value}`];
}

function planReport(plan: Row | undefined): string[] {
  if (!plan) return [];
  const heading = `Plan (undocumented Cursor dashboard RPC, ${new Date(plan.observed_at).toISOString()})`;
  if (plan.unavailable) return [heading, `  unavailable: ${plan.unavailable}`, ''];
  return [heading, ...leaves({ billing_cycle: [plan.billing_cycle_start, plan.billing_cycle_end].filter(Boolean).join(' – '),
    plan_usage: plan.plan_usage, spend_limit_usage: plan.spend_limit_usage, message: plan.message,
    auto_bucket_models: (plan.auto_bucket_models ?? []).join(', ') }, '').slice(0, 40).map(line => `  ${line}`), ''];
}

// Settled runs of one session thread that its ledger has not received yet, as `ledger.settle` arguments.
export function pendingSettlements(log: string, thread: string, applied: string[]): { request_id: string; microusd: number; source: string }[] {
  return lines(log).filter(row => row.kind === 'settlement' && row.status === 'settled' && row.thread === thread
    && typeof row.request_id === 'string' && !applied.includes(row.request_id))
    .map(row => ({ request_id: row.request_id, microusd: Math.round(row.cost.charged_cents * 10_000), source: row.source }));
}

export function usageReport(log: string): string {
  const settlements: Row[] = [];
  let plan: Row | undefined;
  for (const row of lines(log)) {
    if (row.kind === 'plan') plan = row;
    else if (row.kind === 'settlement') settlements.push(row);
  }
  if (!settlements.length) return [...planReport(plan), 'No Cursor usage recorded yet.'].join('\n');
  let raw = 0;
  let charged = 0;
  let pending = 0;
  const rows = settlements.slice(-20).reverse().map(row => {
    const usage = row.usage ?? {};
    const tokens = `in ${usage.inputTokens ?? 0}, out ${usage.outputTokens ?? 0}, cache read ${usage.cacheReadTokens ?? 0}, cache write ${usage.cacheWriteTokens ?? 0}, reasoning ${usage.reasoningTokens ?? 0}`;
    const where = `${row.agent_id}  ${row.request_id ?? 'no request'}  ${row.model}  ${tokens}`;
    if (!row.cost) { pending++; return `${where}  cost unsettled  (${new Date(row.at).toISOString()})`; }
    raw += row.cost.raw_cents;
    charged += row.cost.charged_cents;
    return `${where}  raw ${cents(row.cost.raw_cents)}, charged ${cents(row.cost.charged_cents)}  (${new Date(row.at).toISOString()})`;
  });
  return [...planReport(plan), ...rows, '',
    `Recent runs: raw list cost ${cents(raw)}, charged ${cents(charged)}${pending ? `; ${pending} run(s) unsettled after 5 minutes` : ''}. Charges reach the OMD ledger as provider_reported costs.`,
    'Charged is what Cursor bills beyond included usage. Zero charge can mean plan-included, BYOK or credit-grant usage; the SDK does not say which pool paid a run. Plan pools and spend limits come only from the undocumented dashboard RPC above, and no Cursor source reports cache expiry or context windows.'].join('\n');
}

export default function activate(api: ModAPI): void {
  const state = (): State => ({ ours: false, applied: [], polls: 0, ...(api.state.get() as Partial<State> | null) });
  const ensure = () => {
    const status = api.host.tryCall('sidecars.status', { id: service });
    if (status.ok && (status.value as Row | null)?.running === true) return true;
    if (status.ok) api.host.tryCall('providers.unregister', { id: service });
    const profiles = api.host.tryCall('credentials.list', null);
    const secrets = profiles.ok ? profiles.value.filter(profile => profile.kind === 'secret' && profile.label === 'cursor' && profile.status === 'ready')
      .map(profile => profile.id) : [];
    return api.host.tryCall('providers.register', { id: service, secrets }).ok;
  };
  const read = (path: string, tail = false) => {
    const run = api.host.tryCall('exec.run', tail ? { program: '/usr/bin/tail', argv: ['-c', String(LOG_TAIL_BYTES), path] } : { program: '/bin/cat', argv: [path] });
    return run.ok && run.value.exit_code === 0 ? run.value.stdout : null;
  };
  const route = (): Row | null => {
    try { return typeof api.settings.route === 'string' && api.settings.route ? JSON.parse(read(api.settings.route) ?? '') : null; } catch { return null; }
  };
  // The provider, the route's data directory and the thread are read once per thread at start or resume; each turn only restarts a stopped sidecar.
  const located = (current: State): State => {
    if (current.data && current.thread) return current;
    const data = route()?.data;
    const info = api.host.tryCall('session.info', null);
    return { ...current, data: typeof data === 'string' ? data : null, thread: info.ok ? info.value.thread_id : null };
  };
  const detect = () => {
    const config = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    const ours = config.ok && (config.value as Row).config?.model_provider === 'omd_cursor';
    const current = { ...state(), ours, data: null, thread: null };
    api.state.set(ours ? located(current) : current);
    if (ours) ensure();
  };
  // Cursor prices a run minutes after it ends; each run's charge is applied to this session's ledger once, at turn end and at the two polls that follow it.
  const settle = (poll: boolean) => {
    if (!state().ours) return;
    const current = located(state());
    if (!current.data || !current.thread) return;
    const log = read(`${current.data}/usage.jsonl`, true);
    const applied = [...current.applied];
    for (const settlement of log ? pendingSettlements(log, current.thread, applied).slice(0, 8) : []) {
      const result = api.host.tryCall('ledger.settle', settlement);
      if (result.ok || result.error.includes('not_awaiting_settlement')) applied.push(settlement.request_id);
    }
    const polls = poll ? current.polls + 1 : 0;
    api.state.set({ ...current, applied: applied.slice(-200), polls });
    if (polls < SETTLE_POLLS_MS.length) api.host.tryCall('events.schedule', { key: settleKey, delay_ms: SETTLE_POLLS_MS[polls] });
  };
  api.on('start', detect);
  api.on('resume', detect);
  api.on('turn_start', () => {
    if (state().ours) ensure();
  });
  api.on('turn_end', () => settle(false));
  api.on('timer', ({ key }) => {
    if (key === settleKey) settle(true);
  });
  api.command('cursor', (argument): Json => {
    const action = String(argument ?? '').trim() || 'doctor';
    const config = route();
    if (!config) return { display: 'Cursor is not enrolled for this store; run `omd-package cursor --setup`.' };
    if (action === 'usage') return { display: usageReport(read(`${config.data}/usage.jsonl`, true) ?? '') };
    const expires = config.credential_expires_at_ms ? new Date(config.credential_expires_at_ms).toISOString() : 'not reported';
    return { display: [
      `Cursor SDK ${config.sdk_version} (${config.sdk})`,
      `account: ${config.account ?? 'not reported'}; enrollment key expires ${expires}${config.credential_expires_at_ms && config.credential_expires_at_ms < Date.now() ? ' (expired; rerun setup)' : ''}`,
      `models (${new Date(config.discovered_at_ms).toISOString()}): ${config.models.map((model: Row) => model.id).join(', ')}; default ${config.default}`,
      'tools: Cursor built-ins, ambient settings and MCP servers disabled; only OMD tools under OMD approvals',
      'billing: provider-billed route; charges settle into the OMD ledger as provider_reported costs',
      'context window: not reported by Cursor; the catalog assumes 200K and Cursor manages its own context',
      'launch: omd-package cursor [--model slug]; usage and settled cost: /cursor usage'].join('\n') };
  }, { description: 'Cursor route: doctor | usage' });
}
