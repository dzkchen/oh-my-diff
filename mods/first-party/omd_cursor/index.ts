import type { Json, ModAPI, ProviderModel } from '../../api.d.ts';

const service = 'cursor';
const provider = 'omd_cursor';
const session = 'cursor_setup';
const settleKey = 'settle';
const setupKey = 'setup';
const setupWindow = 30 * 60_000;
// The shared log only grows; its newest rows fit one host result with room for the settle calls.
const LOG_TAIL_BYTES = 32_768;
const LOG_TAIL_TIMEOUT_MS = 5_000;
const SETTLE_POLLS = 6;
const OUTPUT_BYTES = 12_288;
export const ACCOUNT = /^[a-z][a-z0-9_-]{0,23}$/;
const NODE_MISSING = 'Node.js was not found on PATH. Install it (brew install node, or from nodejs.org), restart OMD, then try again';

type Row = Record<string, any>;
type Settle = { thread: string; applied: string[]; polls: number };

const plain = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

function lines(text: string): Row[] {
  return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; } });
}

const cents = (value: number) => `${value.toFixed(2)}¢`;

function leaves(value: unknown, prefix: string): string[] {
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
  return value === null || value === undefined || value === '' ? [] : [`${prefix}: ${value}`];
}

function planReport(plan: Row): string[] {
  const heading = `Plan of account ${plan.account} (undocumented Cursor dashboard RPC, ${new Date(plan.observed_at).toISOString()})`;
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
  const plans = new Map<string, Row>();
  for (const row of lines(log)) {
    if (row.kind === 'plan') plans.set(row.account, row);
    else if (row.kind === 'settlement') settlements.push(row);
  }
  const plan = [...plans.values()].flatMap(planReport);
  if (!settlements.length) return [...plan, 'No Cursor usage recorded yet.'].join('\n');
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
  return [...plan, ...rows, '',
    `Recent runs: raw list cost ${cents(raw)}, charged ${cents(charged)}${pending ? `; ${pending} run(s) unsettled after 5 minutes` : ''}. Charges reach the OMD ledger as provider_reported costs.`,
    'Charged is what Cursor bills beyond included usage. Zero charge can mean plan-included, BYOK or credit-grant usage; the SDK does not say which pool paid a run. Plan pools and spend limits come only from the undocumented dashboard RPC above, and no Cursor source reports cache expiry or context windows.'].join('\n');
}

