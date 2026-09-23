import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Mode = 'solo' | 'paired' | 'entry';

const MODES: Mode[] = ['solo', 'paired', 'entry'];
const VERSION = '2.0.0';

export default function activate(api: ModAPI) {
  const held = (): { [key: string]: Json } => {
    const stored = api.state.get();
    return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  };

  const decisions = (): Json[] => {
    const stored = held().decisions;
    return Array.isArray(stored) ? stored : [];
  };

  const remember = (entry: Json) =>
    api.state.set({ ...held(), version: 2, decisions: [...decisions(), entry].slice(-16) });

  const mode = (): Mode => MODES.find(value => value === api.settings.mode) ?? 'paired';

  const focus = (): string[] =>
    Array.isArray(api.settings.focus)
      ? api.settings.focus.filter((value): value is string => typeof value === 'string').slice(0, 8)
      : [];

  const banner = () => `atlas_policy ${VERSION} (${mode()})`;

  const text = (value: Json | undefined): string => (typeof value === 'string' ? value : '');

  api.on('migrate', ({ from }) => {
    const stored = api.state.get();
    api.state.set({
      version: 2,
      migrated_from: from,
      decisions: Array.isArray(stored) ? stored.slice(-16) : [],
    });
  });

  api.replace('routing', ({ routes, model }) => {
    const selected = mode() === 'entry'
      ? routes.find(route => route.model === model)
      : routes.find(route => route.name === (mode() === 'solo' ? 'sol' : 'astra'));
    const chosen = selected ?? routes[0];
    remember({ decision: 'routing', mode: mode(), route: chosen?.name ?? null });
    return chosen?.name ?? null;
  });

  api.replace('context', ({ turn_id, checkpoint }) => {
    const record = checkpoint !== null && typeof checkpoint === 'object' && !Array.isArray(checkpoint) ? checkpoint : {};
    const remaining = Array.isArray(record.remaining_work) ? record.remaining_work.map(String) : [];
    const selected = focus();
    const headline = api.services.call<string>('example.formatter', 'format', `  ${banner()} assembled turn ${turn_id}  `);
    remember({ decision: 'context', turn: turn_id, selected });
    return {
      text: [
        `${headline}.`,
        selected.length
          ? `Only these paths are in scope: ${selected.join(', ')}.`
          : 'No paths are declared in scope; ask before widening it.',
        remaining.length
          ? `Remaining acceptance work: ${remaining.join('; ')}.`
          : 'No remaining acceptance work is recorded.',
        'Native permissions, limits, review, accounting and evidence stay authoritative.',
      ].join(' '),
    };
  });

  api.replace('tool_before', ({ tool, arguments: passed }) =>
    tool === 'omd_contribute' ? { tool: 'mod_atlas_policy_delegate', arguments: passed } : null);

  api.on('turn_start', ({ turn_id }) => remember({ decision: 'turn_start', turn: turn_id }));

  api.on('agent_end', ({ role, status }) => remember({ decision: 'agent_end', role, status }));

  api.tool(
    {
      name: 'delegate',
      label: 'Atlas delegation',
      description: 'Delegate through the native reviewed contribution using the Atlas scope policy.',
      parameters: {
        type: 'object',
        properties: { brief: { type: 'string' }, selected_evidence: { type: 'array', items: { type: 'string' } } },
        required: ['brief'],
        additionalProperties: false,
      },
    },
    passed => {
      const record = passed !== null && typeof passed === 'object' && !Array.isArray(passed) ? passed : {};
      const brief = text(record.brief);
      if (!brief) throw new Error('brief required');
      const declared = focus();
      const requested = Array.isArray(record.selected_evidence)
        ? record.selected_evidence.filter((value): value is string => typeof value === 'string')
        : [];
      const selected = declared.length ? requested.filter(path => declared.includes(path)) : requested;
      api.progress(`Atlas kept ${selected.length} of ${requested.length} requested paths`);
      const result = api.host.call('delegation.contribute', { brief: `${banner()}: ${brief}`, selected_evidence: selected });
      remember({ decision: 'delegate', mode: mode(), requested, selected });
      return result;
    },
  );

  api.tool(
    {
      name: 'survey',
      label: 'Atlas survey',
      description: 'Ask one read-only worker per authorized route to inspect the task without editing.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    () => {
      const routes = api.host.call('routes.list', null);
      const spawned = routes.slice(0, 2).map(route =>
        api.host.call('agents.spawn', { role: 'atlas_surveyor', route: route.name, prompt: `${banner()}: inspect the task without editing.` }));
      const results = spawned.map(agent => api.host.call('agents.wait', { handle: agent.handle, consume: true }));
      remember({ decision: 'survey', routes: routes.map(route => route.name) });
      return { surveyed: routes.map(route => route.name), results };
    },
  );

  api.command('atlas', () => {
    const status = api.host.call('task.status', null);
    const settings = status !== null && typeof status === 'object' && !Array.isArray(status) ? status.settings : null;
    return { display: `${banner()} · scope ${focus().join(', ') || 'none'} · host settings ${settings === null ? 'unavailable' : 'read'}` };
  }, { description: 'Show the Atlas coordination policy' });
}
