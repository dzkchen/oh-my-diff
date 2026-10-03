import type { Json, ModAPI } from '../../api.d.ts';

const CLASSES = ['environment', 'edit', 'diagnosis', 'model'];
const object = (value: Json): Record<string, Json> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value: Json | undefined, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export default function activate(api: ModAPI) {
  // Expected refusals return as values; a non-Error throw is the host suspending the callback.
  const refuse = <T>(run: () => T | Promise<T>, value: (reason: string) => T): T | Promise<T> => {
    const refused = (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return value(error.message);
    };
    try {
      const result = run();
      return result instanceof Promise ? result.catch(refused) : result;
    } catch (error) {
      return refused(error);
    }
  };
  const tool: ModAPI['tool'] = (spec, handler) => api.tool(spec, input => refuse(() => handler(input), reason => ({ status: 'refused', reason })));
  const command: ModAPI['command'] = (name, handler, options) => api.command(name, input => refuse(() => handler(input), reason => ({ display: `Refused: ${reason}` })), options);
  const key = () => `recovery.${api.host.call('task.status', null).ledger.thread_id}`;
  const remember = (entry: Json) => {
    const previous = api.state.get();
    api.state.set([...(Array.isArray(previous) ? previous : []), entry].slice(-24));
  };
  api.middleware('model_request', event => {
    if (event.scope.kind === 'main') {
      remember({ kind: 'lead', thread: event.scope.thread_id, model: event.effective.model, provider: event.effective.provider });
    }
    return null;
  });
  tool({ name: 'recover', label: 'Recovery policy', description: 'Bind one read-only advisory escalation to exact preserved tool calls and outputs; the lead retains every edit decision',
    parameters: { type: 'object', properties: { failure_class: { type: 'string', enum: CLASSES }, summary: { type: 'string' }, call_ids: { type: 'array', items: { type: 'string' } } }, required: ['failure_class', 'summary', 'call_ids'], additionalProperties: false },
  }, input => {
    const request = object(input);
    const classification = api.settings.failure_policy === 'lead_asserted' || api.settings.failure_policy === undefined ? request.failure_class : api.settings.failure_policy;
    if (!CLASSES.includes(String(classification)) || !text(request.summary, 2048) || !Array.isArray(request.call_ids) || !request.call_ids.length || request.call_ids.length > 8 || request.call_ids.some(id => !text(id, 128)) || new Set(request.call_ids).size !== request.call_ids.length) throw new Error('failure_evidence_required');
    const classes = api.settings.allowed_failure_classes ?? CLASSES;
    if (!Array.isArray(classes) || classes.some(value => !CLASSES.includes(String(value))) || new Set(classes).size !== classes.length) throw new Error('failure_class_policy_invalid');
    if (!classes.includes(classification)) throw new Error('failure_class_not_allowed');
    const evidenceLimit = api.settings.evidence_bytes ?? 262144;
    if (typeof evidenceLimit !== 'number' || !Number.isSafeInteger(evidenceLimit) || evidenceLimit < 1 || evidenceLimit > 1048576) throw new Error('advisory_evidence_policy_invalid');
    const eligible = api.settings.eligible_tools;
    if (Array.isArray(eligible) && !eligible.includes('advisory')) return { status: 'denied', reason: 'advisory_disabled' };
    const taskKey = key();
    if (api.host.call('store.get', { key: taskKey })) throw new Error('task_advisory_attempt_already_used');
    const previous = api.state.get();
    const lead = (Array.isArray(previous) ? [...previous].reverse().map(object).find(entry => entry.kind === 'lead' && `recovery.${entry.thread}` === taskKey) : null) ?? {};
    const routes = api.host.call('routes.list', null);
    const leadRoutes = routes.filter(route => route.roles.includes('lead') && route.available && route.provider === lead.provider && route.model === lead.model);
    const billing = leadRoutes[0]?.billing;
    if (!billing || leadRoutes.some(route => route.billing !== billing)) throw new Error('lead_billing_ambiguous_or_unavailable');
    const selected = routes.find(route => route.roles.includes('lead') && route.roles.includes('worker') && route.available
      && (route.provider !== lead.provider || route.model !== lead.model)
      && route.billing === billing
      && (typeof api.settings.advisory_route !== 'string' || !api.settings.advisory_route || route.name === api.settings.advisory_route));
    if (!selected || !text(lead.model, 128)) throw new Error('distinct_same_billing_advisory_route_unavailable');
    const frozen = api.host.call('sessions.snapshot', { call_ids: request.call_ids as string[] });
    if (!Number.isSafeInteger(frozen.provenance?.bytes) || frozen.provenance.bytes > evidenceLimit) throw new Error('advisory_evidence_limit');
    const evidence = frozen.evidence;
    const snapshot = api.host.call('workspace.snapshot', {}).snapshot;
    const reservation = api.host.call('store.put', { key: taskKey, expected_revision: null, value: { status: 'admitting', classification: classification ?? null, evidence, route: selected.name } });
    const spawned = api.host.tryCall('agents.spawn', { role: 'failure_advice', route: selected.name, workspace: 'read_only', snapshot, evidence,
      prompt: `Inspect the exact preserved calls and outputs supplied as evidence. The failure classification and summary are lead assertions, not host facts. Give bounded advice and concrete next checks. Do not edit, delegate or claim integration. Classification: ${classification}. Summary: ${request.summary}` });
    const value: Json = spawned.ok ? { status: 'running', handle: spawned.value.handle, evidence, classification: classification ?? null, route: selected.name } : { status: 'denied', error: spawned.error, evidence };
    api.host.call('store.put', { key: taskKey, expected_revision: reservation.revision, value });
    remember({ operation: 'advisory', value });
    return value;
  });
  tool({ name: 'advice', description: 'Observe the one admitted advisory call without restarting it', parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const taskKey = key();
    const saved = api.host.call('store.get', { key: taskKey });
    const current = object(saved?.value ?? null);
    if (current.status !== 'running' || !text(current.handle, 256) || !saved) return current;
    const result = api.host.tryCall('agents.wait', { handle: current.handle });
    if (result.ok && result.value.status === 'running') return { status: 'running' };
    const value: Json = result.ok ? { ...current, status: result.value.status, result: result.value as unknown as Json } : { ...current, status: 'interrupted', error: result.error };
    api.host.call('store.put', { key: taskKey, expected_revision: saved.revision, value });
    api.host.tryCall('agents.cancel', { handle: current.handle });
    return value;
  });
  tool({ name: 'delegate', label: 'Recovery-aware delegation', description: 'Apply coordination context and the explicitly selected bounded outage policy',
    parameters: { type: 'object', properties: { brief: { type: 'string' }, selected_evidence: { type: 'array', items: { type: 'string' } } }, required: ['brief'], additionalProperties: false },
  }, input => {
    const prepared = object(api.services.call('omd.coordination', 'prepare_delegation', input));
    const outage = api.settings.outage_action === 'pause' ? 'pause' : 'opposite_lead';
    remember({ operation: 'delegation', outage_action: outage });
    return api.services.call('omd.workflow', 'delegate', { ...prepared, outage_action: outage });
  });
  api.intercept('tool', { match: { tool: ['omd_escalate', 'omd_contribute'] } }, (e, next) =>
    next({ ...e, tool: e.tool === 'omd_escalate' ? 'mod_omd_recovery_recover' : 'mod_omd_recovery_delegate' }));
  api.on('tool_result', event => remember({ operation: 'tool_result', event }));
  command('outage', () => {
    const decisions = api.state.get();
    return { display: `On a provider outage: ${String(api.settings.outage_action ?? 'opposite_lead').replace(/_/g, ' ')}. Recorded decisions: ${Array.isArray(decisions) ? decisions.length : 0}.` };
  }, { description: 'Show what happens on a provider outage and how many decisions were recorded' });
}
