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
    return chosen ? { route: chosen.name } : null;
  });

  api.replace('context', ({ turn_id }) => {
    const selected = focus();
    const headline = api.services.call<string>('example.formatter', 'format', `  ${banner()} assembled turn ${turn_id}  `);
    remember({ decision: 'context', turn: turn_id, selected });
    return {
      text: [
        `${headline}.`,
        selected.length
          ? `Only these paths are in scope: ${selected.join(', ')}.`
          : 'No paths are declared in scope; ask before widening it.',
        'Native permissions, limits, accounting and evidence stay authoritative.',
      ].join(' '),
    };
  });

  api.intercept('tool', { match: { tool: 'omd_contribute' } }, (e, next) => next({ ...e, tool: 'mod_atlas_policy_delegate' }));

  api.on('turn_start', ({ turn_id }) => remember({ decision: 'turn_start', turn: turn_id }));

  api.on('agent_end', ({ role, status }) => remember({ decision: 'agent_end', role, status }));

  api.tool(
    {
      name: 'delegate',
      label: 'Atlas delegation',
      description: 'Delegate a brief to one read-only worker using the Atlas scope policy.',
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
      const route = api.host.call('routes.list', null)[0]?.name;
      if (!route) throw new Error('no route available');
      const agent = api.host.call('agents.spawn', { role: 'atlas_contributor', route,
        prompt: `${banner()}: ${brief}\nEvidence in scope: ${selected.join(', ') || 'none'}.` });
      const result = api.host.call('agents.wait', { handle: agent.handle, consume: true });
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
    const status = api.host.tryCall('task.status', null);
    return { display: `${banner()} · scope ${focus().join(', ') || 'none'} · task ${status.ok ? 'read' : 'unavailable'}` };
  }, { description: 'Show the Atlas coordination policy' });
}
