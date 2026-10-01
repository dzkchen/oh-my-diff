import type { Json, ModAPI, RouteInfo } from '../../api.d.ts';

const PROVIDER = 'omd_profiles';
type Profile = { name: string; model: string; billing: RouteInfo['billing']; available: boolean; credential: string | null };
type Saved = { profiles: Profile[]; current: string | null; notice: string | null };

const USAGE = 'usage: /profile [use NAME | add chatgpt|api_key|provider LABEL [PROVIDER] | remove LABEL | refresh LABEL]';

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ profiles: [], current: null, notice: null, ...api.state.get() as unknown as Saved | null });
  const store = (patch: Partial<Saved>) => {
    const next = { ...saved(), ...patch };
    api.state.set(next as unknown as Json);
    api.host.tryCall('events.publish', { channel: 'routes', data: next as unknown as Json });
  };
  const refresh = () => {
    const routes = api.host.tryCall('routes.list', null);
    if (routes.ok) store({ profiles: routes.value.filter(route => route.provider === PROVIDER && route.roles.includes('lead'))
      .map(({ name, model, billing, available, credential }) => ({ name, model, billing, available, credential })) });
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
    if (route) api.state.set({ ...saved(), current: route.name } as unknown as Json);
    return route ? { route: route.name } : null;
  });
  api.on('start', refresh);
  api.on('resume', refresh);
  api.on('turn_start', () => {
    const config = api.host.tryCall('app.request', { method: 'config/read', params: {} });
    if (config.ok && (config.value as { config?: { model_provider?: string } }).config?.model_provider === PROVIDER) ensure();
  });
  api.on('channel', ({ channel, data }) => {
    const route = (data as { use?: string } | null)?.use;
    if (channel !== 'omd_profiles/select' || !route) return;
    const selected = api.host.tryCall('routes.select', { route, scope: 'thread' });
    store(selected.ok ? { current: route, notice: null } : { notice: `${route}: ${selected.error}` });
    refresh();
  });
  api.on('terminal', () => {
    const { current, notice } = saved();
    return current || notice ? { status: [`profile ${current ?? 'none'}${notice ? ` (switch failed ${notice})` : ''}`] } : null;
  });

  api.command('profile', value => {
    const [op = '', label = '', extra = ''] = String(value ?? '').trim().split(/\s+/);
    const { profiles, current } = saved();
    const credentials = api.host.tryCall('credentials.list', null);
    const known = credentials.ok ? credentials.value : [];
    if (!op || op === 'list') {
      if (!profiles.length) return { display: 'No provider profiles. Enroll a credential with `/profile add`, then run the printed `omd-package profiles --setup` command.' };
      return { display: profiles.map(profile => {
        const credential = known.find(item => item.id === profile.credential);
        return `${profile.name === current ? '●' : '○'} ${profile.name} · ${profile.model} · ${profile.billing === 'included_subscription' ? 'subscription' : 'paid API'} · ${credential ? `${credential.kind} ${credential.label}` : 'credential missing'}${profile.available ? '' : ' · unavailable'}`;
      }).join('\n') };
    }
    if (op === 'use') {
      const profile = profiles.find(item => item.name === label);
      if (!profile) return { display: `Unknown profile ${label || '(none)'}. ${USAGE}` };
      if (profile.billing !== 'included_subscription') {
        const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Use a paid API profile', message: `${profile.name} (${profile.model}) bills its API account per request. Switch at the next request?` });
        if (!answer.ok || answer.value.status !== 'accepted') return { display: 'Kept the current profile.' };
      }
      const published = api.host.tryCall('events.publish', { channel: 'select', data: { use: profile.name } });
      return { display: published.ok ? `Switching to ${profile.name} at the next request; this thread, its attachments and tool history are kept. Earlier reasoning is not sent to another account, and Chat Completions or Anthropic profiles get no hosted tools.` : published.error };
    }
    if (op === 'add' && ['chatgpt', 'api_key', 'provider'].includes(label) && extra) {
      const provider = String(value).trim().split(/\s+/)[3];
      const enrolled = api.host.tryCall('credentials.request', { action: 'enroll', kind: label as 'chatgpt' | 'api_key' | 'provider', label: extra, ...provider ? { provider } : {} });
      if (!enrolled.ok || enrolled.value.status !== 'completed') return { display: enrolled.ok ? 'Enrollment cancelled.' : enrolled.error };
      const url = label === 'chatgpt' ? 'https://chatgpt.com/backend-api/codex/responses' : label === 'api_key' ? 'https://api.openai.com/v1/responses' : 'URL';
      return { display: `Enrolled ${label} credential "${extra}". Add a profile from a terminal, then /profile use NAME here (no restart):\nomd-package profiles --setup --add NAME --credential "${extra}" --protocol ${label === 'provider' ? 'chat|anthropic|responses' : 'responses'} --url ${url} --upstream-model MODEL${label === 'chatgpt' ? '' : ' --window TOKENS --paid INPUT_USD:OUTPUT_USD'}` };
    }
    if ((op === 'remove' || op === 'refresh') && label) {
      const credential = known.find(item => item.label === label || item.id === label);
      if (!credential) return { display: `Unknown credential ${label}` };
      const done = api.host.tryCall('credentials.request', { action: op, profile: credential.id });
      return { display: done.ok ? `${op === 'remove' ? 'Removal' : 'Refresh'} ${done.value.status} for ${credential.label}${op === 'remove' ? '; profiles using it stop at their next request until setup removes them' : ''}.` : done.error };
    }
    return { display: USAGE };
  }, { description: 'List, switch, enroll and remove account/provider profiles; switching applies at the next request' });
}
