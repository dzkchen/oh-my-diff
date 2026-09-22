import type { ContributionRequest, EscalationRequest, FailureClass, Json, ModAPI, RecoveryAction } from '../../api.d.ts';

type RecoveryTool = 'direct' | 'delegation' | 'advisory';

const FAILURE_CLASSES: FailureClass[] = ['environment', 'edit', 'diagnosis', 'model'];
const RECOVERY_TOOLS: RecoveryTool[] = ['direct', 'delegation', 'advisory'];
const VERSION = '0.1.0-preview.1';

export default function activate(api: ModAPI) {
  const setting = (key: string) => api.settings[key];
  const failurePolicy = (): FailureClass | 'lead_asserted' => {
    const value = setting('failure_policy');
    return value === 'lead_asserted' || FAILURE_CLASSES.includes(value as FailureClass)
      ? (value as FailureClass | 'lead_asserted')
      : 'lead_asserted';
  };
  const outageAction = (): RecoveryAction =>
    setting('outage_action') === 'pause' ? 'pause' : 'opposite_lead';
  const eligibleTools = (): RecoveryTool[] => {
    const value = setting('eligible_tools');
    if (!Array.isArray(value)) return RECOVERY_TOOLS;
    return RECOVERY_TOOLS.filter(tool => value.includes(tool));
  };
  const remember = (entry: Json) => {
    const stored = api.state.get();
    const decisions = Array.isArray(stored) ? stored : [];
    api.state.set([...decisions, entry].slice(-24));
  };
  const object = (value: Json): Record<string, Json> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const failureClass = (value: Json): FailureClass => {
    const policy = failurePolicy();
    if (policy !== 'lead_asserted') return policy;
    if (typeof value === 'string' && FAILURE_CLASSES.includes(value as FailureClass)) {
      return value as FailureClass;
    }
    throw new Error('failure_class must be environment, edit, diagnosis, or model');
  };
  api.tool(
    {
      name: 'recover',
      label: 'Recovery policy',
      description: 'Classify preserved failure evidence and request bounded native advisory recovery',
      parameters: {
        type: 'object',
        properties: {
          failure_class: { type: 'string', enum: FAILURE_CLASSES },
          summary: { type: 'string' },
          call_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['failure_class', 'summary', 'call_ids'],
        additionalProperties: false,
      },
    },
    argument => {
      const request = object(argument);
      const classification = failureClass(request.failure_class);
      const tools = eligibleTools();
      const decision = {
        operation: 'escalation',
        failure_class: classification,
        eligible_tools: tools,
        advisory_route: tools.includes('advisory') ? 'opposite_lead' : 'pause',
      };
      remember(decision);
      if (!tools.includes('advisory')) return { status: 'denied', decision };
      return api.host.call('recovery.escalate', {
        failure_class: classification,
        summary: typeof request.summary === 'string' ? request.summary : '',
        call_ids: Array.isArray(request.call_ids)
          ? request.call_ids.filter((value): value is string => typeof value === 'string')
          : [],
        advisory_route: 'opposite_lead',
      } satisfies EscalationRequest);
    },
  );

  api.tool(
    {
      name: 'delegate',
      label: 'Recovery-aware delegation',
      description: 'Run native reviewed delegation with the selected bounded Contributor-outage policy',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          selected_evidence: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
    argument => {
      const prepared = object(
        api.services.call('omd.coordination', 'prepare_delegation', object(argument)),
      ) as ContributionRequest;
      const action = outageAction();
      remember({ operation: 'delegation', outage_action: action, coordination: true });
      return api.host.call('delegation.contribute', { ...prepared, outage_action: action });
    },
  );

  api.replace('tool_before', ({ tool, arguments: passed }) => {
    if (tool === 'omd_escalate') return { tool: 'mod_omd_recovery_recover', arguments: passed };
    if (tool === 'omd_contribute') return { tool: 'mod_omd_recovery_delegate', arguments: passed };
    return null;
  });

  api.on('tool_result', event => {
    const result = object(event);
    remember({
      operation: 'tool_result',
      call_id: result.call_id ?? null,
      tool: result.tool ?? null,
      outcome: result.outcome ?? null,
    });
  });

  api.command(
    'policy',
    () => ({
      display: [
        `omd_recovery ${VERSION}`,
        `failure policy: ${failurePolicy()}`,
        `eligible tools: ${eligibleTools().join(', ') || 'none'}`,
        `outage action: ${outageAction()}`,
        `decisions: ${JSON.stringify(api.state.get() ?? [])}`,
      ].join('\n'),
    }),
    { description: 'Show the effective recovery policy and recent decisions' },
  );
}
