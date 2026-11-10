import type { Json, ModAPI, PackageCatalogEntry, PackageContributes, PackageRequest, PackageState, TerminalComponent, TerminalIdentity, TerminalPanel, TerminalPanelItem, TerminalPatch } from '../../api.d.ts';

type Review = { request: PackageRequest; label: string; changes: Json; grants: string[]; warning?: string; from: string; generation: number; lines?: string[] };
type Scope = 'user' | 'project';
const FIELDS = ['id', 'scope', 'description', 'installed', 'enabled', 'required', 'effective', 'pending', 'failed', 'needs_approval', 'blocked', 'compatible', 'conflicts'] as const;
type Listed = Pick<PackageState, typeof FIELDS[number]> & { own: boolean };
type Choice = { model: string; label: string; efforts: string[]; effort: string; window: number };
type Choosing = { from: string; name: string; models: Choice[]; lead: string | null };
type Saved = { generation: number; packages: Listed[]; reloadError: string | null; review: Review | null; notice: string | null;
  catalog: PackageCatalogEntry[]; catalogError: string | null; scope: Scope; choosing: Choosing | null; only: Record<string, boolean> };
type Remembered = { onboarded?: boolean; selected?: string; query?: string };
type Property = { type?: string; enum?: Json[]; default?: Json; title?: string; description?: string; choices?: 'routes' };
const EMPTY: Saved = { generation: 0, packages: [], reloadError: null, review: null, notice: null, catalog: [], catalogError: null, scope: 'user', choosing: null, only: {} };
const LIST = 'mods';
const SELF = 'omd_mods';
const UNSET = '-';
const kept = (item: Pick<PackageState, 'id' | 'required'>) => item.id === SELF || item.required;
const managed = (item: Pick<PackageState, 'scope'>) => item.scope === 'managed';
const copy = ({ scope }: Pick<PackageState, 'scope'>) => scope === 'managed' ? {} : { scope };
const owns = ({ overrides }: Pick<PackageState, 'overrides'>) => Boolean(overrides && (overrides.enabled !== undefined || Object.keys(overrides.settings).length));
const shown = (value: Json | undefined) => value === null || value === undefined ? 'not set' : typeof value === 'boolean' ? value ? 'on' : 'off' : typeof value === 'string' ? value : JSON.stringify(value);
const PLAIN: Record<string, string> = { configuration_override_forbidden: 'your administrator manages this mod', grant_expired: 'its permission expired; choose Trust again', settings_file_invalid: 'its settings file has a mistake; fix or delete the file, then try again' };
const labelOf = (name: string, property?: Property) => property?.title ?? name.replace(/_/g, ' ');
const word = (value: string) => /^\S{1,128}$/.test(value);
const strings = (value: Json | undefined) => Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value as string[] : null;
const SUPPORT: Record<string, string> = { experimental: 'Experimental', reviewed_candidate: 'Reviewed candidate' };
const compare = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};
const runs = (value: string) => value.match(/\d+|\D+/g) ?? [];
const numeric = (a: string, b: string) => {
  const [x, y] = [runs(a), runs(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const [p = '', q = ''] = [x[index], y[index]];
    const order = /^\d/.test(p) && /^\d/.test(q) ? Math.sign(Number(p) - Number(q)) : compare(p, q);
    if (order) return order;
  }
  return 0;
};
const newer = (version: string, than: string) => {
  const [core, pre = ''] = version.split(/-(.*)/s), [base, basePre = ''] = than.split(/-(.*)/s);
  return (numeric(core, base) || (!pre === !basePre ? numeric(pre, basePre) : pre ? -1 : 1)) > 0;
};
const ACRONYMS = new Set(['cli', 'lsp', 'api', 'mcp', 'ui']);
const REVIEWED = ['update', 'remove', 'rollback', 'trust'];
const SHOWN = 98;
const CATALOG = 120;
const MODELS = 24;
const INDEX_BYTES = 65_536;
const TABS = [{ id: 'installed', title: 'All' }, { id: 'settings', title: 'Settings' }, { id: 'directory', title: 'Directory' }];
const GROUPS = ['Needs attention', 'On', 'Off'];

export default function activate(api: ModAPI) {
  const encoder = new TextEncoder();
  const saved = (): Saved => ({ ...EMPTY, ...(api.uiState.get() as Partial<Saved> | null ?? {}) });
  const remembered = (): Remembered => (api.state.get() as Remembered | null) ?? {};
  const onboarded = () => remembered().onboarded ?? false;
  const visible = (value: string, limit = 400) => [...value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')].slice(0, limit).join('');
  const clip = (value: string, bytes: number) => { const text = visible(value, bytes); return text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes)).read); };
  const key = (item: Pick<PackageState, 'id' | 'scope'>) => `${item.scope}:${item.id}`;
  const scopeFlag = (item: Pick<PackageState, 'scope'>) => item.scope === 'project' ? ' --scope project' : '';
  const approval = (item: Pick<PackageState, 'id' | 'scope' | 'failed'>) => `${item.failed?.startsWith('grant_expired') ? 'Choose Trust again, or review' : 'Review'} it from a shell with omd mods update ${item.id}${scopeFlag(item)}`;
  const friendly = (id: string) => id.replace(/^omd_/, '').split('_').filter(Boolean).map(word => ACRONYMS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(' ') || id;
  const properties = (item: Pick<PackageState, 'settings_schema'>) => Object.entries(((item.settings_schema as { properties?: Record<string, Property> } | null)?.properties) ?? {});
  const matches = (argument: string) => (item: Pick<PackageState, 'id' | 'scope' | 'installed'>) => item.installed && (key(item) === argument || item.id === argument);
  const ambiguous = (packages: Pick<PackageState, 'id' | 'scope' | 'installed'>[], argument: string) =>
    packages.filter(matches(argument)).length > 1 ? `${argument} is installed for you and for this project; use user:${argument} or project:${argument}` : null;
  const describe = (argument: string): PackageState | null => {
    if (!argument) return null;
    const listed = api.host.tryCall('packages.list', null);
    return listed.ok && !ambiguous(listed.value.packages, argument) ? listed.value.packages.find(matches(argument)) ?? null : null;
  };
  const refresh = (state: Saved, notice: string | null): Saved => {
    const listed = api.host.tryCall('packages.list', { fields: [...FIELDS, 'overrides'] });
    if (!listed.ok) return { ...state, packages: [], notice: `The mod list is unavailable (${listed.error})` };
    const packages = ordered(listed.value.packages.map(entry => ({ ...Object.fromEntries(FIELDS.map(field => [field, entry[field]])), own: owns(entry) }) as Listed));
    return { ...state, packages, generation: listed.value.generation, reloadError: listed.value.reload_error, notice };
  };
  const ordered = (packages: Listed[]) => packages.sort((a, b) => Number(!a.failed) - Number(!b.failed) || compare(friendly(a.id), friendly(b.id)) || compare(a.scope, b.scope));
  const search = (state: Saved): Saved => {
    const trimmed = ({ id, latest, description, support, versions, installed }: PackageCatalogEntry): PackageCatalogEntry =>
      ({ id, latest, description: clip(description, 120), support: support && clip(support, 32), versions: versions.filter(item => !item.blocked).slice(0, 1), installed });
    const catalog: PackageCatalogEntry[] = [];
    let cursor: string | undefined, received = 0;
    do {
      const found = api.host.tryCall('packages.index', { limit: Math.min(50, CATALOG - catalog.length), ...cursor && { cursor } });
      if (!found.ok) return { ...state, catalog: [], catalogError: found.error };
      catalog.push(...found.value.packages.map(trimmed));
      received += encoder.encode(JSON.stringify(found.value)).length;
      cursor = found.value.cursor ?? undefined;
    } while (cursor && catalog.length < CATALOG && received < INDEX_BYTES);
    return { ...state, catalog, catalogError: null };
  };
  const apply = (state: Saved, request: PackageRequest, label: string, generation = state.generation): Saved | null => {
    const result = api.host.tryCall('packages.apply', { ...request, expected_generation: generation });
    if (!result.ok || result.value.status === 'declined') return refresh({ ...state, review: null }, result.ok ? `${label} was declined` : `${label} failed: ${plain(result.error)}`);
    const name = friendly(request.id ?? '');
    if (result.value.enabled === false) return refresh({ ...state, review: null }, `${label}: installed but still off (${plain(result.value.reason ?? 'unknown')})`);
    store({ ...state, review: null, notice: request.action === 'enable' || request.action === 'disable' ? `${name} is ${request.action === 'enable' ? 'on' : 'off'}${request.target === 'terminal' ? ' in this terminal until you close it' : ''}.`
      : request.action === 'reset' ? `${name} uses your saved settings again.` : request.action === 'save-defaults' ? `${name} keeps these choices in every terminal.`
        : `${label} ${request.action === 'install' ? request.enable ? 'done; it is on from your next message' : 'installed and off; turn it on to use it' : 'done; it applies from your next message'}` });
    return null;
  };
  const differences = (changes: Json, item?: PackageState) => {
    const { enabled, settings = [] } = changes as { enabled?: { before: boolean; after: boolean } | null; settings?: { key: string; before: Json; after: Json }[] };
    const schema = item ? properties(item) : [];
    return [...enabled ? [`On: ${shown(enabled.before)} → ${shown(enabled.after)}`] : [],
      ...settings.slice(0, 20).map(({ key, before, after }) => `${labelOf(key, schema.find(([name]) => name === key)?.[1])}: ${clip(shown(before), 60)} → ${clip(shown(after), 60)}`)];
  };
  const review = (state: Saved, request: PackageRequest, label: string, from: string, item?: PackageState): Saved => {
    const result = api.host.tryCall('packages.preview', { ...request, expected_generation: state.generation });
    if (result.ok && request.action === 'install' && result.value.id === SELF) return { ...state, review: null, notice: 'Mods is already running; update it from its own panel' };
    const lines = result.ok && (request.action === 'reset' || request.action === 'save-defaults') ? differences(result.value.changes, item) : undefined;
    if (lines && !lines.length) return { ...state, review: null, notice: 'Nothing to change' };
    return result.ok
      ? { ...state, review: { request: { ...request, id: result.value.id }, label, changes: result.value.changes, grants: result.value.grants_added, warning: result.value.identity_warning ?? undefined, from, generation: state.generation, lines }, notice: null }
      : { ...state, review: null, notice: `${label} is unavailable (${plain(result.error)})` };
  };
  const scoped = (state: Saved, item: Pick<PackageState, 'id' | 'scope'> & ({ own: boolean } | Pick<PackageState, 'overrides'>)) => state.only[key(item)] ?? ('own' in item ? item.own : owns(item)) ? { target: 'terminal' as const } : {};
  const newest = (entry: PackageCatalogEntry | undefined) => entry?.versions.find(item => !item.blocked)?.version ?? '';
  const find = (state: Saved, argument: string) => state.packages.find(matches(argument));
  const parse = (property: Property, text: string, current: Json | undefined): Json | undefined => {
    if (property.type === 'boolean') return text === 'true';
    if (property.type === 'number') return text.trim() && Number.isFinite(Number(text)) ? Number(text) : undefined;
    if (property.type === 'array' && !/^[[{]/.test(text.trim())) return text.split(',').map(part => part.trim()).filter(Boolean);
    if (property.type !== 'array' && property.type !== 'object') return text;
    try {
      const value = JSON.parse(text.trim() || (property.type === 'array' ? '[]' : '{}')) as Json;
      return typeof value === 'object' && value !== null && Array.isArray(value) === (property.type === 'array') ? value : undefined;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return undefined;
    }
  };
  const write = (state: Saved, item: PackageState | undefined, argument: string): Saved | null => {
    const [name = '', ...rest] = argument.split(' ');
    const property = item && properties(item).find(([entry]) => entry === name)?.[1];
    if (!item || !property) return { ...state, notice: 'That setting is unavailable' };
    const text = property.choices === 'routes' && rest.join(' ') === UNSET ? '' : rest.join(' ');
    const value = parse(property, text, item.settings?.[name]);
    const label = labelOf(name, property);
    if (value === undefined) return { ...state, notice: property.type === 'number' ? `Enter a number for ${label}, like 5` : `Enter JSON for ${label}, like ${property.type === 'array' ? '[]' : '{}'}` };
    const target = scoped(state, item);
    const written = api.host.tryCall('settings.write', { id: item.id, ...copy(item), values: { [name]: value }, ...target });
    if (!written.ok) return refresh(state, `${label} was not saved (${plain(written.error)})`);
    store({ ...state, notice: target.target ? `${label} set for this terminal until you close it.` : `${label} saved.` });
    return null;
  };
  const skips = (item: PackageState) => properties(item).some(([name, property]) => name === 'skip_same_model' && property.type === 'boolean'
    && (item.settings?.[name] ?? property.default) !== false);
  const add = (state: Saved, item: PackageState, name: string, choice: { model?: string; effort?: string }): Saved | null => {
    const added = api.host.tryCall('routes.add', { mod: item.id, ...choice });
    const back = { ...state, choosing: null };
    if (!added.ok || 'status' in added.value) return { ...back, notice: added.ok ? 'No helper model was added' : `No helper model was added (${brief(added.error)})` };
    if (item.settings?.[name] === added.value.route)
      return { ...back, notice: `${labelOf(name, properties(item).find(([entry]) => entry === name)?.[1])} already uses ${added.value.route}` };
    return write(back, item, `${name} ${added.value.route}`);
  };
  const choose = (state: Saved, item: PackageState, name: string): Saved => {
    const listed = api.host.tryCall('routes.models', { mod: item.id });
    if (!listed.ok) return { ...state, notice: `The model list is unavailable (${brief(listed.error)})` };
    const models = listed.value.flatMap(({ model, display_name, efforts, default_effort, context_window }): Choice[] => {
      const usable = efforts.filter(word).slice(0, 8);
      return word(model) && usable.length ? [{ model, label: clip(display_name || model, 64), efforts: usable, effort: default_effort, window: context_window }] : [];
    }).slice(0, MODELS);
    if (!models.length) return { ...state, notice: 'No ChatGPT models are available; sign in to Codex with ChatGPT first' };
    const info = api.host.tryCall('session.info', null);
    return { ...state, choosing: { from: key(item), name, models, lead: info.ok ? info.value.model : null }, notice: null };
  };
  const locked = (item: PackageState, state: Saved) => managed(item) ? 'Your administrator manages this mod' : item.effective ? null
    : state.packages.some(other => other.id === item.id && other.effective) ? `${item.scope === 'user' ? "This project's" : 'Your own'} copy is in use; change its settings there`
      : 'Turn it on to change its settings';
  const act = (state: Saved, verb: string, argument: string, from = LIST, item?: PackageState): Saved | null => {
    const refusal = item && ['set', 'route', 'choose', 'pick'].includes(verb) && locked(item, state);
    if (refusal) return { ...state, notice: refusal };
    if (verb === 'cancel') return { ...state, review: null, choosing: null, notice: null };
    if (verb === 'apply') return state.review ? apply(state, state.review.request, state.review.label, state.review.generation) : { ...state, notice: 'Nothing to apply' };
    if (verb === 'set') return write(state, item, argument);
    if (verb === 'route' && item) return add(state, item, argument, {});
    if (verb === 'choose' && item) return choose(state, item, argument);
    if (verb === 'pick' && item) {
      const [name = '', ...rest] = argument.split(':');
      const effort = rest.pop() ?? '';
      return add(state, item, name, { model: rest.join(':'), effort });
    }
    if (verb === 'scope') return argument === 'user' || argument === 'project' ? { ...state, scope: argument }
      : { ...state, notice: 'Enter /mods scope user or /mods scope project' };
    if (verb === 'directory') return search(state);
    if (verb === 'plugin') {
      const at = argument.indexOf('/');
      const [marketplace, plugin] = [argument.slice(0, at), argument.slice(at + 1)];
      return at > 0 && plugin ? review(state, { action: 'install', source: { kind: 'plugin', plugin, marketplace }, scope: state.scope, enable: true }, `Turn on the ${plugin} plugin's mod (${state.scope})`, from)
        : { ...state, notice: 'Enter /mods plugin MARKETPLACE/PLUGIN' };
    }
    if (verb === 'get') {
      const entry = state.catalog.find(item => item.id === argument);
      const version = newest(entry);
      if (entry?.installed || state.packages.some(item => item.id === argument && item.installed)) return { ...state, notice: `${friendly(argument)} is already installed; update it from its own panel` };
      return entry && version ? review(state, { action: 'install', reference: `${entry.id}@${version}`, scope: state.scope }, `Install ${friendly(entry.id)} ${version} (${state.scope})${entry.support && SUPPORT[entry.support] ? ` · ${SUPPORT[entry.support].toLowerCase()}` : ''}`, from)
        : { ...state, notice: 'That directory mod has no available version' };
    }
    if (verb === 'install') return argument ? review(state, { action: 'install', reference: argument, scope: state.scope }, `Install ${argument} (${state.scope})`, from)
      : { ...state, notice: 'Enter npm:NAME@VERSION, git+URL#TAG, a folder path or a directory id' };
    if (verb === 'reload') {
      const result = api.host.tryCall('packages.reload', null);
      return refresh(state, !result.ok ? `Reload failed: ${result.error}` : `Every mod reloads from your next message${result.value.failed.length ? `; failing now: ${result.value.failed.map(friendly).join(', ')}` : ''}`);
    }
    const unclear = ambiguous(state.packages, argument);
    if (unclear) return { ...state, notice: unclear };
    const target = find(state, argument);
    if (!target) return { ...state, notice: `No installed mod ${argument || 'selected'}` };
    if (kept(target) && (verb === 'disable' || verb === 'remove' || (verb === 'toggle' && target.enabled)))
      return { ...state, notice: `${friendly(target.id)} stays on because Oh My Diff needs it; turn it off from a shell with omd mods disable ${target.id}` };
    const request = { id: target.id, ...copy(target) };
    if (verb === 'toggle') return apply(state, { action: target.enabled ? 'disable' : 'enable', ...request, ...scoped(state, target) }, `${target.enabled ? 'Turning off' : 'Turning on'} ${friendly(target.id)}`);
    if (verb === 'reset' || verb === 'save-defaults') return review(state, { action: verb, ...request }, verb === 'reset' ? `Use saved settings for ${friendly(target.id)}` : `Keep ${friendly(target.id)}'s choices for every terminal`, from, item);
    if (verb === 'enable' || verb === 'disable') return apply(state, { action: verb, ...request, ...scoped(state, target) }, `${verb === 'enable' ? 'Turning on' : 'Turning off'} ${friendly(target.id)}`);
    if (REVIEWED.includes(verb)) return review(state, { action: verb as PackageRequest['action'], ...request }, `${verb} ${friendly(target.id)}`, from);
    return { ...state, notice: `Unknown action ${verb}` };
  };
  const version = (change: Json) => {
    const { id = '', version: range, integrity } = change as { id?: string; version?: string | { from: string | null; to: string }; integrity?: { from: string | null; to: string } };
    if (typeof range !== 'object') return `${id} ${range ?? ''}`;
    return range.from === range.to && integrity ? `${id} source ${(integrity.from ?? 'none').slice(0, 8)} → ${integrity.to.slice(0, 8)}` : `${id} ${range.from ?? 'new'} → ${range.to}`;
  };
  const brief = (error: string) => error.split('\n').map(part => part.trim()).filter(Boolean).slice(0, 2).join(' ');
  const plain = (error: string) => PLAIN[error.split(':')[0].trim()] ?? brief(error);
  const changed = (changes: Json) => {
    const plan = changes as { packages?: Json[]; removed?: Json[]; version?: Json };
    return plan.packages ? plan.packages.map(version).join(', ') : plan.removed ? `remove ${plan.removed.map(version).join(', ')}` : plan.version ? `roll back ${version(plan).trim()}` : 'no package changes';
  };
  const configured = (changes: Json) => {
    const plan = changes as { codex_config?: Record<string, Json> | null; packages?: { authority?: { to?: { codex_config?: Record<string, Json> } } }[] };
    return [...new Set([...Object.keys(plan.codex_config ?? {}), ...(plan.packages ?? []).flatMap(item => Object.keys(item.authority?.to?.codex_config ?? {}))])];
  };
  const reviewText = (review: Review) => {
    if (review.lines) return [review.label, ...review.lines, review.request.action === 'reset' ? 'This terminal goes back to your saved settings.' : 'Applies to every terminal and future launches.'].join('\n');
    const config = configured(review.changes);
    return `${review.warning ? `WARNING: ${review.warning} · ` : ''}${review.label}: ${changed(review.changes)} · new permissions: ${review.grants.join(', ') || 'none'}${config.length ? ` · Codex config: ${config.join(', ')}` : ''}`;
  };
  const attention = (item: Listed) => Boolean(item.failed || item.blocked || !item.compatible || item.conflicts.length);
  const group = (item: Listed) => attention(item) ? GROUPS[0] : item.enabled ? GROUPS[1] : GROUPS[2];
  const commands = (): Map<string, string[]> => {
    const listed = api.host.tryCall('commands.list', null);
    const owned = new Map<string, string[]>();
    for (const row of listed.ok ? listed.value.commands : []) if (row.owner && !row.hidden) owned.set(row.owner, [...owned.get(row.owner) ?? [], `/${row.command}`]);
    return owned;
  };
  const extras = (): Map<string, Pick<PackageState, 'maintainer' | 'contributes'>> => {
    const listed = api.host.tryCall('packages.list', { fields: ['id', 'scope', 'maintainer', 'contributes'] });
    return new Map(listed.ok ? listed.value.packages.map(item => [key(item), item]) : []);
  };
  const usage = (names: string[], contributes?: PackageContributes) => {
    const commands = names.length ? names : (contributes?.commands ?? []).map(command => `/${command.name}`);
    const keys = (contributes?.keys ?? []).map(binding => binding.key);
    return [commands.length > 0 && `Commands: ${commands.join(' ')}`, keys.length > 0 && `Keys: ${keys.join(' ')}`];
  };
  const supportOf = (state: Saved, id: string) => SUPPORT[state.catalog.find(entry => entry.id === id)?.support ?? ''];
  const status = (item: Omit<Listed, 'own'>) =>
    !item.installed ? 'removed' : item.blocked ? 'quarantined' : item.needs_approval ? 'needs approval' : item.failed ? 'failed' : item.pending ? item.effective ? 'stopping' : 'starting'
      : item.effective ? 'on' : item.enabled ? 'shadowed' : 'off';
  const subtitle = (lines: (string | null | undefined | false)[]) => clip(lines.filter(Boolean).join('\n'), 2000);
  const entry = (item: TerminalPanelItem): TerminalPanelItem => ({ ...item, label: clip(item.label, 128), description: item.description ? clip(item.description, 256) : undefined });
  const reviewing = (title: string, state: Saved, args: string): TerminalPanel => ({
    title, subtitle: subtitle([clip(reviewText(state.review!), 1200)]), action: { command: 'mods', args },
    items: [entry({ id: 'apply', label: 'Apply', kind: 'action', description: 'Make this change' }), entry({ id: 'cancel', label: 'Cancel', kind: 'action', description: 'Keep everything as it is' })],
  });
  const listing = (state: Saved): TerminalPanel => {
    if (state.review?.from === LIST) return reviewing('Mods', state, `panel ${state.scope}`);
    const installed = state.packages.filter(item => item.installed);
    const on = installed.filter(item => item.effective).length;
    const shown = installed.slice(0, SHOWN);
    const owned = commands();
    const more = extras();
    const toggles = [...shown].sort((a, b) => GROUPS.indexOf(group(a)) - GROUPS.indexOf(group(b))).map(item => {
      const word = status(item);
      const extra = word === 'on' || word === 'off' ? null : word;
      const fixed = kept(item) && item.enabled;
      const names = owned.get(item.id) ?? [];
      const declared = more.get(key(item));
      const flag = supportOf(state, item.id);
      return entry({ id: key(item), tab: 'installed', group: group(item), label: friendly(item.id), ...fixed ? { kind: 'action' } : { kind: 'toggle', value: item.enabled },
        description: [fixed ? 'always on' : extra, flag?.toLowerCase(), item.scope === 'project' ? 'this project' : null, item.own ? 'only this terminal' : null, item.description].filter(Boolean).join(' · '),
        keywords: clip([item.id, ...names, ...(declared?.contributes.commands ?? []).map(command => `/${command.name}`)].join(' '), 256),
        detail: clip([`${word} · ${item.scope === 'project' ? 'this project' : 'every project'}`, ...usage(names, declared?.contributes), declared?.maintainer && `By ${declared.maintainer}`,
          item.needs_approval ? approval(item) : item.failed && `Why it failed: ${brief(item.failed)}`, item.blocked && `Quarantined: ${item.blocked}`, !item.compatible && 'Needs a newer Oh My Diff',
          ...item.conflicts.map(conflict => `Conflict: ${conflict}`)].filter(Boolean).join(' · '), 512) });
    });
    const settings = shown.map(item => entry({ id: `open:${key(item)}`, tab: 'settings', label: `${friendly(item.id)} ›`, kind: 'action', description: 'Settings', keywords: item.id }));
    const sources: TerminalPanelItem[] = [
      entry({ id: 'scope', tab: 'directory', label: 'Install for', kind: 'choice', value: state.scope, options: [{ value: 'user', label: 'Me' }, { value: 'project', label: 'This project' }] }),
      entry({ id: 'source', tab: 'directory', label: 'Add from source', kind: 'text', description: 'npm:NAME@VERSION, git+URL#TAG, a folder path or a directory id' }),
      ...state.catalogError ? [entry({ id: 'directory', tab: 'directory', label: 'Directory unavailable, try again', kind: 'action', description: brief(state.catalogError) })] : [],
    ];
    const offered = state.catalog.flatMap(item => {
      const local = state.packages.find(other => other.id === item.id && other.installed);
      if (local && !(item.installed && newer(newest(item), item.installed))) return [];
      const flag = item.support ? SUPPORT[item.support] : undefined;
      return [entry(local ? { id: `update:${key(local)}`, tab: 'directory', kind: 'action', label: `${friendly(item.id)} ${item.installed} → ${newest(item)}`,
        description: `Update available · ${item.description}` }
        : { id: `get:${item.id}`, tab: 'installed', group: 'Available', kind: 'action', label: `${friendly(item.id)} ${item.latest}`, description: [flag, item.description].filter(Boolean).join(' · '),
          keywords: item.id, detail: `Not installed${flag ? ` · ${flag.toLowerCase()}` : ''} · Enter reviews installing it for ${state.scope === 'project' ? 'this project' : 'you'}` })];
    });
    const components = api.host.tryCall('plugins.components', null);
    const plugins = (components.ok ? components.value.components : []).filter(item => !item.installed).map(item => entry({
      id: `plugin:${item.marketplace}/${item.plugin}`, tab: 'installed', group: 'Available', kind: 'action', label: `${friendly(item.id ?? item.plugin)} (plugin)`,
      description: item.error ? `Can't be turned on: ${brief(item.error)}` : item.description ?? `The mod in the ${item.plugin} plugin`, keywords: `${item.plugin} ${item.id ?? ''}`,
      detail: item.error ? `Plugin ${item.plugin} ${item.version}` : `Plugin ${item.plugin} ${item.version} · Enter reviews turning its mod on` }))
      .filter(item => encoder.encode(item.id).length <= 128);
    const catalog = [...plugins, ...offered].slice(0, Math.max(0, 200 - toggles.length - settings.length - sources.length));
    const { selected, query } = remembered();
    return {
      title: 'Mods', subtitle: subtitle([`${on} of ${installed.length} on`, installed.length > SHOWN && `Showing ${SHOWN}; open another with /mods MOD`, state.reloadError && `The last change was rejected; your mods keep running as before. ${brief(state.reloadError)}`, state.notice]),
      tabs: TABS, search: true, action: { command: 'mods', args: `panel ${state.scope}` }, items: [...toggles, ...settings, ...sources, ...catalog],
      ...selected ? { selected } : {}, ...query ? { query } : {}, close_args: 'closed',
    };
  };
  const settingItem = (item: PackageState, name: string, property: Property): TerminalPanelItem | null => {
    const current = item.settings?.[name];
    const base = { id: `setting:${name}`, label: labelOf(name, property), description: property.description };
    if (/\s/.test(name) || encoder.encode(base.id).length > 128) return null;
    if (managed(item)) return entry({ ...base, kind: 'action', description: clip(shown(current), 256) });
    if (property.type === 'boolean') return entry({ ...base, kind: 'toggle', value: current === true });
    const options = [...new Set((property.enum ?? []).map(value => String(value)).filter(value => word(value) && encoder.encode(value).length <= 128))].slice(0, 32);
    if (property.choices === 'routes') {
      const chosen = String(current ?? property.default ?? '') || UNSET;
      const missing = chosen !== UNSET && !options.includes(chosen) && word(chosen);
      return entry({ ...base, kind: 'choice', value: missing || options.includes(chosen) ? chosen : UNSET,
        description: options.length ? base.description : 'No helper model yet: choose one below',
        options: [{ value: UNSET, label: 'Not set' }, ...missing ? [{ value: chosen, label: `${chosen} (unavailable in this project)` }] : [], ...options.slice(0, 30).map(value => ({ value, label: value }))] });
    }
    if (options.length) return entry({ ...base, kind: 'choice', value: options.includes(String(current)) ? String(current) : options[0], options: options.map(value => ({ value, label: value })) });
    if (property.type === 'array' || property.type === 'object') {
      const value = current ?? property.default ?? (property.type === 'array' ? [] : {});
      const list = property.type === 'array' ? strings(value) : null;
      const text = list ? list.join(', ') : JSON.stringify(value);
      return encoder.encode(text).length > 2000 ? entry({ ...base, kind: 'action', description: 'Too long to edit here' })
        : entry({ ...base, kind: 'text', value: text, description: [property.description, list ? 'Separate entries with commas, or enter a JSON list' : 'Enter JSON'].filter(Boolean).join('. ') });
    }
    if (property.type === 'string' || property.type === 'number') return entry({ ...base, kind: 'text', value: current === undefined || current === null ? '' : clip(String(current), 2000), description: property.description ?? (property.type === 'number' ? 'a number' : undefined) });
    return null;
  };
  const title = (item: Pick<PackageState, 'id' | 'scope'>, state: Saved) =>
    `${state.packages.some(other => other.id !== item.id && other.scope === item.scope && friendly(other.id) === friendly(item.id)) ? item.id : friendly(item.id)} (${item.scope})`;
  const gone = (argument: string, state: Saved): TerminalPanel => {
    const item = { id: argument.slice(argument.indexOf(':') + 1), scope: argument.slice(0, Math.max(0, argument.indexOf(':'))) as Scope };
    return { title: title(item, state), subtitle: subtitle([`${friendly(item.id)} is no longer installed`, state.notice]), action: { command: 'mods', args: `mod ${argument}` },
      items: [entry({ id: 'removed', label: 'Removed', kind: 'action', description: 'Esc returns to the list' })] };
  };
  const chooser = (item: PackageState, state: Saved, { name, models, lead }: Choosing): TerminalPanel => {
    const skipping = skips(item);
    const picks = models.flatMap(choice => choice.efforts.map(effort => ({ choice, effort, id: `pick:${name}:${choice.model}:${effort}` })))
      .filter(({ id }) => encoder.encode(id).length <= 128).slice(0, 190);
    return {
      title: `${title(item, state)}: ${labelOf(name, properties(item).find(([entry]) => entry === name)?.[1])}`, action: { command: 'mods', args: `mod ${key(item)}` },
      subtitle: subtitle(['Choose a ChatGPT model and effort. It adds a helper route on your ChatGPT plan for this mod and asks before changing anything.',
        skipping && `${friendly(item.id)} skips while it would run on the lead's model (skip_same_model is on)${lead ? `, so pick a model other than ${lead}` : ''}.`, state.notice]),
      items: [...picks.map(({ choice, effort, id }) => entry({ id, group: choice.label, kind: 'action', label: `${choice.label} · ${effort}${effort === choice.effort ? ' (default)' : ''}`,
        description: `${Math.round(choice.window / 1000)}K context${choice.model !== lead ? '' : skipping ? `; the lead's model: ${friendly(item.id)} would skip` : "; the lead's model"}` })),
      entry({ id: 'cancel', label: 'Back', kind: 'action', description: 'Keep the current setting' })],
    };
  };
  const details = (item: PackageState, state: Saved): TerminalPanel => {
    const args = `mod ${key(item)}`;
    if (state.review?.from === key(item)) return reviewing(title(item, state), state, args);
    if (state.choosing?.from === key(item)) return chooser(item, state, state.choosing);
    const fixed = kept(item) && item.enabled;
    const editable = !locked(item, state);
    const schema = properties(item);
    const own = owns(item);
    const flag = supportOf(state, item.id);
    const actions = [...item.source !== 'selection' ? [['update', 'Update'], ['rollback', 'Roll back'], ...fixed ? [] : [['remove', 'Remove']]] : item.failed?.startsWith('source_changed') ? [['trust', 'Trust the edited source']] : [],
      ...item.failed?.startsWith('grant_expired') ? [['trust', 'Trust again']] : []];
    return {
      title: title(item, state), action: { command: 'mods', args },
      subtitle: subtitle([[status(item), item.version, item.source === 'selection' ? 'local folder' : item.source, flag?.toLowerCase(), item.maintainer && `by ${item.maintainer}`, !item.compatible && 'needs a newer Oh My Diff'].filter(Boolean).join(' · '), item.description,
        item.effective ? null : usage([], item.contributes).filter(Boolean).join(' · '),
        own && 'This terminal has its own choices',
        item.blocked && `Quarantined: ${item.blocked}. Lift it from a shell with omd mods unblock ${item.id}${scopeFlag(item)}.`,
        item.needs_approval ? `${approval(item)}.` : item.failed && `Why it failed: ${brief(item.failed)}`, ...item.conflicts.map(conflict => `Conflict: ${conflict}`), schema.length ? locked(item, state) : null, state.notice]),
      items: [
        ...fixed ? [] : [entry({ id: 'enabled', label: 'On', kind: 'toggle', value: item.enabled })],
        ...!editable && !managed(item) ? [] : schema.slice(0, 150).map(([name, property]) => settingItem(item, name, property)).filter((value): value is TerminalPanelItem => value !== null),
        ...!editable ? [] : schema.filter(([, property]) => property.choices === 'routes').slice(0, 8).flatMap(([name, property]) => [
          entry({ id: `choose:${name}`, kind: 'action', label: `Choose a model for ${labelOf(name, property)}`,
            description: 'Pick a ChatGPT model and effort on your plan; asks before changing anything' }),
          entry({ id: `route:${name}`, kind: 'action', label: `Add a helper model for ${labelOf(name, property)}`,
            description: `Uses the model you are chatting with on your ChatGPT plan; asks before changing anything${skips(item) ? `. ${friendly(item.id)} skips it while skip_same_model is on` : ''}` })]),
        ...managed(item) || (fixed && !(editable && schema.length)) ? [] : [entry({ id: 'target', label: 'Changes apply to', kind: 'choice', value: scoped(state, item).target ?? 'shared',
          options: [{ value: 'shared', label: 'Every terminal' }, { value: 'terminal', label: 'Only this terminal' }] })],
        ...!own ? [] : [entry({ id: 'do:reset', label: 'Use saved settings', kind: 'action', description: 'Drop the choices made only for this terminal' }), entry({ id: 'do:save-defaults', label: 'Keep these for every terminal', kind: 'action', description: 'Every terminal and future launches use them' })],
        ...actions.map(([verb, label]) => entry({ id: `do:${verb}`, label, kind: 'action' })),
      ],
    };
  };
  const show = (panel: TerminalPanel) => {
    const shown = api.host.tryCall('terminal.panel', panel);
    return shown.ok ? null : { display: `/mods is unavailable: ${shown.error}` };
  };
  const store = (state: Saved) => { api.uiState.set(state as unknown as Json); return state; };
  const presenting = (target: PackageState, state: Saved) => show(details(target, store(state)));

  const words = (input: string, count: number) => {
    let rest = input.trimStart();
    const out: string[] = [];
    while (out.length < count) {
      const at = rest.search(/\s/);
      out.push(at < 0 ? rest : rest.slice(0, at));
      rest = at < 0 ? '' : rest.slice(at + 1);
    }
    return [...out, rest];
  };

  api.command('mods', input => {
    const raw = String(input ?? '');
    const [verb = '', ...rest] = raw.trim().split(/\s+/);
    if (verb === 'closed') {
      const [, selected, query] = words(raw, 2);
      api.state.set({ ...remembered(), selected: selected === UNSET ? undefined : selected, query: clip(query, 128) || undefined } as Json);
      return null;
    }
    const current = saved();
    if (!verb || verb === 'open') return show(listing(store(search(refresh({ ...current, review: null }, null)))));
    const lost = api.uiState.get() === null;
    const state = refresh(current, null);
    if (verb === 'panel') {
      const [, scope, item, text] = words(raw, 3);
      const scoped: Saved = { ...lost || !item ? search(state) : state, scope: scope === 'project' ? 'project' : 'user' };
      const target = /^(open|update):/.test(item) ? describe(item.slice(item.indexOf(':') + 1)) : null;
      if (target) return presenting(target, { ...scoped, review: null, choosing: null, notice: null });
      const next = !item ? { ...scoped, notice: current.notice }
        : item === 'apply' || item === 'cancel' || item === 'scope' || item === 'directory' ? act(scoped, item, text)
          : item === 'source' ? act(scoped, 'install', text)
            : item.startsWith('get:') ? act(scoped, 'get', item.slice(4))
              : item.startsWith('plugin:') ? act(scoped, 'plugin', item.slice(7))
              : act(scoped, text === 'true' ? 'enable' : 'disable', item);
      return next && show(listing(store(next)));
    }
    const target = describe(verb === 'mod' ? rest[0] ?? '' : rest.length ? '' : verb);
    if (verb === 'mod') {
      const unclear = !target && ambiguous(state.packages, rest[0] ?? '');
      if (unclear) return { display: unclear };
      if (!target) return show(gone(rest[0] ?? '', store({ ...state, notice: current.notice })));
      const [, , item, text] = words(raw, 3);
      const id = key(target);
      const next = !item ? { ...state, notice: current.notice }
        : item === 'apply' || item === 'cancel' ? act(state, item, '', id, target)
          : item === 'target' ? { ...state, only: { ...state.only, [id]: text === 'terminal' }, notice: null }
          : item === 'enabled' ? act(state, text === 'true' ? 'enable' : 'disable', id, id, target)
            : item.startsWith('setting:') ? act(state, 'set', `${item.slice(8)} ${text}`, id, target)
              : item.startsWith('route:') ? act(state, 'route', item.slice(6), id, target)
                : item.startsWith('choose:') ? act(state, 'choose', item.slice(7), id, target)
                  : item.startsWith('pick:') ? act(state, 'pick', item.slice(5), id, target)
                    : item.startsWith('do:') ? act(state, item.slice(3), id, id, target) : { ...state, notice: `Unknown action ${item}` };
      return next && presenting(target, next);
    }
    if (target) return presenting(target, { ...state, review: null, choosing: null, notice: null });
    const unclear = !rest.length && ambiguous(state.packages, verb);
    if (unclear) return { display: unclear };
    const next = act(state, verb, rest.join(' ')) ?? saved();
    store(next);
    const fallback = verb === 'cancel' ? state.review || state.choosing ? 'Cancelled' : 'Nothing to cancel'
      : verb === 'scope' ? `Installs go to ${next.scope === 'project' ? 'this project' : 'your user store'}` : 'No change';
    return { display: [next.notice, next.review && `${reviewText(next.review)}\nRun /mods apply or /mods cancel`].filter(Boolean).join('\n') || fallback };
  }, { description: 'Browse and install mods, turn them on or off and change their settings' });

  const wrap = (text: string) => text.split(' ').reduce<string[]>((rows, word) => {
    const last = rows.length ? `${rows[rows.length - 1]} ${word}` : word;
    if (rows.length && last.length <= 56) rows[rows.length - 1] = last; else rows.push(word);
    return rows;
  }, []).slice(0, 2).join('\n');
  const welcome = (identity: TerminalIdentity | undefined): TerminalComponent[] => {
    const lines = identity?.install_profile === 'platform_only'
      ? ['Oh My Diff Core: the mod host without built-in task features', '/mods turns mods on, /omd fixes a broken one.', 'Write your own with omd-mod-author create DIR ID.']
      : ['Oh My Diff', '/mods turns more on, /omd fixes a broken one.', 'Auto-continue (off) answers unattended prompts: omd mods enable omd_auto_continue'];
    return lines.map((text, index) => ({ type: 'text', id: `omd_mods_welcome_${index}`, label: 'Getting started', text: wrap(text), tone: index ? 'muted' : 'normal' }));
  };
  api.on('terminal', (input): TerminalPatch | null => {
    const phase = input.presentation?.phase;
    const done = onboarded();
    if (!done && phase && phase !== 'fresh') api.state.set({ ...remembered(), onboarded: true } as Json);
    if (done || phase !== 'fresh') return null;
    return { sites: { welcome: { mode: 'wrap', components: [{ type: 'slot' }, ...welcome(input.identity)] } } };
  });
}
