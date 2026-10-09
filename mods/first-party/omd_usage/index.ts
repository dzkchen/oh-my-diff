import type { CostBasis, Json, Ledger, ModAPI, TerminalComponent, TerminalListRow, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Tokens = { input: number | null; cached: number | null; write: number | null; output: number | null; reasoning: number | null };
type Reported = { usd: number; basis: 'provider_billed' | 'client_list_estimate' };
type Entry = {
  key: string; request: string; attempt: number; billing: number | null; thread: string; agent: string | null; kind: string; turn: string | null;
  provider: string; credential: string | null; route: string; requested: string; served: string | null; status: string;
  tokens: Tokens | null; estimated: boolean; window: number | null; cost: { microusd: number | null; basis: CostBasis };
  reported: Reported | null; overage: boolean; ttl: number | null; at: number; synthetic: string | null; revision: number;
};
type Sample = { scope: string; minutes: number | null; used: number; resets: number | null; at: number; seen: number };
type Hud = {
  thread: string | null; entries: Entry[]; dropped: number; since: number | null; turn: string | null; detail: boolean;
  current: { model: string | null; provider: string | null; effort: string | null }; tick: number; room: { size: number | null; compact: number | null };
  compaction: { started: number; installed: number; start: number | null; end: number | null; trigger: string | null };
  reverted: number | null; samples: Sample[]; credits: string | null;
  agents: Record<string, { role: string; status: string; at: number }>; tools: Record<string, { tool: string; at: number }>;
  plan: { done: number; total: number; step: string | null } | null;
  assembled: { at: number; bytes: number; categories: [string, number][] } | null;
};
type Allowance = { used: number; limit: number; requests: number; max: number };
type Snapshot = { open: boolean; ledger: Ledger | null; error: string | null; allowance: Allowance | null; hud: Hud };
type Charge = { kind: 'billed' | 'estimate' | 'pending' | 'included' | 'unknown' | 'none'; usd: number | null; list: number | null };

const MAX_ENTRIES = 120;
const MAX_BYTES = 52_000;
const MAX_SAMPLES = 32;
const HUD: Hud = {
  thread: null, entries: [], dropped: 0, since: null, turn: null, detail: false, current: { model: null, provider: null, effort: null }, tick: 0, room: { size: null, compact: null },
  compaction: { started: 0, installed: 0, start: null, end: null, trigger: null }, reverted: null, samples: [], credits: null, agents: {}, tools: {}, plan: null, assembled: null,
};
const EMPTY: Snapshot = { open: false, ledger: null, error: null, allowance: null, hud: HUD };
const SPARK = ' .:-=+*#';

export default function activate(api: ModAPI) {
  const categories = api.settings.categories === true;
  const budget = typeof api.settings.budget_usd === 'number' && api.settings.budget_usd > 0 ? api.settings.budget_usd : null;
  const saved = (): Snapshot => {
    const stored = api.state.get() as Partial<Snapshot> | null ?? {};
    return { ...EMPTY, ...stored, hud: { ...HUD, ...stored.hud } };
  };
  const save = (state: Snapshot) => api.state.set(state as unknown as Json);
  const hud = (change: (hud: Hud) => void) => { const state = saved(); change(state.hud); save(state); };
  const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const visible = (value: string, limit = 160) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, limit);
  const fit = (text: string, max: number) => [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
  const paid = (cost: Record<string, Json> | null) => typeof cost?.settled_task_charge_microusd === 'number' ? `$${(cost.settled_task_charge_microusd / 1e6).toFixed(2)} paid API` : 'no paid API use recorded';
  const usd = (value: number) => `$${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
  const count = (n: number) => n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
  const span = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.round(minutes / 1440)}d`;
  };
  const windowName = (minutes: number | null) => minutes === null ? 'window' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  const text = (id: string, label: string, body: string): TerminalComponent => ({ type: 'text', id, label, text: visible(body, 4000) });
  const multiline = (id: string, label: string, lines: string[]): TerminalComponent => ({ type: 'text', id, label, text: lines.map(line => line.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '?')).join('\n').slice(0, 4000) });

  const capture = (state: Snapshot): Snapshot => {
    const task = api.host.tryCall('task.status', null);
    const cost = object(task.ok ? task.value.ledger.cost : null);
    const limits = object(task.ok ? task.value.limits : null);
    const attempts: Record<string, any>[] = Array.isArray(cost.attempts) ? cost.attempts.map(object) : [];
    const entries = state.hud.entries.map(entry => {
      const settled = attempts.find(attempt => attempt.request === entry.billing);
      return entry.cost.basis === 'unsettled' && settled && number(settled.settled_microusd) !== null
        ? { ...entry, cost: { microusd: settled.settled_microusd, basis: (settled.provider_billed === true ? 'provider_reported' : 'settled') as CostBasis }, revision: entry.revision + 1 } : entry;
    });
    return {
      ...state,
      ledger: task.ok ? { ...task.value.ledger, cost: { settled_task_charge_microusd: number(cost.settled_task_charge_microusd) } } : state.ledger,
      error: task.ok ? null : `Task status unavailable: ${visible(task.error, 120)}`,
      allowance: task.ok && number(limits.exposure_microusd) ? { used: number(cost.retained_exposure_upper_bound_microusd) ?? 0, limit: limits.exposure_microusd, requests: attempts.length, max: number(limits.requests) ?? 0 } : null,
      hud: { ...state.hud, entries },
    };
  };

  const charge = (entry: Entry): Charge => {
    const list = entry.reported?.basis === 'client_list_estimate' ? entry.reported.usd : null;
    if (entry.synthetic || entry.cost.basis === 'synthetic') return { kind: 'none', usd: null, list: null };
    if (entry.reported?.basis === 'provider_billed') return { kind: 'billed', usd: entry.reported.usd, list: null };
    if (entry.cost.basis === 'provider_reported' && entry.cost.microusd !== null) return { kind: 'billed', usd: entry.cost.microusd / 1e6, list: null };
    if (entry.cost.basis === 'settled' && entry.cost.microusd !== null) return { kind: 'estimate', usd: entry.cost.microusd / 1e6, list };
    if (entry.cost.basis === 'unsettled') return { kind: 'pending', usd: null, list };
    if (entry.cost.basis === 'included_subscription') return { kind: 'included', usd: null, list };
    return { kind: 'unknown', usd: null, list };
  };
  const totals = (entries: Entry[]) => entries.map(charge).reduce((sum, item) => ({
    billed: sum.billed + (item.kind === 'billed' ? item.usd! : 0), estimate: sum.estimate + (item.kind === 'estimate' ? item.usd! : 0),
    pending: sum.pending + (item.kind === 'pending' ? 1 : 0), included: sum.included + (item.kind === 'included' ? 1 : 0),
    list: sum.list + (item.list ?? 0), unknown: sum.unknown + (item.kind === 'unknown' ? 1 : 0),
  }), { billed: 0, estimate: 0, pending: 0, included: 0, list: 0, unknown: 0 });
  const spendText = (sum: ReturnType<typeof totals>) => [
    sum.billed ? `${usd(sum.billed)} billed` : '', sum.estimate ? `~${usd(sum.estimate)} configured-rate est.` : '',
    sum.included ? `${sum.included} included${sum.list ? ` (~${usd(sum.list)} list-equivalent)` : ''}` : '',
    sum.pending ? `${sum.pending} unsettled` : '', sum.unknown ? `${sum.unknown} unknown cost` : '',
  ].filter(Boolean).join(' · ') || 'no priced requests';

  const isLead = (hud: Hud, entry: Entry) => entry.kind === 'main' && !entry.agent && (hud.thread === null || entry.thread === hud.thread);
  const leads = (hud: Hud) => hud.entries.filter(entry => isLead(hud, entry) && entry.tokens?.input !== null && entry.tokens !== null);
  const context = (hud: Hud) => {
    const last = leads(hud).at(-1);
    if (!last) return null;
    const used = (last.tokens!.input ?? 0) + (last.tokens!.output ?? 0);
    const stale = hud.compaction.end !== null && hud.compaction.end > last.at ? 'compacted since'
      : hud.reverted !== null && hud.reverted > last.at ? 'rewound since'
        : hud.current.model && hud.current.model !== last.requested || hud.current.provider && hud.current.provider !== last.provider ? 'route switched since' : null;
    return { last, used, window: last.window ?? hud.room.size, stale };
  };
  const cacheTtl = (hud: Hud, last: Entry) => {
    const same = hud.entries.filter(entry => entry.provider === last.provider && entry.credential === last.credential && (entry.served ?? entry.requested) === (last.served ?? last.requested));
    const ttl = same.filter(entry => entry.ttl !== null).at(-1)?.ttl ?? null;
    const used = same.filter(entry => (entry.tokens?.cached ?? 0) > 0 || (entry.tokens?.write ?? 0) > 0).at(-1);
    return ttl !== null && used ? used.at + ttl * 1000 : null;
  };
  const quota = (hud: Hud, now: number) => {
    const groups = new Map<number | null, Sample[]>();
    for (const sample of hud.samples.filter(item => item.scope === 'codex-account')) groups.set(sample.minutes, [...groups.get(sample.minutes) ?? [], sample]);
    return [...groups.values()].map(samples => {
      const current = samples.at(-1)!;
      const passed = current.resets !== null && now > current.resets;
      const period = samples.filter(sample => sample.resets === current.resets || sample.resets !== null && current.resets !== null && Math.abs(sample.resets - current.resets) < 60000);
      const first = period[0];
      const horizon = Math.max(300000, (current.minutes ?? 0) * 6000);
      const rate = period.length > 1 && current.at - first.at >= horizon ? (current.used - first.used) / (current.at - first.at) : null;
      const projected = rate !== null && current.resets !== null && !passed ? Math.round(current.used + rate * (current.resets - now)) : null;
      return { name: `Codex account ${windowName(current.minutes)}`, current, passed, projected, samples: period.length, spanned: current.at - first.at };
    }).sort((a, b) => (a.current.minutes ?? 0) - (b.current.minutes ?? 0));
  };

  // Published data must not depend on the clock: a replayed callback has to repeat the same host-call arguments.
  const publish = () => {
    const state = saved(); const current = context(state.hud);
    const sum = totals(state.hud.entries);
    const tight = quota(state.hud, 0).sort((a, b) => b.current.used - a.current.used)[0];
    const spent = sum.billed + sum.estimate;
    const last = current?.last;
    api.host.tryCall('events.publish', { channel: 'hud', data: {
      thread: state.hud.thread ?? last?.thread ?? null,
      cache: last && last.tokens?.input ? { ratio: (last.tokens.cached ?? 0) / last.tokens.input, expires: cacheTtl(state.hud, last) } : null,
      spend: { usd: spent || null, kind: sum.billed && sum.estimate ? 'mixed' : sum.billed ? 'billed' : sum.estimate ? 'estimate' : sum.included ? 'included' : 'none', uncertain: sum.unknown + sum.pending > 0, list: sum.list || null },
      quota: tight ? { name: tight.name, used: tight.current.used, resets: tight.current.resets, observed: tight.current.seen } : null,
      budget: budget === null ? null : spent >= budget ? 'over' : spent >= budget * 0.8 ? 'warn' : null,
    } });
  };

  const record = (hud: Hud, entry: Entry) => {
    const rank = (item: Entry) => (item.tokens && !item.estimated ? 2 : 0) + (item.cost.basis === 'settled' ? 1 : 0);
    const plain = (item: Entry) => JSON.stringify({ ...item, revision: 0, turn: null });
    const index = hud.entries.findIndex(item => item.key === entry.key);
    const old = hud.entries[index];
    if (!old) hud.entries.push(entry);
    else if (rank(entry) >= rank(old) && plain(entry) !== plain(old)) hud.entries[index] = { ...entry, turn: old.turn, revision: old.revision + 1 };
    hud.entries.sort((a, b) => a.at - b.at);
    const before = hud.entries.length;
    let size = JSON.stringify(hud).length;
    while (hud.entries.length > 1 && (hud.entries.length > MAX_ENTRIES || size > MAX_BYTES)) size -= JSON.stringify(hud.entries.shift()).length + 1;
    const extra = before - hud.entries.length;
    if (extra > 0) {
      hud.dropped += extra;
      hud.since = hud.entries[0].at;
    }
  };

  const limits = (hud: Hud, params: Record<string, any>, now: number) => {
    const snapshot = object(params.rateLimits);
    const scope = 'codex-account';
    for (const name of ['primary', 'secondary']) {
      const slot = object(snapshot[name]);
      const used = number(slot.usedPercent);
      if (used === null) continue;
      const minutes = number(slot.windowDurationMins);
      const at = number(slot.resetsAt);
      const resets = at === null ? null : at < 1e12 ? at * 1000 : at;
      const group = hud.samples.filter(sample => sample.scope === scope && sample.minutes === minutes);
      const latest = group.at(-1);
      if (latest && latest.used === used && latest.resets === resets) latest.seen = now;
      else hud.samples.push({ scope, minutes, used, resets, at: now, seen: now });
    }
    const credits = object(snapshot.credits);
    if (Object.keys(credits).length) hud.credits = credits.unlimited ? 'unlimited' : credits.hasCredits ? `balance ${visible(String(credits.balance ?? '?'), 24)}` : 'none';
    const kept: Sample[] = [];
    for (const sample of [...hud.samples].reverse()) {
      const peers = kept.filter(item => item.scope === sample.scope && item.minutes === sample.minutes).length;
      if (peers < MAX_SAMPLES && now - sample.at <= Math.max((sample.minutes ?? 0) * 60000, 3600000)) kept.unshift(sample);
    }
    hud.samples = kept.slice(-4 * MAX_SAMPLES);
  };

  const prompt = (state: Snapshot, now: number): TerminalComponent[] => {
    const h = state.hud; const current = context(h); const sum = totals(h.entries);
    const usage: string[] = [];
    if (current?.last.tokens?.input) {
      const expires = cacheTtl(h, current.last);
      usage.push(`Cache ${Math.round((current.last.tokens.cached ?? 0) / current.last.tokens.input * 100)}% hit${expires === null ? '' : expires > now ? ` · ~${span(expires - now)} TTL` : ' · TTL passed'}`);
    }
    for (const slot of quota(h, now)) usage.push(slot.passed ? `${slot.name} reset passed · stale` : `${slot.name} ${slot.current.used}%${slot.current.resets ? ` · resets ${span(slot.current.resets - now)}` : ''}`);
    usage.push(fit(spendText(sum), 34));
    if (state.allowance) {
      const filled = Math.min(10, Math.round(state.allowance.used / state.allowance.limit * 10));
      usage.push(`[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${usd(state.allowance.used / 1e6)}/${usd(state.allowance.limit / 1e6)}`);
    }
    if (budget !== null) usage.push(`Budget ${usd(sum.billed + sum.estimate)} of ${usd(budget)} (soft)`);
    const agents = Object.entries(h.agents).filter(([, agent]) => agent.status === 'running');
    const workers = [
      ...(h.plan ? [`Tasks ${h.plan.done}/${h.plan.total}${h.plan.step ? ` · ${h.plan.step}` : ''}`] : []),
      ...agents.slice(0, 4).map(([id, agent]) => `${agent.role} · ${id.slice(0, 8)}`),
      ...Object.values(h.tools).slice(0, 3).map(tool => `running ${tool.tool}`),
    ];
    const tone = (body: string): TerminalTone => /stale|passed|unknown|unsettled/.test(body) ? 'attention' : 'muted';
    const spans = (parts: string[]) => parts.slice(0, 6).flatMap((body, index) => [...(index ? [{ text: ' · ', tone: 'muted' as const }] : []), { text: fit(body, 40), tone: tone(body) }]);
    return [{ type: 'box', id: 'omd_usage_prompt', label: 'Usage', style: { direction: 'row', gap: 2, padding: [0, 1] }, children: [
      { type: 'line', id: 'omd_usage_prompt_usage', label: 'Usage', spans: spans(usage) },
      ...(workers.length ? [{ type: 'line' as const, id: 'omd_usage_prompt_workers', label: `Tasks and workers${agents.length ? ` (${agents.length})` : ''}`, spans: spans(workers) }] : []),
    ] }];
  };

  const expanded = (state: Snapshot, now: number): TerminalComponent[] => {
    const h = state.hud; const current = context(h);
    const lead = h.entries.filter(entry => isLead(h, entry)); const workers = h.entries.filter(entry => !isLead(h, entry) && (entry.kind !== 'main' || entry.agent));
    const inherited = h.entries.filter(entry => entry.kind === 'main' && !entry.agent && h.thread !== null && entry.thread !== h.thread);
    const tokens = (entries: Entry[]) => entries.reduce((sum, entry) => ({ input: sum.input + (entry.tokens?.input ?? 0), cached: sum.cached + (entry.tokens?.cached ?? 0), write: sum.write + (entry.tokens?.write ?? 0), output: sum.output + (entry.tokens?.output ?? 0), unmeasured: sum.unmeasured + (entry.tokens ? 0 : 1), writes: sum.writes || entry.tokens?.write !== null && entry.tokens?.write !== undefined }), { input: 0, cached: 0, write: 0, output: 0, unmeasured: 0, writes: false });
    const leadTokens = tokens(lead);
    const contextLines: string[] = [];
    if (current) {
      const last = current.last;
      contextLines.push(`Model ${visible(last.served ?? last.requested, 60)}${last.served && last.served !== last.requested ? ` (requested ${visible(last.requested, 40)})` : ''} · ${visible(last.provider, 30)} · route ${visible(last.route, 30)}${h.current.effort ? ` · reasoning ${visible(h.current.effort, 20)}` : ''}`);
      contextLines.push(`Last response: input ${count(last.tokens!.input ?? 0)} + output ${count(last.tokens!.output ?? 0)}${current.window ? ` of ${count(current.window)} (${Math.round(current.used / current.window * 100)}%)` : ' · window unknown'}${last.estimated ? ' · estimated by the adapter' : ''} · ${span(now - last.at)} ago${current.stale ? ` · stale: ${current.stale}` : ''}`);
      if (h.room.compact && current.window) contextLines.push(`Auto-compact at ${count(h.room.compact)} · reserve ${count(Math.max(0, current.window - h.room.compact))} · headroom ${count(Math.max(0, h.room.compact - current.used))}`);
      else contextLines.push(current.window ? `Headroom ${count(Math.max(0, current.window - current.used))} · no auto-compact limit configured` : 'Reserve and headroom unknown');
      const recent = lead.filter(entry => entry.tokens?.input !== null && entry.tokens !== null && (h.compaction.end === null || entry.at > h.compaction.end)).slice(-6);
      const steps = recent.slice(1).map((entry, index) => (entry.tokens!.input ?? 0) - (recent[index].tokens!.input ?? 0)).filter(step => step > 0);
      if (steps.length >= 2) {
        const growth = steps.reduce((a, b) => a + b, 0) / steps.length;
        const room = (h.room.compact ?? current.window ?? 0) - current.used;
        contextLines.push(`Observed growth ~${count(Math.round(growth))}/request${room > 0 ? ` · approx. ${Math.floor(room / growth)} more requests at this rate before ${h.room.compact ? 'auto-compact' : 'the window fills'}` : ''}`);
      } else contextLines.push('Growth: not enough requests since the last compaction');
    } else contextLines.push('No lead response observed in this session yet');
    if (h.assembled) contextLines.push(`Assembled request ${span(now - h.assembled.at)} ago: ~${count(Math.round(h.assembled.bytes / 4))} tokens (bytes/4, approximate) · ${h.assembled.categories.map(([kind, bytes]) => `${kind} ${Math.round(bytes / h.assembled!.bytes * 100)}%`).join(' · ')}`);
    else contextLines.push(categories ? 'Assembled request: none observed yet' : 'Category drilldown off (/omd_usage:categories on)');
    const { compaction } = h;
    if (compaction.started) contextLines.push(`Compaction: ${compaction.installed} installed of ${compaction.started} started${compaction.start !== null && (compaction.end === null || compaction.end < compaction.start) ? ' · last one running or not installed (vetoed or failed)' : ''}`);

    const last = current?.last;
    const expires = last ? cacheTtl(h, last) : null;
    const cacheLines = [
      `Lead input ${count(leadTokens.input)} · cache read ${count(leadTokens.cached)} (${leadTokens.input ? Math.round(leadTokens.cached / leadTokens.input * 100) : 0}% of input) · cache write ${leadTokens.writes ? count(leadTokens.write) : 'not reported'} · output ${count(leadTokens.output)}${leadTokens.unmeasured ? ` · ${leadTokens.unmeasured} without usage` : ''}`,
      last?.tokens?.input ? `Last request: ${Math.round((last.tokens.cached ?? 0) / last.tokens.input * 100)}% cache hit` : 'Last request: no usage',
      expires === null ? `Cache expiry: unavailable${last ? ` for ${visible(last.provider, 30)}` : ''}; reuse is never guaranteed` : expires > now ? `Cache expiry: ~${span(expires - now)} left (provider TTL from last cache use; projection, not guaranteed)` : 'Cache expiry: TTL passed; the next request likely writes the prefix again',
    ];
    const workerTokens = tokens(workers);
    const costLines = [`Lead: ${spendText(totals(lead))}`, `Workers: ${workers.length ? `${spendText(totals(workers))} · ${count(workerTokens.input + workerTokens.output)} tokens` : 'none'}`,
      ...(inherited.length ? [`Inherited from the parent session: ${inherited.length} requests (${spendText(totals(inherited))})`] : []),
      ...(h.entries.some(entry => entry.overage) ? ['Subscription overage: not reported by the provider (unknown)'] : []),
      `Host ledger: ${paid(state.ledger?.cost && typeof state.ledger.cost === 'object' && !Array.isArray(state.ledger.cost) ? state.ledger.cost : null)}`,
      `Retained: ${h.entries.length} requests${h.since ? ` since ${span(now - h.since)} ago` : ''}${h.dropped ? ` · ${h.dropped} older dropped (not in these totals)` : ''}; totals are not lifetime spend`,
      ...(budget !== null ? [`Soft budget ${usd(budget)}: ${usd(totals(h.entries).billed + totals(h.entries).estimate)} spent (warning only, not a spending limit)`] : [])];
    const quotaLines = quota(h, now).map(slot => `${slot.name}: ${slot.current.used}% used${slot.current.resets ? slot.passed ? ` · reset passed ${span(now - slot.current.resets)} ago, awaiting a new reading` : ` · resets in ${span(slot.current.resets - now)}` : ' · reset time not reported'} · observed ${span(now - slot.current.seen)} ago${slot.projected !== null ? ` · projection ~${Math.min(slot.projected, 999)}% at reset (${slot.samples} samples over ${span(slot.spanned)})` : ' · insufficient data for a projection'}`);
    quotaLines.unshift('Current route quota: unavailable (account-to-route binding is not reported)');
    if (h.credits) quotaLines.push(`Codex account Extra-usage credits: ${h.credits}`);
    const agents = Object.entries(h.agents);
    const activity = [
      h.plan ? `Task progress ${h.plan.done}/${h.plan.total}${h.plan.step ? ` · now: ${visible(h.plan.step, 80)}` : ''}` : 'No plan in this session',
      ...agents.slice(-6).map(([id, agent]) => {
        const spend = totals(workers.filter(entry => entry.agent === id));
        return `${visible(agent.role, 30)} ${id.slice(0, 8)} · ${agent.status} · ${spendText(spend)}`;
      }),
      Object.keys(h.tools).length ? `Running tools: ${Object.values(h.tools).map(tool => visible(tool.tool, 40)).join(', ')}` : 'No tools running',
    ];
    const children: TerminalComponent[] = [
      multiline('omd_usage_context', 'Context', contextLines), multiline('omd_usage_cache', 'Tokens and cache', cacheLines),
      multiline('omd_usage_spend', 'Cost', costLines), multiline('omd_usage_quota', 'Quota windows', quotaLines), multiline('omd_usage_activity', 'Tasks, agents and tools', activity),
    ];
    if (h.detail) {
      const recent = h.entries.slice(-20);
      const peak = Math.max(1, ...recent.map(entry => (entry.tokens?.input ?? 0) + (entry.tokens?.output ?? 0)));
      children.push(text('omd_usage_spark', 'Tokens per request, last 20', `Tokens/request ${recent.map(entry => entry.tokens ? SPARK[Math.round(((entry.tokens.input ?? 0) + (entry.tokens.output ?? 0)) / peak * (SPARK.length - 1))] : '?').join('')} (peak ${count(peak)})`));
      const rows: TerminalListRow[] = h.entries.slice(-40).reverse().map(entry => {
        const item = charge(entry);
        const label = fit(`${isLead(h, entry) ? 'lead' : entry.agent ? `agent ${entry.agent.slice(0, 6)}` : entry.kind} #${entry.billing ?? '-'}.${entry.attempt} ${entry.served ?? entry.requested} ${entry.tokens ? `in ${count(entry.tokens.input ?? 0)} c ${count(entry.tokens.cached ?? 0)} out ${count(entry.tokens.output ?? 0)}` : 'no usage'} ${item.usd !== null ? usd(item.usd) : ''} ${item.kind}${entry.revision ? ` r${entry.revision}` : ''} ${span(now - entry.at)}`, 120);
        return { value: entry.key.slice(0, 120), label: visible(label, 120), spans: [{ text: visible(label, 120), tone: item.kind === 'unknown' || item.kind === 'pending' ? 'attention' : 'normal' }] };
      });
      if (rows.length) children.push({ type: 'list', id: 'omd_usage_requests', label: 'Recent requests', rows, height: Math.min(10, rows.length), action: { command: 'omd_usage:hud', args: 'noop' } });
    }
    return children;
  };

  const view = (ledger: Ledger | null): TerminalPatch => {
    const state = saved(); const now = Date.now();
    const sites = { above_composer: { mode: 'wrap' as const, components: [{ type: 'slot' as const }, ...prompt(state, now)] } };
    const keybindings = { 'Alt+a': { command: 'omd_usage:hud', args: 'toggle' } };
    if (!state.open) return { sites, keybindings };
    const effective = ledger ?? state.ledger;
    const children: TerminalComponent[] = [
      ...(state.error ? [text('omd_usage_error', 'Status', state.error)] : []),
      ...expanded({ ...state, ledger: effective }, now),
      { type: 'button', id: 'omd_usage_refresh', label: 'Refresh usage', text: 'Refresh', action: { command: 'omd_usage:hud', args: 'refresh' } },
      { type: 'button', id: 'omd_usage_detail', label: state.hud.detail ? 'Show compact usage' : 'Show expanded usage', text: state.hud.detail ? 'Compact' : 'Expanded', action: { command: 'omd_usage:hud', args: state.hud.detail ? 'compact' : 'expanded' } },
      { type: 'button', id: 'omd_usage_close', label: 'Close usage', text: 'Close', action: { command: 'omd_usage:hud', args: 'close' } },
    ];
    return { sites: { ...sites, dialog: { mode: 'replace', components: [{ type: 'dialog', id: 'omd_usage_dialog', label: 'Usage', title: 'Usage', children }] } }, keybindings };
  };

  // Slash commands can't read task status, so they hop to this mod's own native channel handler.
  api.command('hud', value => {
    const argument = String(value ?? '').trim();
    const state = saved();
    if (argument === 'noop') return null;
    if (argument === 'close' || argument === 'toggle' && state.open) {
      save({ ...state, open: false });
      return null;
    }
    if (argument === 'expanded' || argument === 'compact') {
      save({ ...state, hud: { ...state.hud, detail: argument === 'expanded' } });
      return null;
    }
    save({ ...state, open: true });
    const asked = api.host.tryCall('events.publish', { channel: 'refresh', data: null });
    return asked.ok ? null : { display: `Usage refresh unavailable: ${asked.error}` };
  }, { description: 'Open or refresh the usage dialog (Alt+a toggles it)' });
  const write = (values: { [key: string]: Json }, done: string) => {
    const written = api.host.tryCall('settings.write', { values });
    return { display: written.ok ? `${done}; applies when the mod reloads at the next turn` : `Usage settings unchanged: ${written.error}` };
  };
  api.command('budget', value => {
    const amount = String(value ?? '').trim();
    return amount !== '' && Number(amount) >= 0 ? write({ budget_usd: Number(amount) }, Number(amount) ? `Soft budget ${usd(Number(amount))}` : 'Soft budget removed')
      : { display: `usage: /omd_usage:budget USD (0 removes it; now ${budget === null ? 'none' : usd(budget)})` };
  }, { description: 'Set a soft spending budget in USD for warnings only (0 removes it)' });
  api.command('categories', value => {
    const choice = String(value ?? '').trim();
    return choice === 'on' || choice === 'off' ? write({ categories: choice === 'on' }, `Category drilldown ${choice}`)
      : { display: `usage: /omd_usage:categories on|off (now ${categories ? 'on' : 'off'})` };
  }, { description: 'Turn the assembled-request category drilldown on or off (it runs on the request path)' });
  api.on('channel', ({ channel }) => {
    if (channel !== 'omd_usage/refresh') return;
    save(capture(saved()));
    publish();
  });
  api.on('terminal', input => view(input.ledger));

  const configure = () => {
    const session = api.host.tryCall('session.info', null);
    const config = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    const values = object(config.ok ? object(config.value).config : null);
    hud(state => {
      state.thread = session.ok ? session.value.thread_id : state.thread;
      state.current = { model: session.ok ? session.value.model : state.current.model, provider: session.ok ? session.value.provider : state.current.provider,
        effort: typeof values.model_reasoning_effort === 'string' ? values.model_reasoning_effort : state.current.effort };
      state.room = { size: number(values.model_context_window), compact: number(values.model_auto_compact_token_limit) };
      state.samples = [];
      state.credits = null;
    });
    const read = api.usage.rateLimits();
    if (read.available) hud(state => limits(state, object(read.value), Date.now()));
    publish();
  };
  api.on('start', configure);
  api.on('resume', configure);
  const expiry = () => { const state = saved(); const last = context(state.hud)?.last; return last ? cacheTtl(state.hud, last) : null; };
  // Redraws a cache countdown once a minute until it passes; the tick adds no observation.
  const ticker = api.time.every('countdown', 60_000, () => {
    hud(state => { state.tick += 1; });
    return (expiry() ?? 0) > Date.now();
  });
  api.on('model_response', response => {
    const usage = object(response.usage);
    const summary = api.usage.summarize(response);
    const reported = object(usage.omd_reported_cost);
    hud(state => record(state, {
      key: `${response.request_id}#${response.attempt}`, request: response.request_id, attempt: response.attempt, billing: response.ledger_request,
      thread: response.scope.thread_id, agent: response.scope.agent_id, kind: response.scope.kind, turn: response.scope.kind === 'main' ? state.turn : null,
      provider: response.provider, credential: response.credential, route: response.route, requested: response.requested_model, served: response.served_model, status: response.status,
      tokens: summary.measured ? { input: summary.tokens.input, cached: summary.tokens.cached, write: summary.tokens.cache_write, output: summary.tokens.output, reasoning: summary.tokens.reasoning } : null,
      estimated: usage.omd_usage_estimated === true, window: response.context_window, cost: { microusd: response.cost.microusd, basis: response.cost.basis },
      reported: number(reported.usd) !== null && (reported.basis === 'provider_billed' || reported.basis === 'client_list_estimate') ? { usd: reported.usd, basis: reported.basis } : null,
      overage: usage.omd_subscription_charge === 'unknown', ttl: number(usage.omd_cache_ttl_seconds),
      at: response.timing.started_at_ms + response.timing.duration_ms, synthetic: response.synthetic, revision: 0,
    }));
    publish();
    if (expiry() !== null) ticker.start();
  });
  api.on('turn_start', ({ turn_id }) => hud(state => { state.turn = turn_id; }));
  api.on('turn_end', () => {
    const state = capture(saved());
    state.hud.tools = {};
    save(state);
    publish();
  });
  api.on('compaction_start', ({ trigger }) => hud(state => { state.compaction = { ...state.compaction, started: state.compaction.started + 1, start: Date.now(), trigger }; }));
  api.on('compaction_end', () => hud(state => { state.compaction = { ...state.compaction, installed: state.compaction.installed + 1, end: Date.now() }; }));
  api.on('agent', ({ agent }) => hud(state => {
    state.agents[agent.agent_id ?? agent.thread_id] = { role: agent.role ?? agent.origin, status: agent.status, at: Date.now() };
    const ids = Object.keys(state.agents).sort((a, b) => state.agents[b].at - state.agents[a].at);
    for (const id of ids.slice(12)) delete state.agents[id];
  }));
  api.on('tool_call', ({ call_id, tool }) => hud(state => {
    state.tools[call_id] = { tool, at: Date.now() };
    for (const id of Object.keys(state.tools).slice(0, -16)) delete state.tools[id];
  }));
  api.on('tool_result', ({ call_id }) => hud(state => { delete state.tools[call_id]; }));
  api.on('app_notification', ({ method, params, thread_id }) => {
    const update = object(params);
    const thread = thread_id ?? update.threadId ?? null;
    if (method === 'account/updated') {
      hud(state => { state.samples = []; state.credits = null; });
      publish();
      return;
    }
    if (method === 'account/rateLimits/updated') {
      hud(state => limits(state, update, Date.now()));
      publish();
      return;
    }
    const state = saved();
    if (state.hud.thread !== null && thread !== state.hud.thread) return;
    if (method === 'thread/settings/updated') {
      const settings = object(update.threadSettings);
      hud(h => { h.current = { model: typeof settings.model === 'string' ? settings.model : h.current.model, provider: typeof settings.modelProvider === 'string' ? settings.modelProvider : h.current.provider, effort: typeof settings.effort === 'string' ? settings.effort : h.current.effort }; });
    } else if (method === 'thread/tokenUsage/updated') {
      const size = number(object(update.tokenUsage).modelContextWindow);
      if (size !== null && size !== state.hud.room.size) hud(h => { h.room = { ...h.room, size }; });
    } else if (method === 'thread/reverted') hud(h => { h.reverted = Date.now(); });
    else if (method === 'turn/plan/updated' && Array.isArray(update.plan)) {
      const steps = update.plan.map(object);
      const active = steps.find(step => step.status === 'inProgress' && typeof step.step === 'string');
      hud(h => { h.plan = steps.length ? { done: steps.filter(step => step.status === 'completed').length, total: steps.length, step: active ? visible(active.step, 60) : null } : null; });
    }
  });
  if (categories) {
    api.intercept('model_request', { match: { scope: { kind: 'main' } } }, async (event, next) => {
      const result = await next(event);
      if (event.scope.agent_id) return result;
      const categories = new Map<string, number>();
      for (const section of event.sections) {
        const kind = section.role === 'tool' ? 'tool output' : section.role === 'user' && !section.kind.startsWith('user') ? 'context' : section.role;
        categories.set(kind, (categories.get(kind) ?? 0) + section.bytes);
      }
      const bytes = [...categories.values()].reduce((a, b) => a + b, 0);
      hud(state => { state.assembled = bytes ? { at: Date.now(), bytes, categories: [...categories].sort((a, b) => b[1] - a[1]).slice(0, 6) } : state.assembled; });
      return result;
    });
  }
}
