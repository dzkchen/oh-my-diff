import type { Json, ModAPI, TerminalPanelItem, TerminalSpan } from '../../api.d.ts';
import { NAME, PROVIDER, URLS, modelFor, origin, profileEntry, profilesOf, routeFor, serviceFor, type Profile } from './profiles.ts';

type Window = { minutes: number | null; used: number; resets: number | null };
type Quota = { windows: Window[]; at: number };
type Account = { name: string; provider: string; model: string; effort: string; billing: string; available: boolean; profile: Profile | null };
type Saved = { accounts: Account[]; mod?: string; watch?: { provider: string; known: string[]; polls: number } | null; current: string | null; notice: string | null; pending: string | null; ours: boolean; seen: { profile: string; windows: string } | null; quota: Record<string, Quota> };

const USAGE = 'usage: /profile [list | next | use NAME | add [chatgpt|claude|cursor|api_key|anthropic NAME] | add provider NAME HTTPS_URL | remove NAME | refresh NAME]';
const KINDS = [['chatgpt', 'ChatGPT account'], ['claude', 'Claude account'], ['cursor', 'Cursor account'], ['api_key', 'OpenAI API key'],
  ['anthropic', 'Anthropic API key'], ['provider', 'Other provider (URL)']];
const ACCOUNT = /^[a-z][a-z0-9_-]{0,23}$/;
const NODE_MISSING = 'Node.js was not found on PATH. Install it (brew install node, or from nodejs.org), restart OMD, then try again.';
const PANEL = { command: 'omd_profiles:profile', args: 'panel' };
const PROVIDERS: Record<string, { label: string; family: string; command: string; prefix: string }> = {
  omd_claude_cli: { label: 'Claude', family: 'claude', command: '/claude remove', prefix: 'claude' },
  omd_cursor: { label: 'Cursor', family: 'cursor', command: '/cursor remove', prefix: 'cursor' },
};

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ accounts: [], current: null, notice: null, pending: null, ours: false, seen: null, quota: {}, ...api.state.get() as unknown as Saved | null });
  const owned = (accounts: Account[]) => accounts.flatMap(account => account.profile ? [account.profile] : []);
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
    const accounts = routes.value.filter(route => route.roles.includes('lead') && (route.provider !== PROVIDER || route.data))
      .map(route => ({ name: route.name, provider: route.provider, model: route.model, effort: route.reasoning, billing: route.billing, available: route.available,
        profile: route.provider === PROVIDER ? profilesOf([route])[0] : null }));
    const { provider, model } = api.session();
    const { current } = saved();
    const prefix = PROVIDERS[provider]?.prefix;
    const named = prefix && model?.includes('.') ? `${prefix}-${model.slice(model.lastIndexOf('.') + 1)}` : null;
    const mine = accounts.filter(account => account.provider === provider);
    const on = mine.find(account => account.model === model) ?? mine.find(account => account.name === named)
      ?? mine.find(account => prefix && account.name === prefix) ?? mine.find(account => account.name === current);
    const listed = saved().mod ? null : api.host.tryCall('packages.list', { fields: ['id', 'path'] });
    const mod = listed?.ok ? listed.value.packages.find(item => item.id === PROVIDER)?.path : undefined;
    store({ accounts, quota: quotas().quota, ours: accounts.some(account => account.provider === provider), current: on?.name ?? null, ...mod ? { mod } : {} });
  };
  const ensure = () => {
    const status = api.host.tryCall('sidecars.status', { id: PROVIDER });
    const sidecar = status.ok ? status.value : null;
    const changed = api.host.tryCall('store.get', { key: 'changed', scope: 'user' });
    const stale = changed.ok && changed.value !== null && (sidecar?.started_at_ms ?? 0) <= changed.value.provenance.at;
    if (sidecar?.running && !stale) return;
    if (status.ok) api.host.tryCall('providers.unregister', { id: PROVIDER });
    if (api.host.tryCall('providers.register', { id: PROVIDER }).ok) {
      api.host.tryCall('providers.models', { provider: PROVIDER, name: 'OMD profiles', models: owned(saved().accounts).slice(0, 16).map(modelFor) });
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
  const billed = (account: Account) => account.billing === 'explicit_paid_api_grant' ? 'paid API, per request'
    : account.billing === 'provider_billed' ? `billed by ${kind(account)}` : 'quota not seen yet';
  const summary = (account: Account, quota: Quota | undefined, now: number) => !quota ? billed(account)
    : [...windows(quota, now).map(slot => `${slot.name} ${slot.used === null ? 'reset' : `${slot.used}%`}`), `seen ${ago(now - quota.at)}`].join(' · ');
  const kind = (account: Account) => {
    const profile = account.profile;
    if (!profile) return PROVIDERS[account.provider]?.label ?? account.provider;
    return profile.kind === 'chatgpt' ? 'ChatGPT' : profile.kind === 'api_key' ? 'OpenAI API' : origin(profile.url) === origin(URLS.anthropic) ? 'Anthropic API' : profile.protocol;
  };

  api.replace('routing', ({ routes, model, provider }) => {
    if (provider !== PROVIDER) return null;
    const ours = routes.filter(route => route.provider === PROVIDER);
    const route = ours.find(route => route.model === model);
    if (route) api.state.set({ ...saved(), current: route.name, ours: true } as unknown as Json);
    return route ? { route: route.name } : null;
  });
  api.on('start', refresh);
  api.on('resume', refresh);
  const watching = () => {
    const watch = saved().watch;
    if (!watch) return;
    const found = saved().accounts.some(account => account.provider === watch.provider && !watch.known.includes(account.name));
    if (found || watch.polls >= 60) return store({ watch: null });
    store({ watch: { ...watch, polls: watch.polls + 1 } });
    api.host.tryCall('events.schedule', { key: 'accounts', delay_ms: 5_000 });
  };
  api.on('channel', ({ channel, data }) => {
    if (channel !== `${PROVIDER}/added`) return;
    refresh();
    const provider = (data as { watch?: string } | null)?.watch;
    if (!provider) return ensure();
    store({ watch: { provider, known: saved().accounts.filter(account => account.provider === provider).map(account => account.name), polls: 0 } });
    watching();
  });
  api.on('timer', ({ key }) => {
    if (key !== 'accounts') return;
    refresh();
    watching();
  });
  // State is per thread: a requested switch applies to the thread it was asked in, at its next turn.
  api.on('turn_start', () => {
    refresh();
    const { pending, accounts } = saved();
    const target = accounts.find(account => account.name === pending);
    const provider = api.session().provider;
    if (provider === PROVIDER) ensure();
    if (!pending) return;
    if (target?.provider !== provider) return store({ pending: null, notice: null });
    if (provider !== PROVIDER) return store({ current: pending, pending: null, notice: null });
    const selected = api.host.tryCall('routes.select', { route: pending, scope: 'thread' });
    store(selected.ok ? { current: pending, pending: null, notice: null } : { pending: null, notice: `${pending}: ${selected.error}` });
  });
  api.on('app_notification', ({ method, params }) => {
    const { accounts, current, seen: last } = saved();
    const account = accounts.find(item => item.name === current);
    if (method !== 'account/rateLimits/updated' || !account) return;
    const limits = (params as Record<string, any> | null)?.rateLimits ?? {};
    if ((limits.limitId ?? 'codex') !== (PROVIDERS[account.provider]?.family ?? 'codex')) return;
    const seen: Window[] = ['primary', 'secondary'].map(name => limits[name]).filter(slot => typeof slot?.usedPercent === 'number')
      .map(slot => ({ minutes: typeof slot.windowDurationMins === 'number' ? slot.windowDurationMins : null, used: Math.round(slot.usedPercent),
        resets: typeof slot.resetsAt === 'number' ? (slot.resetsAt < 1e12 ? slot.resetsAt * 1000 : slot.resetsAt) : null }));
    const key = JSON.stringify(seen);
    if (!seen.length || (last?.windows === key && last.profile !== current)) return;
    const quota = remember(all => { all[account.name] = { windows: seen, at: Date.now() }; });
    api.state.set({ ...saved(), seen: { profile: account.name, windows: key }, ...quota ? { quota } : {} } as unknown as Json);
  });
  api.intercept('model_request', (event, next) => {
    const { notice, pending } = saved();
    return notice || pending ? { deny: notice ?? `Profile selection pending: ${pending}` } : next(event);
  });
  api.on('terminal', () => {
    const { accounts, current, notice, pending, ours, quota } = saved();
    if (!ours) return null;
    const now = Date.now();
    const active = accounts.find(account => account.name === (pending ?? current));
    const spans: TerminalSpan[] = [{ text: `● ${fit(pending ?? current ?? '?', 24)}`, tone: 'accent', bold: true }];
    const part = (text: string, tone: TerminalSpan['tone'] = 'muted') => spans.push({ text: ' · ', tone: 'muted' }, { text, tone });
    if (notice) part(`switch failed: ${fit(notice, 60)}`, 'failure');
    else if (pending) part('switches at the next turn');
    else if (!active) part('unknown account');
    else if (!quota[active.name]) part(active.billing === 'explicit_paid_api_grant' ? 'paid API' : active.billing === 'provider_billed' ? `billed by ${kind(active)}` : 'quota not seen yet');
    else {
      for (const slot of windows(quota[active.name], now)) part(slot.used === null ? `${slot.name} reset` : `${slot.name} ${bar(slot.used)} ${slot.used}%`, slot.used !== null && slot.used >= 90 ? 'attention' : 'normal');
      part(ago(now - quota[active.name].at));
    }
    if (accounts.length > 1) part('Alt+s next · /profile');
    return { sites: { above_composer: { mode: 'wrap', components: [{ type: 'slot' }, { type: 'line', id: 'omd_profiles_meter', label: 'Profile', spans }] } },
      keybindings: { 'Alt+s': { command: 'omd_profiles:profile', args: 'next' } } };
  });

  const use = (account: Account | undefined, label: string) => {
    if (!account) return `Unknown profile ${label || '(none)'}. ${USAGE}`;
    if (!account.available) return `Profile ${account.name} is unavailable.`;
    if (account.billing !== 'included_subscription') {
      const message = account.billing === 'provider_billed' ? `${account.name} (${account.model}) is billed by your ${kind(account)} account beyond its included usage. Switch at the next request?`
        : `${account.name} (${account.model}) bills its API account per request. Switch at the next request?`;
      const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Use a paid account', message });
      if (!answer.ok || answer.value.status !== 'accepted') return 'Kept the current profile.';
    }
    const session = api.host.tryCall('session.info', null);
    if (!session.ok) return 'Profile switch failed: current thread unavailable.';
    const updated = api.host.tryCall('app.request', { method: 'thread/settings/update', params: { threadId: session.value.thread_id, model: account.model,
      modelProvider: account.provider, effort: account.effort } });
    if (!updated.ok) return `Profile switch failed: ${updated.error}`;
    store({ pending: account.name, notice: null });
    return `Switching this thread to ${account.name} (${kind(account)}) at its next turn; its attachments and tool history are kept. Earlier reasoning is not sent to another account${account.profile && account.profile.protocol !== 'responses' ? ', and Chat Completions or Anthropic profiles get no hosted tools' : ''}.`;
  };
  const choose = (title: string, message: string, options: string[][]) => {
    const picked = api.host.tryCall('terminal.prompt', { kind: 'choice', title, message, options: options.map(([value, label]) => ({ value, label })) });
    return picked.ok && picked.value.status === 'accepted' ? String(picked.value.values?.[0] ?? picked.value.value ?? '') : '';
  };
  const ask = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'text', title, message });
    return answer.ok && answer.value.status === 'accepted' ? String(answer.value.value ?? '').trim() : '';
  };
  const setup = (argv: string[], stdin?: string): { stdout: string } | { error: string } => {
    const { mod } = saved();
    if (!mod) return { error: 'the installed mod was not found; send a message in this thread, then try again.' };
    const run = api.host.tryCall('exec.run', { program: 'node', argv: [`${mod}/setup.mjs`, ...argv], ...stdin === undefined ? {} : { stdin }, sandbox: 'none', timeout_ms: 60_000 });
    if (!run.ok) return { error: run.error.startsWith('exec_program_unavailable') ? NODE_MISSING : run.error };
    return run.value.exit_code === 0 ? { stdout: run.value.stdout } : { error: run.value.stderr.trim() };
  };
  const catalog = (model: string): { window: number; effort: string; efforts: string[] } | { error: string } | null => {
    const found = setup(['catalog', model]);
    if ('error' in found) return found.error === NODE_MISSING ? found : null;
    try { return JSON.parse(found.stdout); } catch { return null; }
  };
  const write = (profiles: Profile[], done: string) => {
    const written = api.host.tryCall('routes.write', { routes: profiles.map(routeFor), services: serviceFor(profiles) });
    if (!written.ok) return `Profiles unchanged: ${written.error}`;
    if ('status' in written.value) return 'Profiles unchanged.';
    return adopt(profiles, done);
  };
  // Only the first profile (which creates the router's service grant) and a new allowance write host.json outside routes.write.
  const bootstrap = (profiles: Profile[], added: Profile, allowance: number | null, done: string) => {
    const first = !profiles.some(profile => profile !== added && profile.router);
    const changes = [`Add model route ${added.name}: ${added.model}, ${added.paid ? 'paid API, per request' : 'subscription'}`,
      ...first ? ['Add service omd_profiles: runs the omd_profiles router (node) with network access and the sign-ins of your profiles'] : [],
      ...allowance === null ? [] : [`Let paid API profiles spend at most $${allowance} per thread`]];
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Change model routes', message: changes.join('\n') });
    if (!answer.ok || answer.value.status !== 'accepted') return 'Profiles unchanged.';
    const run = setup(['session'], JSON.stringify({ profiles, allowance }));
    if ('error' in run) return `Profiles unchanged: ${run.error}`;
    return adopt((JSON.parse(run.stdout) as { profiles: Profile[] }).profiles, done);
  };
  const adopt = (profiles: Profile[], done: string) => {
    const { accounts, current } = saved();
    const restart = update<number>('changed', () => Date.now()) === null ? ' Other sessions use it after they restart.' : '';
    const kept = accounts.filter(account => !account.profile);
    store({ accounts: [...profiles.map(profile => ({ name: profile.name, provider: PROVIDER, model: profile.name, effort: profile.effort ?? 'medium',
      billing: profile.paid ? 'explicit_paid_api_grant' : 'included_subscription', available: true, profile })), ...kept],
    current: profiles.some(profile => profile.name === current) || kept.some(account => account.name === current) ? current : null });
    api.host.tryCall('events.publish', { channel: 'added', data: {} });
    return done && `${done}${restart}`;
  };
  const allowance = () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = ask('Allowance', `USD that paid profiles in a thread may spend in total, for example 20${attempt ? ' (a number above zero)' : ''}`);
      if (!text) return null;
      const usd = Number(text.replace(/^\$/, '').trim());
      if (Number.isFinite(usd) && usd > 0) return usd;
    }
    return null;
  };
  const add = (kindName: string, name: string, url: string) => {
    const { accounts, current } = saved();
    const profiles = owned(accounts);
    if (!NAME.test(name)) return 'Profile names use lowercase letters, digits, _ or - (at most 32).';
    if (accounts.some(account => account.name === name)) return `Profile ${name} already exists.`;
    if (kindName === 'provider' && !origin(url)) return 'The endpoint must be an https URL.';
    const endpoint = kindName === 'provider' ? url : URLS[kindName];
    const credentialKind = kindName === 'provider' || kindName === 'anthropic' ? 'provider' : kindName;
    const enroll = () => {
      const listed = api.host.tryCall('credentials.list', null);
      const kept = (listed.ok ? listed.value : []).find(item => item.label === name && item.kind === credentialKind && item.origin === origin(endpoint));
      if (kept) return kept;
      const enrolled = api.host.tryCall('credentials.request', credentialKind === 'provider'
        ? { action: 'enroll', kind: 'provider', label: name, provider: kindName === 'anthropic' ? 'anthropic' : name, origin: origin(endpoint)! }
        : { action: 'enroll', kind: kindName as 'chatgpt' | 'api_key', label: name });
      if (!enrolled.ok) return enrolled.error;
      return enrolled.value.status === 'completed' && enrolled.value.profile ? enrolled.value.profile : 'Enrollment cancelled.';
    };
    const base = profiles.find(profile => profile.name === current) ?? profiles[0];
    const fixed = kindName === 'provider' ? null : kindName === 'anthropic' ? 'anthropic' : 'responses';
    const template = kindName === 'chatgpt' ? [base, ...profiles].find(profile => profile?.kind === 'chatgpt') : undefined;
    const where = kindName === 'provider' ? url : kindName === 'anthropic' ? 'the Anthropic API, for example claude-sonnet-4-5'
      : kindName === 'chatgpt' ? 'ChatGPT, for example gpt-6.1-sol' : 'the OpenAI API, for example gpt-6.1-sol';
    const model = template?.model ?? ask('Upstream model', `Model name at ${where}`);
    if (!model) return 'Cancelled.';
    const listed = profiles.find(profile => profile.model === model);
    const known = listed ? { window: listed.window, effort: listed.effort, efforts: listed.efforts } : catalog(model);
    if (known && 'error' in known) return known.error;
    const size = known?.window ?? Number(ask('Context window', `Tokens ${model} accepts, for example ${kindName === 'anthropic' ? '200000' : '272000'}`));
    if (!Number.isInteger(size) || size <= 0) return 'Cancelled: the context window is a whole number of tokens.';
    const paid = kindName === 'chatgpt' ? null : ask('Price', `INPUT_USD:OUTPUT_USD per million tokens, for example ${kindName === 'anthropic' ? '3:15' : '1.25:10'}`);
    if (kindName !== 'chatgpt' && !paid) return 'Cancelled.';
    const protocol = fixed ?? choose('Protocol', `How ${url} speaks`, [['chat', 'Chat Completions'], ['anthropic', 'Anthropic Messages'], ['responses', 'OpenAI Responses']]);
    if (!protocol) return 'Cancelled.';
    const credential = enroll();
    if (typeof credential === 'string') return credential;
    const kept = `The sign-in "${name}" was kept: /profile add reuses it, /profile remove ${name} drops it.`;
    let profile: Profile;
    try {
      profile = { ...profileEntry({ name, credential: credential.id, protocol, url: endpoint, model, window: size, paid,
        reasoning: template?.reasoning, cache_control: template?.cache_control, text_only: template?.text_only, max_output: template?.max_output }, [credential]),
      effort: known?.effort ?? 'medium', efforts: known?.efforts?.length ? known.efforts : ['low', 'medium', 'high'], router: base?.router };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return `${error.message}. ${kept}`;
    }
    const done = `Added ${name}. Switch with Alt+s or /profile use ${name}; it applies at this thread's next turn.`;
    const next = [...profiles, profile];
    let result = base?.router ? write(next, done) : bootstrap(next, profile, null, done);
    if (/allowance_required/.test(result)) {
      const usd = allowance();
      result = usd === null ? 'Cancelled: paid profiles need an allowance.' : bootstrap(next, profile, usd, done);
    }
    return result.startsWith('Added') ? result : `${result} ${kept}`;
  };
  const subscription = (kindName: string, name: string) => {
    if (!ACCOUNT.test(name) || name === 'api') return 'Account names start with a letter and use lowercase letters, digits, _ or - (at most 24).';
    const claude = kindName === 'claude';
    const billing = claude ? choose('Claude billing', 'Use your Claude plan or Console API credits', [['plan', 'Claude plan (Pro, Max, Team or Enterprise)'], ['api', 'Console API credits']]) : 'plan';
    if (!billing) return 'Cancelled.';
    const invoked = api.host.tryCall('commands.invoke', claude ? { command: 'omd_claude_cli:claude', args: `login ${billing === 'api' ? 'api ' : ''}${name}` } : { command: 'omd_cursor:cursor', args: `setup ${name}` });
    if (!invoked.ok) return `${claude ? 'Claude' : 'Cursor'} sign-in did not start: ${invoked.error}. Turn on ${claude ? 'omd_claude_cli' : 'omd_cursor'} in /mods first.`;
    if ('status' in invoked.value) return 'Cancelled.';
    api.host.tryCall('events.publish', { channel: 'added', data: { watch: claude ? 'omd_claude_cli' : 'omd_cursor' } });
    const display = (invoked.value.result as { display?: string } | null)?.display;
    return `${display ?? 'Sign-in started.'} When it finishes, the account shows here and in /model.`;
  };
  const begin = (kindName?: string, given?: string, url?: string) => {
    const kind = kindName || choose('Add an account', 'What to add', KINDS);
    if (!KINDS.some(([value]) => value === kind)) return kind ? USAGE : 'Cancelled.';
    const account = kind === 'claude' || kind === 'cursor';
    const name = given || ask(account ? 'Account name' : 'Profile name', account
      ? `Lowercase letters, digits, _ or -, for example work${kind === 'claude' ? '; default uses your Claude Code login' : ''}`
      : 'Lowercase letters, digits, _ or -, for example work2');
    if (!name) return 'Cancelled.';
    if (account) return subscription(kind, name);
    const endpoint = kind === 'provider' ? url || ask('Endpoint URL', 'The https URL requests go to, for example https://openrouter.ai/api/v1/chat/completions') : '';
    return kind === 'provider' && !endpoint ? 'Cancelled.' : add(kind, name, endpoint);
  };
  const remove = (name: string) => {
    const { accounts, current, pending } = saved();
    const profiles = owned(accounts);
    const foreign = accounts.find(account => account.name === name && !account.profile);
    if (foreign) {
      const from = PROVIDERS[foreign.provider];
      return `${name} comes from ${foreign.provider}; remove it there${from ? ` with ${from.command} ${name === from.prefix ? 'default' : name.slice(from.prefix.length + 1)}` : ''}.`;
    }
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
  const describe = (account: Account, quota: Record<string, Quota>, now: number) =>
    `${kind(account)} · ${account.profile?.model ?? account.model} · ${summary(account, quota[account.name], now)}`;
  const panel = (result?: string) => {
    const { accounts, current, pending } = saved();
    const { quota } = quotas();
    const now = Date.now();
    const items: TerminalPanelItem[] = [
      ...accounts.map(account => ({ id: `use:${account.name}`, kind: 'action' as const,
        label: `${account.name === (pending ?? current) ? '●' : '○'} ${account.name}${account.available ? '' : ' (unavailable)'}`,
        description: describe(account, quota, now) })),
      { id: 'add', kind: 'action', label: '+ Add an account…', description: 'ChatGPT, Claude or Cursor account, OpenAI or Anthropic API key, or another provider' },
      ...owned(accounts).length > 1 ? [{ id: 'remove', kind: 'action' as const, label: 'Remove a profile…', description: 'Drops its route and, if unused, its sign-in' }] : [],
    ];
    const shown = api.host.tryCall('terminal.panel', { title: 'Profiles', subtitle: result ? fit(result, 200) : 'Enter switches this thread at its next turn · Alt+s cycles', items, action: PANEL });
    return shown.ok ? null : { display: `Profiles: ${shown.error}` };
  };

  api.command('profile', value => {
    const [op = '', label = '', extra = '', url = ''] = String(value ?? '').trim().split(/\s+/);
    const { accounts, current, pending, notice } = saved();
    const named = (name: string) => accounts.find(item => item.name === name);
    if (!op) return panel();
    if (op === 'panel') {
      const [action, target = ''] = label.split(':');
      if (!action) return panel();
      const display = action === 'use' ? use(named(target), target)
        : action === 'add' ? begin(target)
        : action === 'remove' ? (() => {
          const picked = choose('Remove a profile', 'Pick one', owned(accounts).filter(item => item.name !== (pending ?? current)).map(item => [item.name, item.name]));
          return picked ? remove(picked) : 'Cancelled.';
        })() : USAGE;
      return panel(display);
    }
    if (op === 'list') {
      if (!accounts.length) return { display: 'No profiles yet. Add one with /profile add.' };
      const { quota } = quotas();
      return { display: [...notice ? [`Last switch failed: ${notice}`] : [], ...accounts.map(account =>
        `${account.name === (pending ?? current) ? '●' : '○'} ${account.name} · ${describe(account, quota, Date.now())}${account.available ? '' : ' · unavailable'}`)].join('\n') };
    }
    if (op === 'next') {
      const ready = accounts.filter(account => account.available);
      if (ready.length < 2) return { display: 'No other profile to switch to. Add one with /profile.' };
      const index = ready.findIndex(account => account.name === (pending ?? current));
      return { display: use(ready[(index + 1) % ready.length], '') };
    }
    if (op === 'use') return { display: use(named(label), label) };
    if (op === 'add') return { display: begin(label, extra, url) };
    if (op === 'remove' && label) return { display: remove(label) };
    if (op === 'refresh' && label) {
      const credentials = api.host.tryCall('credentials.list', null);
      const credential = (credentials.ok ? credentials.value : []).find(item => item.label === label || item.id === label);
      if (!credential) return { display: `Unknown credential ${label}` };
      const done = api.host.tryCall('credentials.request', { action: 'refresh', profile: credential.id });
      return { display: done.ok ? `Refresh ${done.value.status} for ${credential.label}.` : done.error };
    }
    return { display: USAGE };
  }, { description: 'Switch between ChatGPT, API-key, provider, Claude and Cursor accounts, and add or remove profiles; switching applies at this thread\'s next turn' });
}
