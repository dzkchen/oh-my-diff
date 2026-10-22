import type { Json, ModAPI, TerminalPanelItem, TerminalSpan } from '../../api.d.ts';
import { NAME, PROVIDER, URLS, modelFor, origin, profileEntry, profilesOf, routeFor, serviceFor, type Profile } from './profiles.ts';

type Window = { minutes: number | null; used: number; resets: number | null };
type Quota = { windows: Window[]; at: number };
type Row = Profile & { billing: string; available: boolean };
type Saved = { profiles: Row[]; current: string | null; notice: string | null; pending: string | null; ours: boolean; seen: { profile: string; windows: string } | null; quota: Record<string, Quota> };

const USAGE = 'usage: /profile [list | next | use NAME | add chatgpt|api_key NAME | add provider NAME HTTPS_URL | remove NAME | refresh NAME]';
const PANEL = { command: 'omd_profiles:profile', args: 'panel' };

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ profiles: [], current: null, notice: null, pending: null, ours: false, seen: null, quota: {}, ...api.state.get() as unknown as Saved | null });
  const fit = (text: string, max: number) => [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
  const store = (patch: Partial<Saved>) => {
    const next = { ...saved(), ...patch };
    api.state.set(next as unknown as Json);
    api.host.tryCall('events.publish', { channel: 'routes', data: { current: next.current, pending: next.pending, notice: next.notice } });
  };
  const shared = (key: string) => {
    const got = api.host.tryCall('store.get', { key, scope: 'user' });
    return got.ok && got.value ? { value: got.value.value, revision: got.value.revision } : { value: null, revision: null };
  };
  const quotas = () => ({ quota: (shared('quota').value ?? {}) as unknown as Record<string, Quota> });
  const update = <T,>(key: string, change: (value: T | null) => T) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { value, revision } = shared(key);
      const next = change(value as T | null);
      if (api.host.tryCall('store.put', { key, value: next as unknown as Exclude<Json, null>, expected_revision: revision, scope: 'user' }).ok) return next;
    }
    return null;
  };
  const remember = (change: (quota: Record<string, Quota>) => void) => update<Record<string, Quota>>('quota', quota => { const next = quota ?? {}; change(next); return next; });
  const refresh = () => {
    const routes = api.host.tryCall('routes.list', null);
    if (!routes.ok) return;
    const rows = routes.value.filter(route => route.provider === PROVIDER && route.roles.includes('lead') && route.data)
      .map(route => ({ ...profilesOf([route])[0], billing: route.billing, available: route.available }));
    store({ profiles: rows, quota: quotas().quota });
  };
  const ensure = () => {
    const status = api.host.tryCall('sidecars.status', { id: PROVIDER });
    const sidecar = status.ok ? status.value : null;
    const changed = api.host.tryCall('store.get', { key: 'changed', scope: 'user' });
    const stale = changed.ok && changed.value !== null && (sidecar?.started_at_ms ?? 0) <= changed.value.provenance.at;
    if (sidecar?.running && !stale) return;
    if (status.ok) api.host.tryCall('providers.unregister', { id: PROVIDER });
    if (api.host.tryCall('providers.register', { id: PROVIDER }).ok) {
      api.host.tryCall('providers.models', { provider: PROVIDER, name: 'OMD profiles', models: saved().profiles.slice(0, 16).map(modelFor) });
    }
  };

  const windowName = (minutes: number | null) => minutes === 10080 ? 'wk' : minutes === null ? 'window' : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  const ago = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.floor(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
  };
  const bar = (used: number) => '▓'.repeat(Math.round(Math.min(100, used) / 20)).padEnd(5, '░');
  const windows = (quota: Quota | undefined, now: number) => (quota?.windows ?? []).map(slot => ({ name: windowName(slot.minutes),
    used: slot.resets !== null && slot.resets < now ? null : slot.used }));
  const summary = (profile: Row, quota: Quota | undefined, now: number) => {
    if (profile.billing !== 'included_subscription') return 'paid API, per request';
    if (!quota) return 'quota not seen yet';
    return [...windows(quota, now).map(slot => `${slot.name} ${slot.used === null ? 'reset' : `${slot.used}%`}`), `seen ${ago(now - quota.at)}`].join(' · ');
  };
  const kind = (profile: Row) => profile.kind === 'chatgpt' ? 'ChatGPT' : profile.kind === 'api_key' ? 'OpenAI API' : profile.protocol;

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
    if (!saved().ours) return;
    refresh();
    ensure();
    const { pending } = saved();
    if (!pending) return;
    const selected = api.host.tryCall('routes.select', { route: pending, scope: 'thread' });
    store(selected.ok ? { current: pending, pending: null, notice: null } : { pending: null, notice: `${pending}: ${selected.error}` });
  });
  api.on('app_notification', ({ method, params }) => {
    const { ours, current, seen: last } = saved();
    if (method !== 'account/rateLimits/updated' || !ours || !current) return;
    const limits = (params as Record<string, any> | null)?.rateLimits ?? {};
    const seen: Window[] = ['primary', 'secondary'].map(name => limits[name]).filter(slot => typeof slot?.usedPercent === 'number')
      .map(slot => ({ minutes: typeof slot.windowDurationMins === 'number' ? slot.windowDurationMins : null, used: Math.round(slot.usedPercent),
        resets: typeof slot.resetsAt === 'number' ? (slot.resetsAt < 1e12 ? slot.resetsAt * 1000 : slot.resetsAt) : null }));
    const key = JSON.stringify(seen);
    if (!seen.length || (last?.windows === key && last.profile !== current)) return;
    const quota = remember(all => { all[current] = { windows: seen, at: Date.now() }; });
    api.state.set({ ...saved(), seen: { profile: current, windows: key }, ...quota ? { quota } : {} } as unknown as Json);
  });
  api.intercept('model_request', (event, next) => {
    const { notice, pending } = saved();
    return notice || pending ? { deny: notice ?? `Profile selection pending: ${pending}` } : next(event);
  });
  api.on('terminal', () => {
    const { profiles, current, notice, pending, ours, quota } = saved();
    if (!ours) return null;
    const now = Date.now();
    const active = profiles.find(profile => profile.name === (pending ?? current));
    const spans: TerminalSpan[] = [{ text: `● ${fit(pending ?? current ?? '?', 24)}`, tone: 'accent', bold: true }];
    const part = (text: string, tone: TerminalSpan['tone'] = 'muted') => spans.push({ text: ' · ', tone: 'muted' }, { text, tone });
    if (notice) part(`switch failed: ${fit(notice, 60)}`, 'failure');
    else if (pending) part('switches at the next turn');
    else if (active?.billing !== 'included_subscription') part(active ? 'paid API' : 'unknown profile');
    else if (!quota[active.name]) part('quota not seen yet');
    else {
      for (const slot of windows(quota[active.name], now)) part(slot.used === null ? `${slot.name} reset` : `${slot.name} ${bar(slot.used)} ${slot.used}%`, slot.used !== null && slot.used >= 90 ? 'attention' : 'normal');
      part(ago(now - quota[active.name].at));
    }
    if (profiles.length > 1) part('Alt+s next · /profile');
    return { sites: { above_composer: { mode: 'wrap', components: [{ type: 'slot' }, { type: 'line', id: 'omd_profiles_meter', label: 'Profile', spans }] } },
      keybindings: { 'Alt+s': { command: 'omd_profiles:profile', args: 'next' } } };
  });

  const use = (profile: Row | undefined, label: string) => {
    const { ours } = saved();
    if (!profile) return `Unknown profile ${label || '(none)'}. ${USAGE}`;
    if (!ours) return 'Start this thread with omd-package profiles before switching profiles.';
    if (!profile.available) return `Profile ${profile.name} is unavailable.`;
    if (profile.billing !== 'included_subscription') {
      const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Use a paid API profile', message: `${profile.name} (${profile.model}) bills its API account per request. Switch at the next request?` });
      if (!answer.ok || answer.value.status !== 'accepted') return 'Kept the current profile.';
    }
    const session = api.host.tryCall('session.info', null);
    if (!session.ok) return 'Profile switch failed: current thread unavailable.';
    const updated = api.host.tryCall('app.request', { method: 'thread/settings/update', params: { threadId: session.value.thread_id, model: profile.name, effort: profile.effort ?? 'medium' } });
    if (!updated.ok) return `Profile switch failed: ${updated.error}`;
    store({ pending: profile.name, notice: null });
    return `Switching this thread to ${profile.name} at its next turn; its attachments and tool history are kept. Earlier reasoning is not sent to another account, and Chat Completions or Anthropic profiles get no hosted tools.`;
  };
  const ask = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? String(answer.value.value ?? '').trim() : '';
  };
  const write = (rows: Profile[], done: string) => {
    const profiles = rows.map(row => { const { billing: _billing, available: _available, ...profile } = row as Row; return profile; });
    const written = api.host.tryCall('routes.write', { routes: profiles.map(routeFor), services: serviceFor(profiles) });
    if (!written.ok) return `Profiles unchanged: ${written.error}`;
    if ('status' in written.value) return 'Profiles unchanged.';
    const { current } = saved();
    const restart = update<number>('changed', () => Date.now()) === null ? ' Other sessions use it after they restart.' : '';
    store({ profiles: profiles.map(profile => ({ ...profile, billing: profile.paid ? 'explicit_paid_api_grant' : 'included_subscription', available: true })),
      current: profiles.some(profile => profile.name === current) ? current : null });
    return done && `${done}${restart}`;
  };
  const add = (kindName: string, name: string, url: string) => {
    const { profiles, current } = saved();
    if (!NAME.test(name)) return 'Profile names use lowercase letters, digits, _ or - (at most 32).';
    if (profiles.some(profile => profile.name === name)) return `Profile ${name} already exists.`;
    if (kindName === 'provider' && !origin(url)) return 'The endpoint must be an https URL.';
    const enroll = () => api.host.tryCall('credentials.request', kindName === 'provider'
      ? { action: 'enroll', kind: 'provider', label: name, provider: name, origin: origin(url)! }
      : { action: 'enroll', kind: kindName as 'chatgpt' | 'api_key', label: name });
    const base = profiles.find(profile => profile.name === current) ?? profiles[0];
    if (!base?.router) {
      const enrolled = enroll();
      if (!enrolled.ok || enrolled.value.status !== 'completed') return enrolled.ok ? 'Enrollment cancelled.' : enrolled.error;
      return `Enrolled "${name}". Set up the first profile from a terminal, then start with it; later accounts can be added here:\nomd-package profiles --setup --add ${name} --credential "${name}" --protocol ${kindName === 'provider' ? 'chat|anthropic|responses' : 'responses'} --url ${kindName === 'provider' ? url : URLS[kindName]} --upstream-model MODEL${kindName === 'chatgpt' ? '' : ' --window TOKENS --paid INPUT_USD:OUTPUT_USD --allowance USD'}\nomd-package profiles --model ${name}`;
    }
    const template = kindName === 'chatgpt' ? [base, ...profiles].find(profile => profile.kind === 'chatgpt') : undefined;
    const model = template?.model ?? ask('Upstream model', `Model name at ${kindName === 'provider' ? url : 'the OpenAI API'}, for example gpt-6.1-sol`);
    if (!model) return 'Cancelled.';
    const known = profiles.find(profile => profile.model === model);
    const size = known?.window ?? Number(ask('Context window', `Tokens ${model} accepts, for example 272000`));
    if (!Number.isInteger(size) || size <= 0) return 'Cancelled: the context window is a whole number of tokens.';
    const paid = kindName === 'chatgpt' ? null : ask('Price', 'INPUT_USD:OUTPUT_USD per million tokens, for example 1.25:10');
    if (kindName !== 'chatgpt' && !paid) return 'Cancelled.';
    const protocol = kindName !== 'provider' ? 'responses' : (() => {
      const picked = api.host.tryCall('terminal.prompt', { kind: 'choice', title: 'Protocol', message: `How ${url} speaks`,
        options: [{ value: 'chat', label: 'Chat Completions' }, { value: 'anthropic', label: 'Anthropic Messages' }, { value: 'responses', label: 'OpenAI Responses' }] });
      return picked.ok && picked.value.status === 'accepted' ? String(picked.value.value ?? '') : '';
    })();
    if (!protocol) return 'Cancelled.';
    const enrolled = enroll();
    if (!enrolled.ok || enrolled.value.status !== 'completed' || !enrolled.value.profile) return enrolled.ok ? 'Enrollment cancelled.' : enrolled.error;
    let profile: Profile;
    try {
      profile = { ...profileEntry({ name, credential: enrolled.value.profile.id, protocol, url: kindName === 'provider' ? url : URLS[kindName], model, window: size, paid,
        reasoning: template?.reasoning, cache_control: template?.cache_control, text_only: template?.text_only, max_output: template?.max_output }, [enrolled.value.profile]),
      effort: template?.effort ?? 'medium', efforts: template?.efforts ?? ['low', 'medium', 'high'], router: base.router };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return `${error.message}. The sign-in "${name}" was kept; /profile remove ${name} drops it.`;
    }
    const result = write([...profiles, profile], `Added ${name}. Switch with Alt+s or /profile use ${name}; it applies at this thread's next turn.`);
    return result.startsWith('Added') ? result : `${result} The sign-in "${name}" was kept; /profile remove ${name} drops it.`;
  };
  const remove = (name: string) => {
    const { profiles, current, pending } = saved();
    const profile = profiles.find(item => item.name === name);
    const credential = profile?.credential ?? (() => {
      const listed = api.host.tryCall('credentials.list', null);
      return (listed.ok ? listed.value : []).find(item => item.label === name || item.id === name)?.id;
    })();
    if (!credential) return `Unknown profile ${name}`;
    const user = profile ? undefined : profiles.find(item => item.credential === credential);
    if (user) return `${name} is the sign-in of profile ${user.name}; remove that profile instead.`;
    if (profile && (profile.name === current || profile.name === pending)) return `${name} is this thread's profile; switch to another one first.`;
    if (profile && profiles.length === 1) return `${name} is the last profile; remove it with omd-package profiles --setup --remove ${name}.`;
    if (profile) {
      const result = write(profiles.filter(item => item !== profile), '');
      if (result) return result;
      remember(quota => { delete quota[name]; });
    }
    if (profiles.some(item => item !== profile && item.credential === credential)) return `Removed ${name}.`;
    const done = api.host.tryCall('credentials.request', { action: 'remove', profile: credential });
    return done.ok ? `Removed ${name}${done.value.status === 'completed' ? ' and its sign-in' : '; its sign-in was kept'}.` : `Removed ${name}; its sign-in was kept: ${done.error}`;
  };
  const panel = (result?: string) => {
    const { profiles, current, pending } = saved();
    const { quota } = quotas();
    const now = Date.now();
    const items: TerminalPanelItem[] = [
      ...profiles.map(profile => ({ id: `use:${profile.name}`, kind: 'action' as const,
        label: `${profile.name === (pending ?? current) ? '●' : '○'} ${profile.name}${profile.available ? '' : ' (unavailable)'}`,
        description: `${kind(profile)} · ${profile.model} · ${summary(profile, quota[profile.name], now)}` })),
      { id: 'add:chatgpt', kind: 'action', label: '+ Add ChatGPT account', description: 'Sign in to another ChatGPT account on the same model' },
      { id: 'add:api_key', kind: 'action', label: '+ Add OpenAI API key', description: 'Paid per request against your allowance' },
      { id: 'add:provider', kind: 'action', label: '+ Add another provider', description: 'Any OpenAI-, Chat Completions- or Anthropic-compatible endpoint' },
      ...profiles.length > 1 ? [{ id: 'remove', kind: 'action' as const, label: 'Remove a profile…', description: 'Drops its route and, if unused, its sign-in' }] : [],
    ];
    const shown = api.host.tryCall('terminal.panel', { title: 'Profiles', subtitle: result ? fit(result, 200) : 'Enter switches this thread at its next turn · Alt+s cycles', items, action: PANEL });
    return shown.ok ? null : { display: `Profiles: ${shown.error}` };
  };
  const choose = (title: string, names: string[]) => {
    const picked = api.host.tryCall('terminal.prompt', { kind: 'choice', title, message: 'Pick one', options: names.map(name => ({ value: name, label: name })) });
    return picked.ok && picked.value.status === 'accepted' ? String(picked.value.value ?? '') : '';
  };

  api.command('profile', value => {
    const [op = '', label = '', extra = '', url = ''] = String(value ?? '').trim().split(/\s+/);
    const { profiles, current, pending, notice } = saved();
    const named = (name: string) => profiles.find(item => item.name === name);
    if (!op) return panel();
    if (op === 'panel') {
      const [action, target = ''] = label.split(':');
      if (!action) return panel();
      const name = action === 'add' ? ask('Profile name', 'Lowercase letters, digits, _ or -, for example work2') : '';
      const display = action === 'use' ? use(named(target), target)
        : action === 'add' && target === 'provider' ? (name ? add('provider', name, ask('Endpoint URL', 'The https URL requests go to, for example https://openrouter.ai/api/v1/chat/completions')) : 'Cancelled.')
        : action === 'add' ? (name ? add(target, name, '') : 'Cancelled.')
        : action === 'remove' ? (() => {
          const picked = choose('Remove a profile', profiles.filter(item => item.name !== (pending ?? current)).map(item => item.name));
          return picked ? remove(picked) : 'Cancelled.';
        })() : USAGE;
      return panel(display);
    }
    if (op === 'list') {
      if (!profiles.length) return { display: 'No provider profiles. Run `omd-package profiles --setup --add NAME ...` once from a terminal.' };
      const { quota } = quotas();
      return { display: [...notice ? [`Last switch failed: ${notice}`] : [], ...profiles.map(profile =>
        `${profile.name === (pending ?? current) ? '●' : '○'} ${profile.name} · ${kind(profile)} · ${profile.model} · ${summary(profile, quota[profile.name], Date.now())}${profile.available ? '' : ' · unavailable'}`)].join('\n') };
    }
    if (op === 'next') {
      const ready = profiles.filter(profile => profile.available);
      if (ready.length < 2) return { display: 'No other profile to switch to. Add one with /profile.' };
      const index = ready.findIndex(profile => profile.name === (pending ?? current));
      return { display: use(ready[(index + 1) % ready.length], '') };
    }
    if (op === 'use') return { display: use(named(label), label) };
    if (op === 'add' && ['chatgpt', 'api_key'].includes(label) && extra) return { display: add(label, extra, '') };
    if (op === 'add' && label === 'provider' && extra && /^https:\/\//.test(url)) return { display: add('provider', extra, url) };
    if (op === 'remove' && label) return { display: remove(label) };
    if (op === 'refresh' && label) {
      const credentials = api.host.tryCall('credentials.list', null);
      const credential = (credentials.ok ? credentials.value : []).find(item => item.label === label || item.id === label);
      if (!credential) return { display: `Unknown credential ${label}` };
      const done = api.host.tryCall('credentials.request', { action: 'refresh', profile: credential.id });
      return { display: done.ok ? `Refresh ${done.value.status} for ${credential.label}.` : done.error };
    }
    return { display: USAGE };
  }, { description: 'Switch, add and remove ChatGPT accounts, API keys and providers; switching applies at this thread\'s next turn' });
}