export default function activate(api: ModAPI): void {
  const saved = (): Row => plain(api.state.get()) ? api.state.get() as Row : {};
  const say = (text: string, error = false) =>
    api.host.tryCall('terminal.notice', { text, kind: error ? 'error' : 'info', placement: 'transcript' });
  const ensure = (restart = false) => {
    const status = api.host.tryCall('sidecars.status', { id: service });
    if (!restart && status.ok && status.value.running) return true;
    if (status.ok) api.host.tryCall('providers.unregister', { id: service });
    const models = saved().models;
    const profiles = api.host.tryCall('credentials.list', null);
    const owned = new Set(((saved().accounts ?? []) as Row[]).map(account => account.secret));
    const secrets = profiles.ok ? profiles.value.filter(profile => profile.kind === 'secret' && owned.has(profile.id) && profile.status === 'ready')
      .map(profile => profile.id) : [];
    const published = Array.isArray(models) && api.host.tryCall('providers.register', { id: service, secrets }).ok &&
      api.host.tryCall('providers.models', { provider, name: 'Cursor', models: models as ProviderModel[] }).ok;
    api.state.set({ ...saved(), published });
    return published;
  };
  const tail = (path: string) => {
    const run = api.host.tryCall('exec.run', { program: '/usr/bin/tail', argv: ['-c', String(LOG_TAIL_BYTES), path], timeout_ms: LOG_TAIL_TIMEOUT_MS });
    return run.ok && run.value.exit_code === 0 ? run.value.stdout : null;
  };
  // Cursor prices a run minutes after it ends; poll through six minutes and drain ready charges in bounded batches.
  const settle = (poll: boolean) => {
    const data = saved().data;
    if (typeof data !== 'string') return;
    const thread = api.session().thread_id;
    const previous = saved().settle;
    const current: Settle = plain(previous) && previous.thread === thread ? previous as Settle : { thread, applied: [], polls: 0 };
    const log = tail(`${data}/usage.jsonl`);
    const applied = [...current.applied];
    const pending = log ? pendingSettlements(log, thread, applied) : [];
    for (const settlement of pending.slice(0, 8)) {
      const result = api.host.tryCall('ledger.settle', settlement);
      if (result.ok || result.error.includes('not_awaiting_settlement')) applied.push(settlement.request_id);
    }
    const polls = poll ? Math.min(current.polls + 1, SETTLE_POLLS) : 0;
    const recent = log === null ? null : new Set(lines(log).filter(row => row.thread === thread).map(row => row.request_id));
    api.state.set({ ...saved(), settle: { thread, applied: recent ? applied.filter(id => recent.has(id)) : applied, polls } });
    if (polls < SETTLE_POLLS || pending.length > 8 && applied.length > current.applied.length)
      api.host.tryCall('events.schedule', { key: settleKey, delay_ms: polls < SETTLE_POLLS ? 60_000 : 1_000 });
  };
  const output = (run: Row) => {
    let out = String(run.out);
    for (let reads = 0; reads < 16; reads++) {
      const read = api.host.tryCall('process.exchange', { session, wait_ms: 0 });
      const chunks = read.ok ? read.value.messages as Row[] : [];
      if (!chunks.length) break;
      out = (out + chunks.map(chunk => chunk.data ?? '').join('')).slice(-OUTPUT_BYTES);
    }
    return out;
  };
  // The host reports no exit status for a managed process, so setup.mjs prints a result or error line as its last output.
  api.on('process_event', ({ session: id, kind }) => {
    const run = saved().setup;
    if (id !== session || !plain(run)) return;
    const out = output(run);
    if (kind !== 'exit') {
      const link = run.shown ? null : /^OMD_CURSOR_LINK (\S+)$/m.exec(out)?.[1];
      if (link) { say('Approve Oh My Diff in your browser to enroll Cursor; if it does not open, open this link:'); say(link); }
      return void api.state.set({ ...saved(), setup: { ...run, out, shown: run.shown || !!link } });
    }
    api.host.tryCall('process.stop', { session });
    api.host.tryCall('events.cancel', { key: setupKey });
    api.state.set({ ...saved(), setup: null });
    const result = /^OMD_CURSOR_RESULT (.+)$/m.exec(out)?.[1];
    if (!result) {
      const failure = /^OMD_CURSOR_ERROR (.+)$/m.exec(out)?.[1] ?? out.trim().split('\n').pop() ?? '';
      return void say(`Cursor setup failed: ${failure || 'no output'}`, true);
    }
    let done: Row;
    try { done = JSON.parse(result); } catch { return void say('Cursor setup returned an unreadable result; run /cursor setup again', true); }
    api.state.set({ ...saved(), ...done });
    if (!ensure(true)) return void say('Cursor setup finished, but the provider did not start; restart OMD+ and run /cursor', true);
    const account = (done.accounts as Row[]).find(item => item.name === run.account);
    say(`Cursor account ${run.account} is ready${account?.account ? ` for ${account.account}` : ''}; pick its models with /model or switch with /profile`);
  });
  api.on('channel', ({ channel, data }) => {
    const name = String((data as Row | null)?.account ?? 'default');
    if (channel === `${api.package.id}/removed`) {
      api.state.set({ ...saved(), ...(data as Row).result });
      if ((data as Row).result.accounts.length) return void ensure(true);
      api.host.tryCall('providers.unregister', { id: service });
      return void api.state.set({ ...saved(), published: false });
    }
    if (channel !== `${api.package.id}/setup`) return;
    const installed = api.host.tryCall('packages.list', { fields: ['id', 'path'] });
    const mod = installed.ok ? installed.value.packages.find(item => item.id === api.package.id)?.path : null;
    if (!mod) return void say('Cursor setup could not find the installed mod; enable it in /mods and run /cursor setup again', true);
    const found = api.host.tryCall('process.which', { names: ['node'], sandbox: 'none' });
    const node = found.ok ? found.value.found[0] : null;
    if (!node) return void say(`Cursor setup did not start: ${found.ok ? NODE_MISSING : found.error}`, true);
    api.host.tryCall('process.stop', { session });
    const started = api.host.tryCall('process.start', { session, name: 'node', path: node.path, sha256: node.sha256,
      arguments: [`${mod}/setup.mjs`, name], sandbox: 'none', framing: 'raw', notify: ['output', 'exit'] });
    if (!started.ok) return void say(`Cursor setup did not start: ${started.error}`, true);
    api.state.set({ ...saved(), mod, setup: { out: '', shown: false, account: name } });
    api.host.tryCall('events.schedule', { key: setupKey, delay_ms: setupWindow });
  });
  api.on('start', () => {
    if (plain(saved().setup)) {
      api.host.tryCall('events.cancel', { key: setupKey });
      api.state.set({ ...saved(), setup: null });
    }
    ensure();
  });
  api.on('resume', () => { ensure(); });
  api.on('turn_start', () => {
    if (api.session().provider === provider) ensure();
  });
  api.on('turn_end', () => {
    if (api.session().provider === provider) settle(false);
  });
  api.on('timer', ({ key }) => {
    if (key === settleKey) settle(true);
    if (key === setupKey && plain(saved().setup)) {
      api.host.tryCall('process.stop', { session });
      api.state.set({ ...saved(), setup: null });
      say(`Cursor setup timed out after ${setupWindow / 60_000} minutes without finishing; check your network and that pnpm and omd-mod work, then run /cursor setup again`, true);
    }
  });
  api.command('cursor', (args): Json => {
    const [action = 'doctor', name, extra] = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const usage = 'Usage: /cursor (doctor) | /cursor setup [NAME] | /cursor remove NAME | /cursor usage';
    const state = saved();
    if (action === 'setup' || action === 'login') {
      const account = name ?? 'default';
      if (extra !== undefined || !ACCOUNT.test(account)) return { display: `Account names start with a letter and use lowercase letters, digits, _ or - (at most 24). ${usage}` };
      const hop = api.host.tryCall('events.publish', { channel: 'setup', data: { account } });
      if (!hop.ok || hop.value.delivered === 0) return { display: 'Cursor setup could not be started; run /cursor setup again' };
      return { display: `Starting Cursor setup for account ${account}: it installs the Cursor SDK, then asks you to approve Oh My Diff in the browser; progress shows below` };
    }
    if (action === 'remove' && name && extra === undefined) {
      const account = ((state.accounts ?? []) as Row[]).find(item => item.name === name);
      const mod = state.mod;
      if (!account || typeof mod !== 'string') return { display: account ? 'Run /cursor setup once in this OMD install, then try again' : `Unknown Cursor account ${name}` };
      const run = api.host.tryCall('exec.run', { program: 'node', argv: [`${mod}/setup.mjs`, name, '--remove'], sandbox: 'none', timeout_ms: 120_000 });
      const result = run.ok ? /^OMD_CURSOR_RESULT (.+)$/m.exec(run.value.stdout)?.[1] : undefined;
      if (!result) return { display: `Cursor account ${name} was not removed: ${run.ok ? /^OMD_CURSOR_ERROR (.+)$/m.exec(run.value.stdout)?.[1] ?? 'no result' : run.error.startsWith('exec_program_unavailable') ? NODE_MISSING : run.error}` };
      api.host.tryCall('events.publish', { channel: 'removed', data: { result: JSON.parse(result) } });
      const forgot = api.host.tryCall('credentials.request', { action: 'remove', profile: String(account.secret) });
      const revoke = 'the key stays valid at Cursor until you revoke "Oh My Diff" under API keys in your Cursor dashboard';
      return { display: `Removed Cursor account ${name}${forgot.ok && forgot.value.status === 'completed' ? ` and OMD's copy of its key; ${revoke}` : `; OMD kept its copy of the key, and ${revoke}`}` };
    }
    if (action !== 'usage' && action !== 'doctor') return { display: usage };
    if (typeof state.data !== 'string') return { display: 'Cursor is not set up; run /cursor setup.' };
    if (action === 'usage') return { display: usageReport(tail(`${state.data}/usage.jsonl`) ?? '') };
    const models = Array.isArray(state.models) ? state.models as ProviderModel[] : [];
    const accounts = (state.accounts ?? []) as Row[];
    return { display: [
      `Cursor SDK ${state.sdk}`,
      ...accounts.map(account => {
        const expired = typeof account.expires === 'number' && account.expires < Date.now();
        return `account ${account.name}: ${account.account ?? 'not reported'}; key expires ${typeof account.expires === 'number' ? new Date(account.expires).toISOString() : 'not reported'}${expired ? ` (expired; run /cursor setup${account.name === 'default' ? '' : ` ${account.name}`})` : ''}; default ${account.default}`;
      }),
      `models: ${state.published === true ? `${models.length} published to /model` : 'none published'}: ${models.map(model => model.slug).join(', ')}`,
      'tools: Cursor built-ins, ambient settings and MCP servers disabled; only OMD tools under OMD approvals',
      'billing: provider-billed route; charges settle into the OMD ledger as provider_reported costs',
      'context window: not reported by Cursor; the catalog assumes 200K and Cursor manages its own context',
      'usage and settled cost: /cursor usage'].join('\n') };
  }, { description: 'Set up Cursor accounts (setup [NAME] | remove NAME), show their status (doctor) or usage', args_hint: '[setup [NAME] | remove NAME | usage]' });
}
