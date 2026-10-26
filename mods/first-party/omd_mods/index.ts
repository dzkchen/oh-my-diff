import type { Json, ModAPI, PackageCatalogEntry, PackageRequest, PackageState, TerminalComponent, TerminalIdentity, TerminalPanel, TerminalPanelItem, TerminalPatch } from '../../api.d.ts';

type Review = { request: PackageRequest; label: string; changes: Json; grants: string[]; from: string; generation: number };
type Scope = 'user' | 'project';
const FIELDS = ['id', 'scope', 'description', 'installed', 'enabled', 'required', 'effective', 'pending', 'failed', 'blocked', 'compatible', 'conflicts'] as const;
type Listed = Pick<PackageState, typeof FIELDS[number]>;
type Saved = { generation: number; packages: Listed[]; reloadError: string | null; review: Review | null; notice: string | null;
  catalog: PackageCatalogEntry[]; catalogError: string | null; scope: Scope };
type Remembered = { onboarded?: boolean; selected?: string; query?: string };
type Property = { type?: string; enum?: Json[]; default?: Json; title?: string; description?: string; choices?: 'routes' };
const EMPTY: Saved = { generation: 0, packages: [], reloadError: null, review: null, notice: null, catalog: [], catalogError: null, scope: 'user' };
const LIST = 'mods';
const SELF = 'omd_mods';
const UNSET = '-';
const kept = (item: Pick<PackageState, 'id' | 'required'>) => item.id === SELF || item.required;
const labelOf = (name: string, property?: Property) => property?.title ?? name.replace(/_/g, ' ');
const word = (value: string) => /^\S{1,128}$/.test(value);
const numeric = new Intl.Collator(undefined, { numeric: true }).compare;
const newer = (version: string, than: string) => {
  const [core, pre = ''] = version.split(/-(.*)/s), [base, basePre = ''] = than.split(/-(.*)/s);
  return (numeric(core, base) || (!pre === !basePre ? numeric(pre, basePre) : pre ? -1 : 1)) > 0;
};
const ACRONYMS = new Set(['cli', 'lsp', 'api', 'mcp', 'ui']);
const REVIEWED = ['update', 'remove', 'rollback', 'trust'];
const SHOWN = 98;
const CATALOG = 120;
const TABS = [{ id: 'installed', title: 'All' }, { id: 'settings', title: 'Settings' }, { id: 'directory', title: 'Directory' }];
const GROUPS = ['Needs attention', 'On', 'Off'];

