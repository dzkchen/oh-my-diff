import type { Json, ModAPI } from '../../api.d.ts';

type ContextPolicy = 'focused' | 'shared' | 'inherit';
type LeadPolicy = 'sol' | 'astra' | 'task_entry';

const CONTEXT_POLICIES: ContextPolicy[] = ['focused', 'shared', 'inherit'];
const LEAD_POLICIES: LeadPolicy[] = ['sol', 'astra', 'task_entry'];
const VERSION = '0.1.0-preview.1';

export default function activate(api: ModAPI) {
  const strings = (value: Json | undefined): string[] =>
    Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

  const choice = <T extends string>(key: string, allowed: T[], fallback: T): T =>
    allowed.find(value => value === api.settings[key]) ?? fallback;

  const leadPolicy = () => choice('lead_policy', LEAD_POLICIES, 'task_entry');
  const contextPolicy = () => choice('worker_context', CONTEXT_POLICIES, 'focused');
  const evidence = () => strings(api.settings.evidence).slice(0, 8);

  const provenance = () =>
    `omd_coordination ${VERSION}: lead ${leadPolicy()}, worker context ${contextPolicy()}`;

  const remember = (entry: Json) => {
    const stored = api.state.get();
    const decisions = Array.isArray(stored) ? stored : [];
    api.state.set([...decisions, entry].slice(-16));
  };

  const failed = (error: unknown): Json => {
    if (!(error instanceof Error)) throw error;
    return { denied: error.message, policy: provenance() };
  };

  api.replace('routing', ({ routes, model }) => {
    const policy = leadPolicy();
    const selected =
      policy === 'task_entry'
        ? routes.find(route => route.model === model)
        : routes.find(route => route.name === policy);
    return selected?.name ?? null;
  });

  api.replace('context', () => {
    const policy = contextPolicy();
    const selected = evidence();
    const rules: Record<ContextPolicy, string> = {
      focused: `Workers receive a focused brief plus only these paths: ${selected.join(', ') || 'none declared'}.`,
      shared: 'Workers receive the host-owned shared task packet; model-authored evidence is dropped.',
      inherit: 'Workers inherit the bounded parent history the host supplies; no extra evidence is selected.',
    };
    return {
      text: `Coordination policy (${provenance()}). ${rules[policy]} Delegate with omd_contribute; this policy rewrites its evidence selection before the native reviewed contribution runs. Native permissions, limits, review and accounting stay authoritative.`,
    };
  });

  api.tool(
    {
      name: 'delegate',
      label: 'Coordination policy',
      description: 'Apply the selected worker-context policy and run the native reviewed contribution',
      parameters: {
        type: 'object',
        properties: { brief: { type: 'string' }, selected_evidence: { type: 'array', items: { type: 'string' } } },
        required: ['brief'],
      },
    },
    argument => {
      const request = argument && typeof argument === 'object' && !Array.isArray(argument) ? argument : {};
      const policy = contextPolicy();
      const declared = evidence();
      const requested = strings(request.selected_evidence);
      const selected =
        policy === 'focused'
          ? declared.length
            ? requested.filter(path => declared.includes(path))
            : requested
          : [];
      const brief = `${typeof request.brief === 'string' ? request.brief : ''} [${provenance()}]`.trim();
      api.progress(`worker context: ${policy}`);
      remember({ operation: 'delegate', policy, selected });
      try {
        return api.host.call('delegation.contribute', { brief, selected_evidence: selected });
      } catch (error) {
        return failed(error);
      }
    },
  );

  api.tool(
    {
      name: 'investigate',
      label: 'Bounded investigation',
      description: 'Run one bounded read-only native investigation on the policy route',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
    },
    argument => {
      const request = argument && typeof argument === 'object' && !Array.isArray(argument) ? argument : {};
      if (typeof request.prompt !== 'string') throw new Error('prompt required');
      const routes = api.host.call('routes.list', null);
      const policy = leadPolicy();
      const route = routes.find(candidate => candidate.name === policy) ?? routes[0];
      try {
        const agent = api.host.call('agents.spawn', {
          role: 'investigator',
          route: route.name,
          prompt: `${request.prompt}\n\n${provenance()}. Inspect only; do not edit.`,
        });
        api.progress(`investigator running on ${route.name} (${route.model})`);
        const result = api.host.call('agents.wait', { handle: agent.handle, consume: true });
        remember({ operation: 'investigate', route: route.name, status: result.status });
        return { route: route.name, model: route.model, reasoning: route.reasoning, result };
      } catch (error) {
        remember({ operation: 'investigate', route: route.name, denied: true });
        return failed(error);
      }
    },
  );

  api.replace('tool_before', ({ tool, arguments: passed }) =>
    tool === 'omd_contribute' ? { tool: 'mod_omd_coordination_delegate', arguments: passed } : null,
  );

  api.command(
    'policy',
    () => ({
      display: [
        provenance(),
        `declared evidence: ${evidence().join(', ') || 'none'}`,
        `recorded decisions: ${JSON.stringify(api.state.get() ?? [])}`,
      ].join('\n'),
    }),
    { description: 'Show the effective coordination policy and its recorded decisions' },
  );

  api.on('turn_end', ({ outcome }) => remember({ operation: 'turn_end', outcome }));
}
