import type { Json, ModAPI, RouteInfo } from '../../api.d.ts';

const PROVIDER = 'omd_profiles';
type Profile = { name: string; model: string; billing: RouteInfo['billing']; available: boolean };
type Saved = { profiles: Profile[]; current: string | null; notice: string | null; pending: string | null; ours: boolean };

const USAGE = 'usage: /profile [use NAME | add chatgpt|api_key LABEL | add provider LABEL PROVIDER HTTPS_ORIGIN | remove LABEL | refresh LABEL]';

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ profiles: [], current: null, notice: null, pending: null, ours: false, ...api.state.get() as unknown as Saved | null });
  const fit = (text: string, max: number) => [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
  const store = (patch: Partial<Saved>) => {
    const next = { ...saved(), ...patch };
    api.state.set(next as unknown as Json);
    api.host.tryCall('events.publish', { channel: 'routes', data: next as unknown as Json });
  };
  const refresh = () => {
    const routes = api.host.tryCall('routes.list', null);
    if (routes.ok) store({ profiles: routes.value.filter(route => route.provider === PROVIDER && route.roles.includes('lead'))
      .map(({ name, model, billing, available }) => ({ name, model, billing, available })) });
  };
  const ensure = () => {
    const status = api.host.tryCall('sidecars.status', { id: PROVIDER });
    if (status.ok && (status.value as { running?: boolean } | null)?.running === true) return;
    if (status.ok) api.host.tryCall('providers.unregister', { id: PROVIDER });
    api.host.tryCall('providers.register', { id: PROVIDER });
  };

  api.replace('routing', ({ routes, model, provider }) => {
    if (provider !== PROVIDER) return null;
    const ours = routes.filter(route => route.provider === PROVIDER);
    const route = ours.find(route => route.model === model) ?? ours[0];
    if (route) api.state.set({ ...saved(), current: route.name, ours: true } as unknown as Json);
    return route ? { route: route.name } : null;
  });
  api.on('start', refresh);
  api.on('resume', refresh);
  // State is per thread: routing marks threads on this provider, and a requested switch applies to the thread it was asked in.
  api.on('turn_start', () => {
    const { ours, pending } = saved();
    if (ours) ensure();
    if (!pending) return;
    const selected = api.host.tryCall('routes.select', { route: pending, scope: 'thread' });
    store(selected.ok ? { current: pending, pending: null, notice: null } : { pending: null, notice: `${pending}: ${selected.error}` });
    refresh();
  });
  api.on('terminal', () => {
    const { current, notice, pending } = saved();
    const text = notice ? 'profile switch failed' : pending ? `profile → ${pending}` : current ? `profile ${current}` : null;
    return text ? { status: [fit(text, 40)] } : null;
  });

  api.command('profile', value => {
    const [op = '', label = '', extra = ''] = String(value ?? '').trim().split(/\s+/);
    const { profiles, current, notice } = saved();
    if (!op || op === 'list') {
      if (!profiles.length) return { display: 'No provider profiles. Enroll a credential with `/profile add`, then run the printed `omd-package profiles --setup` command.' };
      return { display: [...notice ? [`Last switch failed: ${notice}`] : [], ...profiles.map(profile =>
        `${profile.name === current ? '●' : '○'} ${profile.name} · ${profile.model} · ${profile.billing === 'included_subscription' ? 'subscription' : 'paid API'}${profile.available ? '' : ' · unavailable'}`)].join('\n') };
    }
    if (op === 'use') {
      const profile = profiles.find(item => item.name === label);
      if (!profile) return { display: `Unknown profile ${label || '(none)'}. ${USAGE}` };
      if (profile.billing !== 'included_subscription') {
        const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Use a paid API profile', message: `${profile.name} (${profile.model}) bills its API account per request. Switch at the next request?` });
        if (!answer.ok || answer.value.status !== 'accepted') return { display: 'Kept the current profile.' };
      }
      store({ pending: profile.name, notice: null });
      return { display: `Switching this thread to ${profile.name} at its next turn; its attachments and tool history are kept. Earlier reasoning is not sent to another account, and Chat Completions or Anthropic profiles get no hosted tools.` };
    }
    const [, , , provider = '', origin = ''] = String(value ?? '').trim().split(/\s+/);
    if (op === 'add' && ['chatgpt', 'api_key', 'provider'].includes(label) && extra && (label === 'provider') === Boolean(provider && origin)) {
      const enrolled = api.host.tryCall('credentials.request', label === 'provider'
        ? { action: 'enroll', kind: 'provider', label: extra, provider, origin }
        : { action: 'enroll', kind: label as 'chatgpt' | 'api_key', label: extra });
      if (!enrolled.ok || enrolled.value.status !== 'completed') return { display: enrolled.ok ? 'Enrollment cancelled.' : enrolled.error };
      const url = label === 'chatgpt' ? 'https://chatgpt.com/backend-api/codex/responses' : label === 'api_key' ? 'https://api.openai.com/v1/responses' : `${origin}/PATH`;
      return { display: `Enrolled ${label} credential "${extra}". Add a profile from a terminal, then /profile use NAME here (no restart):\nomd-package profiles --setup --add NAME --credential "${extra}" --protocol ${label === 'provider' ? 'chat|anthropic|responses' : 'responses'} --url ${url} --upstream-model MODEL${label === 'chatgpt' ? '' : ' --window TOKENS --paid INPUT_USD:OUTPUT_USD --allowance USD'}` };
    }
    if ((op === 'remove' || op === 'refresh') && label) {
      const credentials = api.host.tryCall('credentials.list', null);
      const credential = (credentials.ok ? credentials.value : []).find(item => item.label === label || item.id === label);
      if (!credential) return { display: `Unknown credential ${label}` };
      const done = api.host.tryCall('credentials.request', { action: op, profile: credential.id });
      return { display: done.ok ? `${op === 'remove' ? 'Removal' : 'Refresh'} ${done.value.status} for ${credential.label}${op === 'remove' ? '; profiles using it stop at their next request until setup removes them' : ''}.` : done.error };
    }
    return { display: USAGE };
  }, { description: 'List, switch, enroll and remove account/provider profiles; switching applies at this thread\'s next turn' });
}