export default function activate(api: ModAPI) {
  const compare = new Intl.Collator().compare;
  const encoder = new TextEncoder();
  const saved = (): Saved => ({ ...EMPTY, ...(api.uiState.get() as Partial<Saved> | null ?? {}) });
  const remembered = (): Remembered => (api.state.get() as Remembered | null) ?? {};
  const onboarded = () => remembered().onboarded ?? false;
  const visible = (value: string, limit = 400) => [...value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')].slice(0, limit).join('');
  const clip = (value: string, bytes: number) => { const text = visible(value, bytes); return text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes)).read); };
  const key = (item: Pick<PackageState, 'id' | 'scope'>) => `${item.scope}:${item.id}`;
  const friendly = (id: string) => id.replace(/^omd_/, '').split('_').filter(Boolean).map(word => ACRONYMS.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(' ') || id;
  const properties = (item: Pick<PackageState, 'settings_schema'>) => Object.entries(((item.settings_schema as { properties?: Record<string, Property> } | null)?.properties) ?? {});
  const matches = (argument: string) => (item: Pick<PackageState, 'id' | 'scope' | 'installed'>) => item.installed && (key(item) === argument || item.id === argument);
  const describe = (argument: string): PackageState | null => {
    if (!argument) return null;
    const listed = api.host.tryCall('packages.list', null);
    return listed.ok ? listed.value.packages.find(matches(argument)) ?? null : null;
  };
  const refresh = (state: Saved, notice: string | null): Saved => {
    const listed = api.host.tryCall('packages.list', { fields: [...FIELDS] });
    if (!listed.ok) return { ...state, packages: [], notice: `The mod list is unavailable (${listed.error})` };
    const packages = ordered(listed.value.packages.map(entry => Object.fromEntries(FIELDS.map(field => [field, entry[field]])) as Listed));
    return { ...state, packages, generation: listed.value.generation, reloadError: listed.value.reload_error, notice };
  };
  const ordered = (packages: Listed[]) => packages.sort((a, b) => Number(!a.failed) - Number(!b.failed) || compare(friendly(a.id), friendly(b.id)) || compare(a.scope, b.scope));
  const search = (state: Saved): Saved => {
    const trimmed = (entry: PackageCatalogEntry): PackageCatalogEntry => ({ ...entry, description: clip(entry.description, 120), versions: entry.versions.filter(item => !item.blocked).slice(0, 1) });
    const catalog: PackageCatalogEntry[] = [];
    let cursor: string | undefined;
    do {
      const found = api.host.tryCall('packages.index', { limit: Math.min(50, CATALOG - catalog.length), ...cursor && { cursor } });
      if (!found.ok) return { ...state, catalog: [], catalogError: found.error };
      catalog.push(...found.value.packages.map(trimmed));
      cursor = found.value.cursor ?? undefined;
    } while (cursor && catalog.length < CATALOG);
    return { ...state, catalog, catalogError: null };
  };
  // A successful change reloads mods, which refuses this callback's later panel calls; the host then reruns every open panel's action.
  const apply = (state: Saved, request: PackageRequest, label: string, generation = state.generation): Saved | null => {
    const result = api.host.tryCall('packages.apply', { ...request, expected_generation: generation });
    if (!result.ok || result.value.status === 'declined') return refresh({ ...state, review: null }, result.ok ? `${label} was declined` : `${label} failed: ${result.error}`);
    const name = friendly(request.id ?? '');
    store({ ...state, review: null, notice: request.action === 'enable' ? `${name} is on. Its commands work now; the rest starts with your next message.`
      : request.action === 'disable' ? `${name} is off from your next message.`
        : `${label} ${request.action === 'install' ? 'installed and off; turn it on to use it' : 'done; it applies from your next message'}` });
    return null;
  };
  const review = (state: Saved, request: PackageRequest, label: string, from: string): Saved => {
    const result = api.host.tryCall('packages.preview', { ...request, expected_generation: state.generation });
    if (result.ok && request.action === 'install' && result.value.id === SELF) return { ...state, review: null, notice: 'Mods is already running; update it from its own panel' };
    return result.ok
      ? { ...state, review: { request: { ...request, id: result.value.id }, label, changes: result.value.changes, grants: result.value.grants_added, from, generation: state.generation }, notice: null }
      : { ...state, review: null, notice: `${label} is unavailable (${result.error})` };
  };
  const newest = (entry: PackageCatalogEntry | undefined) => entry?.versions.find(item => !item.blocked)?.version ?? '';
  const find = (state: Saved, argument: string) => state.packages.find(matches(argument));
  const write = (state: Saved, item: PackageState | undefined, argument: string): Saved | null => {
    const [name = '', ...rest] = argument.split(' ');
    const property = item && properties(item).find(([entry]) => entry === name)?.[1];
    if (!item || !property) return { ...state, notice: 'That setting is unavailable' };
    const text = property.choices === 'routes' && rest.join(' ') === UNSET ? '' : rest.join(' ');
    const value: Json = property.type === 'boolean' ? text === 'true' : property.type === 'number' ? Number(text) : text;
    if (property.type === 'number' && (!text.trim() || !Number.isFinite(value))) return { ...state, notice: `${name} needs a number` };
    const written = api.host.tryCall('settings.write', { id: item.id, values: { [name]: value } });
    if (!written.ok) return refresh(state, `${name} was not saved (${written.error})`);
    store({ ...state, notice: `${labelOf(name, property)} saved` });
    return null;
  };
  const act = (state: Saved, verb: string, argument: string, from = LIST, item?: PackageState): Saved | null => {
    if (verb === 'cancel') return { ...state, review: null, notice: null };
    if (verb === 'apply') return state.review ? apply(state, state.review.request, state.review.label, state.review.generation) : { ...state, notice: 'Nothing to apply' };
    if (verb === 'set') return write(state, item, argument);
    if (verb === 'route' && item) {
      const added = api.host.tryCall('routes.add', { mod: item.id });
      if (!added.ok || 'status' in added.value) return { ...state, notice: added.ok ? 'No helper model was added' : `No helper model was added (${brief(added.error)})` };
      // An unchanged setting isn't written, so no reload reruns the panel to show write's notice.
      if (item.settings?.[argument] === added.value.route)
        return { ...state, notice: `${labelOf(argument, properties(item).find(([name]) => name === argument)?.[1])} already uses ${added.value.route}` };
      return write(state, item, `${argument} ${added.value.route}`);
    }
    if (verb === 'scope') return argument === 'user' || argument === 'project' ? { ...state, scope: argument } : state;
    if (verb === 'directory') return search(state);
    if (verb === 'get') {
      const entry = state.catalog.find(item => item.id === argument);
      const version = newest(entry);
      if (entry?.installed) return { ...state, notice: `${friendly(entry.id)} is already installed; update it from its own panel` };
      return entry && version ? review(state, { action: 'install', reference: `${entry.id}@${version}`, scope: state.scope }, `Install ${friendly(entry.id)} ${version} (${state.scope})`, from)
        : { ...state, notice: 'That directory mod has no available version' };
    }
    if (verb === 'install') return argument ? review(state, { action: 'install', reference: argument, scope: state.scope }, `Install ${argument} (${state.scope})`, from)
      : { ...state, notice: 'Enter npm:NAME@VERSION, git+URL#TAG, a folder path or a directory id' };
    if (verb === 'reload') {
      const result = api.host.tryCall('packages.reload', null);
      return refresh(state, !result.ok ? `Reload failed: ${result.error}` : `Every mod reloads from your next message${result.value.failed.length ? `; failing now: ${result.value.failed.map(friendly).join(', ')}` : ''}`);
    }
    const target = find(state, argument);
    if (!target) return { ...state, notice: `No installed mod ${argument || 'selected'}` };
    if (kept(target) && (verb === 'disable' || verb === 'remove' || (verb === 'toggle' && target.enabled)))
      return { ...state, notice: `${friendly(target.id)} stays on because Oh My Diff needs it; turn it off from a shell with omd mods disable ${target.id}` };
    const request = { id: target.id, scope: target.scope };
    if (verb === 'toggle') return apply(state, { action: target.enabled ? 'disable' : 'enable', ...request }, `${target.enabled ? 'Turning off' : 'Turning on'} ${friendly(target.id)}`);
    if (verb === 'enable' || verb === 'disable') return apply(state, { action: verb, ...request }, `${verb === 'enable' ? 'Turning on' : 'Turning off'} ${friendly(target.id)}`);
    if (REVIEWED.includes(verb)) return review(state, { action: verb as PackageRequest['action'], ...request }, `${verb} ${friendly(target.id)}`, from);
    return { ...state, notice: `Unknown action ${verb}` };
  };
  const version = (change: Json) => {
    const { id = '', version: range, integrity } = change as { id?: string; version?: string | { from: string | null; to: string }; integrity?: { from: string | null; to: string } };
    if (typeof range !== 'object') return `${id} ${range ?? ''}`;
    return range.from === range.to && integrity ? `${id} source ${(integrity.from ?? 'none').slice(0, 8)} → ${integrity.to.slice(0, 8)}` : `${id} ${range.from ?? 'new'} → ${range.to}`;
  };
  const brief = (error: string) => error.split('\n').map(part => part.trim()).filter(Boolean).slice(0, 2).join(' ');
  const changed = (changes: Json) => {
    const plan = changes as { packages?: Json[]; removed?: Json[]; version?: Json };
    return plan.packages ? plan.packages.map(version).join(', ') : plan.removed ? `remove ${plan.removed.map(version).join(', ')}` : plan.version ? `roll back ${version(plan).trim()}` : 'no package changes';
  };
  const configured = (changes: Json) => {
    const plan = changes as { codex_config?: Record<string, Json> | null; packages?: { authority?: { to?: { codex_config?: Record<string, Json> } } }[] };
    return [...new Set([...Object.keys(plan.codex_config ?? {}), ...(plan.packages ?? []).flatMap(item => Object.keys(item.authority?.to?.codex_config ?? {}))])];
  };
  const reviewText = (review: Review) => {
    const config = configured(review.changes);
    return `${review.label}: ${changed(review.changes)} · new permissions: ${review.grants.join(', ') || 'none'}${config.length ? ` · Codex config: ${config.join(', ')}` : ''}`;
  };
  const attention = (item: Listed) => Boolean(item.failed || item.blocked || !item.compatible || item.conflicts.length);
  const group = (item: Listed) => attention(item) ? GROUPS[0] : item.enabled ? GROUPS[1] : GROUPS[2];
  const commands = (): Map<string, string[]> => {
    const listed = api.host.tryCall('commands.list', null);
    const owned = new Map<string, string[]>();
    for (const row of listed.ok ? listed.value.commands : []) if (row.owner && !row.hidden) owned.set(row.owner, [...owned.get(row.owner) ?? [], `/${row.command}`]);
    return owned;
  };
  const status = (item: Listed) =>
    !item.installed ? 'removed' : item.blocked ? 'quarantined' : item.failed ? 'failed' : item.pending ? item.effective ? 'stopping' : 'starting'
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
    const toggles = [...shown].sort((a, b) => GROUPS.indexOf(group(a)) - GROUPS.indexOf(group(b))).map(item => {
      const word = status(item);
      const extra = word === 'on' || word === 'off' ? null : word;
      const fixed = kept(item) && item.enabled;
      const names = owned.get(item.id) ?? [];
      return entry({ id: key(item), tab: 'installed', group: group(item), label: friendly(item.id), ...fixed ? { kind: 'action' } : { kind: 'toggle', value: item.enabled },
        description: [fixed ? 'always on' : extra, item.scope === 'project' ? 'this project' : null, item.description].filter(Boolean).join(' · '),
        keywords: clip([item.id, ...names].join(' '), 256),
        detail: clip([`${word} · ${item.scope === 'project' ? 'this project' : 'every project'}`, names.length ? `Commands: ${names.join(' ')}` : 'No commands',
          item.failed && `Why it failed: ${brief(item.failed)}`, item.blocked && `Quarantined: ${item.blocked}`, !item.compatible && 'Needs a newer Oh My Diff',
          ...item.conflicts.map(conflict => `Conflict: ${conflict}`)].filter(Boolean).join(' · '), 512) });
    });
    const settings = shown.map(item => entry({ id: `open:${key(item)}`, tab: 'settings', label: `${friendly(item.id)} ›`, kind: 'action', description: item.description ?? undefined }));
    const sources: TerminalPanelItem[] = [
      entry({ id: 'scope', tab: 'directory', label: 'Install for', kind: 'choice', value: state.scope, options: [{ value: 'user', label: 'Me' }, { value: 'project', label: 'This project' }] }),
      entry({ id: 'source', tab: 'directory', label: 'Add from source', kind: 'text', description: 'npm:NAME@VERSION, git+URL#TAG, a folder path or a directory id' }),
      ...state.catalogError ? [entry({ id: 'directory', tab: 'directory', label: 'Directory unavailable, try again', kind: 'action', description: brief(state.catalogError) })] : [],
    ];
    const offered = state.catalog.flatMap(item => {
      const local = item.installed ? state.packages.find(other => other.id === item.id) : undefined;
      if (item.installed && (!local || !newer(newest(item), item.installed))) return [];
      return [entry(local ? { id: `update:${key(local)}`, tab: 'directory', kind: 'action', label: `${friendly(item.id)} ${item.installed} → ${newest(item)}`,
        description: `Update available · ${item.description}` }
        : { id: `get:${item.id}`, tab: 'installed', group: 'Available', kind: 'action', label: `${friendly(item.id)} ${item.latest}`, description: item.description,
          keywords: item.id, detail: `Not installed · Enter reviews installing it for ${state.scope === 'project' ? 'this project' : 'you'}` })];
    });
    const catalog = offered.slice(0, Math.max(0, 200 - toggles.length - settings.length - sources.length));
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
    if (property.type === 'boolean') return entry({ ...base, kind: 'toggle', value: current === true });
    const options = [...new Set((property.enum ?? []).map(value => String(value)).filter(value => word(value) && encoder.encode(value).length <= 128))].slice(0, 32);
    if (property.choices === 'routes') {
      const chosen = String(current ?? property.default ?? '') || UNSET;
      const missing = chosen !== UNSET && !options.includes(chosen) && word(chosen);
      return entry({ ...base, kind: 'choice', value: missing || options.includes(chosen) ? chosen : UNSET,
        description: options.length ? base.description : 'No helper model yet: use Add a helper model below',
        options: [{ value: UNSET, label: 'Not set' }, ...missing ? [{ value: chosen, label: `${chosen} (unavailable in this project)` }] : [], ...options.slice(0, 30).map(value => ({ value, label: value }))] });
    }
    if (options.length) return entry({ ...base, kind: 'choice', value: options.includes(String(current)) ? String(current) : options[0], options: options.map(value => ({ value, label: value })) });
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
  const details = (item: PackageState, state: Saved): TerminalPanel => {
    const args = `mod ${key(item)}`;
    if (state.review?.from === key(item)) return reviewing(title(item, state), state, args);
    const fixed = kept(item) && item.enabled;
    const actions = item.source !== 'selection' ? [['update', 'Update'], ['rollback', 'Roll back'], ...fixed ? [] : [['remove', 'Remove']]] : item.failed?.startsWith('source_changed') ? [['trust', 'Trust the edited source']] : [];
    return {
      title: title(item, state), action: { command: 'mods', args },
      subtitle: subtitle([`${status(item)} · ${item.version} · ${item.source === 'selection' ? 'local folder' : item.source}${item.compatible ? '' : ' · needs a newer Oh My Diff'}`, item.description,
        item.blocked && `Quarantined: ${item.blocked}. Lift it from a shell with omd mods unblock ${item.id}.`, item.failed && `Why it failed: ${brief(item.failed)}`, ...item.conflicts.map(conflict => `Conflict: ${conflict}`), state.notice]),
      items: [
        ...fixed ? [] : [entry({ id: 'enabled', label: 'On', kind: 'toggle', value: item.enabled })],
        ...properties(item).slice(0, 150).map(([name, property]) => settingItem(item, name, property)).filter((value): value is TerminalPanelItem => value !== null),
        ...properties(item).filter(([, property]) => property.choices === 'routes').slice(0, 8).map(([name, property]) => entry({ id: `route:${name}`, kind: 'action',
          label: `Add a helper model for ${labelOf(name, property)}`, description: 'Uses the model you are chatting with on your ChatGPT plan; asks before changing anything' })),
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
      if (target) return presenting(target, { ...scoped, review: null, notice: null });
      const next = !item ? { ...scoped, notice: current.notice }
        : item === 'apply' || item === 'cancel' || item === 'scope' || item === 'directory' ? act(scoped, item, text)
          : item === 'source' ? act(scoped, 'install', text)
            : item.startsWith('get:') ? act(scoped, 'get', item.slice(4))
              : act(scoped, text === 'true' ? 'enable' : 'disable', item);
      return next && show(listing(store(next)));
    }
    const target = describe(verb === 'mod' ? rest[0] ?? '' : rest.length ? '' : verb);
    if (verb === 'mod') {
      if (!target) return show(gone(rest[0] ?? '', store({ ...state, notice: current.notice })));
      const [, , item, text] = words(raw, 3);
      const id = key(target);
      const next = !item ? { ...state, notice: current.notice }
        : item === 'apply' || item === 'cancel' ? act(state, item, '', id, target)
          : item === 'enabled' ? act(state, text === 'true' ? 'enable' : 'disable', id, id, target)
            : item.startsWith('setting:') ? act(state, 'set', `${item.slice(8)} ${text}`, id, target)
              : item.startsWith('route:') ? act(state, 'route', item.slice(6), id, target)
                : item.startsWith('do:') ? act(state, item.slice(3), id, id, target) : { ...state, notice: `Unknown action ${item}` };
      return next && presenting(target, next);
    }
    if (target) return presenting(target, { ...state, review: null, notice: null });
    const next = act(state, verb, rest.join(' ')) ?? saved();
    store(next);
    return { display: [next.notice, next.review && `${reviewText(next.review)}\nRun /mods apply or /mods cancel`].filter(Boolean).join('\n') || 'No change' };
  }, { description: 'Browse and install mods, turn them on or off and change their settings' });

  const wrap = (text: string) => text.split(' ').reduce<string[]>((rows, word) => {
    const last = rows.length ? `${rows[rows.length - 1]} ${word}` : word;
    if (rows.length && last.length <= 56) rows[rows.length - 1] = last; else rows.push(word);
    return rows;
  }, []).slice(0, 2).join('\n');
  const welcome = (identity: TerminalIdentity | undefined): TerminalComponent[] => {
    const mods = identity?.mods;
    const counts = mods ? `${mods.active} of ${mods.installed} mods on${mods.failed ? `, ${mods.failed} failed` : ''}` : 'Mods are loading';
    const lines = identity?.install_profile === 'platform_only'
      ? ['Oh My Diff Core: the mod host without built-in task features', `${counts}. /mods turns mods on, /omd fixes a broken one.`, 'Write your own with omd-mod-author create DIR ID.']
      : ['Oh My Diff: most mods start off.', `${counts}. /mods turns more on, /omd fixes a broken one.`];
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
