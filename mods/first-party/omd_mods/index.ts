import type { Json, ModAPI, PackageRequest, PackageState, TerminalComponent, TerminalIdentity, TerminalListRow, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Review = { request: PackageRequest; label: string; changes: Json; grants: string[] };
type Saved = { open: boolean; generation: number; packages: PackageState[]; reloadError: string | null; details: string | null; filter: string; review: Review | null; notice: string | null; onboarded: boolean };
type Property = { type?: string; enum?: Json[] };
const EMPTY: Saved = { open: false, generation: 0, packages: [], reloadError: null, details: null, filter: '', review: null, notice: null, onboarded: false };
const REVIEWED = ['update', 'remove', 'rollback', 'trust'];
const HINT = '↑↓ move · space toggle · tab more · esc close';

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ ...EMPTY, ...(api.state.get() as Partial<Saved> | null ?? {}) });
  const visible = (value: string, limit = 400) => [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')].slice(0, limit).join('');
  const key = (item: PackageState) => `${item.scope}:${item.id}`;
  const friendly = (id: string) => id.replace(/^omd_/, '').split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ') || id;
  const properties = (item: PackageState) => Object.entries(((item.settings_schema as { properties?: Record<string, Property> } | null)?.properties) ?? {});
  const refresh = (state: Saved, notice: string | null): Saved => {
    const listed = api.host.tryCall('packages.list', null);
    if (!listed.ok) return { ...state, packages: [], notice: `The mod list is unavailable (${listed.error})` };
    const packages = [...listed.value.packages].sort((a, b) => friendly(a.id).localeCompare(friendly(b.id)) || a.scope.localeCompare(b.scope));
    return { ...state, packages, generation: listed.value.generation, reloadError: listed.value.reload_error, notice };
  };
  const apply = (state: Saved, request: PackageRequest, label: string): Saved => {
    const result = api.host.tryCall('packages.apply', { ...request, expected_generation: state.generation });
    const name = friendly(request.id ?? '');
    const done = request.action === 'install' ? 'installed and off; turn it on to use it'
      : request.action === 'enable' ? `${name} is on. Its commands work now; the rest starts with your next message.`
        : request.action === 'disable' ? `${name} is off from your next message.` : 'done; it applies from your next message';
    const notice = !result.ok ? `${label} failed: ${result.error}` : result.value.status === 'declined' ? `${label} was declined` : request.action === 'enable' || request.action === 'disable' ? done : `${label} ${done}`;
    return refresh({ ...state, review: null }, notice);
  };
  const review = (state: Saved, request: PackageRequest, label: string): Saved => {
    const result = api.host.tryCall('packages.preview', { ...request, expected_generation: state.generation });
    return result.ok
      ? { ...state, review: { request: { ...request, id: result.value.id }, label, changes: result.value.changes, grants: result.value.grants_added }, notice: null }
      : { ...state, review: null, notice: `${label} is unavailable (${result.error})` };
  };
  const find = (state: Saved, argument: string) => state.packages.find(item => item.installed && (key(item) === argument || item.id === argument));
  const write = (state: Saved, argument: string): Saved => {
    const [target = '', name = '', ...rest] = argument.split(' ');
    const item = find(state, target);
    const property = item && properties(item).find(([entry]) => entry === name)?.[1];
    if (!item || !property) return { ...state, notice: 'That setting is unavailable' };
    const text = rest.join(' ');
    const value: Json = property.type === 'boolean' ? text === 'true' : property.type === 'number' ? Number(text) : text;
    if (property.type === 'number' && !Number.isFinite(value)) return { ...state, notice: `${name} needs a number` };
    const written = api.host.tryCall('settings.write', { id: item.id, values: { [name]: value } });
    return refresh(state, written.ok ? `${friendly(item.id)}: ${name.replace(/_/g, ' ')} saved` : `${name} was not saved (${written.error})`);
  };
  const act = (state: Saved, verb: string, argument: string): Saved => {
    if (verb === 'details') return { ...state, details: find(state, argument) ? argument : null, notice: null };
    if (verb === 'back') return { ...state, details: null, notice: null };
    if (verb === 'filter') return { ...state, filter: visible(argument, 64).trim(), details: null };
    if (verb === 'cancel') return { ...state, review: null, notice: null };
    if (verb === 'apply') return state.review ? apply(state, state.review.request, state.review.label) : { ...state, notice: 'Nothing to apply' };
    if (verb === 'set') return write(state, argument);
    if (verb === 'install') return argument ? review(state, { action: 'install', source: { kind: 'local', path: argument } }, `Install ${argument}`) : { ...state, notice: 'Enter the folder of a mod to install' };
    if (verb === 'reload') {
      const result = api.host.tryCall('packages.reload', null);
      return refresh(state, !result.ok ? `Reload failed: ${result.error}` : `Every mod reloads from your next message${result.value.failed.length ? `; failing now: ${result.value.failed.map(friendly).join(', ')}` : ''}`);
    }
    if (!verb || argument.startsWith('group:')) return state;
    const target = find(state, argument);
    if (!target) return { ...state, notice: `No installed mod ${argument || 'selected'}` };
    const request = { id: target.id, scope: target.scope };
    if (verb === 'toggle') return apply(state, { action: target.enabled ? 'disable' : 'enable', ...request }, `${target.enabled ? 'Turning off' : 'Turning on'} ${friendly(target.id)}`);
    if (verb === 'enable' || verb === 'disable') return apply(state, { action: verb, ...request }, `${verb} ${friendly(target.id)}`);
    if (REVIEWED.includes(verb)) return review(state, { action: verb as PackageRequest['action'], ...request }, `${verb} ${friendly(target.id)}`);
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
  const reviewText = (review: Review) => `${review.label}: ${changed(review.changes)} · new permissions: ${review.grants.join(', ') || 'none'}`;
  api.command('mods', input => {
    const [verb = '', ...rest] = String(input ?? '').trim().split(/\s+/);
    const current = saved();
    if (verb === 'close') { api.state.set({ ...current, open: false, details: null, review: null, notice: null }); return null; }
    const state = ['details', 'back', 'filter', 'cancel', 'apply'].includes(verb) && current.packages.length ? current : refresh(current, null);
    const next = act(state, verb === 'open' ? '' : verb, rest.join(' '));
    const open = current.open || !verb || verb === 'open';
    api.state.set({ ...next, open });
    if (open) return null;
    return { display: next.review ? `${reviewText(next.review)}\nRun /mods apply or /mods cancel` : next.notice ?? 'No change' };
  }, { description: 'Turn mods on or off and change their settings' });
  api.on('component_event', event => {
    if (!event.component.startsWith('omd_mods_') || !event.events?.some(input => 'key' in input && input.key === 'Esc')) return;
    api.state.set({ ...saved(), open: false, details: null, review: null, notice: null });
  });

  // Dialog height counts text lines, so long text is wrapped here instead of by the renderer.
  const wrap = (text: string, lines = 6, width = 72) => visible(text, 2000).split(' ').reduce<string[]>((rows, word) => {
    const last = rows.length ? `${rows[rows.length - 1]} ${word}` : word;
    if (rows.length && last.length <= width) rows[rows.length - 1] = last; else rows.push(word);
    return rows;
  }, []).slice(0, lines).join('\n');
  const line = (id: string, label: string, text: string, tone: TerminalTone = 'normal', lines = 6, width = 72): TerminalComponent => ({ type: 'text', id: `omd_mods_${id}`, label, text: wrap(text, lines, width), tone });
  const button = (verb: string, text: string, value = ''): TerminalComponent => ({ type: 'button', id: `omd_mods_${verb}`, label: text, text, action: { command: 'omd_mods:mods', args: `${verb} ${value}`.trim() } });
  const status = (item: PackageState): [string, string, TerminalTone] =>
    !item.installed ? ['◇', 'removed', 'attention']
      : item.failed ? ['✕', 'failed', 'failure']
      : item.pending ? ['◇', item.effective ? 'stopping' : 'starting', 'attention']
      : item.effective ? ['◆', 'on', 'success']
      : item.enabled ? ['○', 'shadowed', 'muted']
      : ['○', 'off', 'muted'];
  const row = (item: PackageState): TerminalListRow => {
    const [mark, word, tone] = status(item);
    const name = friendly(item.id);
    return { value: key(item), label: visible(`${name}, ${word}`, 128), spans: [{ text: `${mark} `, tone }, { text: visible(name, 40), bold: true },
      { text: ` ${word}`, tone: 'muted' }, ...(item.description ? [{ text: `  ${visible(item.description, 60)}`, tone: 'muted' as const }] : [])] };
  };
  const section = (title: string, items: PackageState[]): TerminalListRow[] => items.length
    ? [{ value: `group:${title}`, label: title, spans: [{ text: `${title} ${items.length}`, tone: 'accent', bold: true }] }, ...items.map(row)] : [];
  const listing = (state: Saved): TerminalComponent[] => {
    const needle = state.filter.toLowerCase();
    const shown = state.packages.filter(item => !needle || `${friendly(item.id)} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(needle));
    const failed = shown.filter(item => item.failed);
    const on = shown.filter(item => !item.failed && item.enabled);
    const off = shown.filter(item => !item.failed && !item.enabled);
    const configurable = state.packages.filter(item => item.installed && properties(item).length);
    const rows = [...section('Failed', failed), ...section('On', on), ...section('Off', off)];
    return [
      rows.length ? { type: 'list', id: 'omd_mods_list', label: 'Mods', height: 12, rows, action: { command: 'omd_mods:mods', args: 'toggle' } }
        : line('empty', 'Mods', state.filter ? `No mod matches "${state.filter}"` : 'No mods are installed', 'muted'),
      { type: 'input', id: 'omd_mods_filter', label: 'Filter', value: state.filter, placeholder: 'type a name, Enter filters', action: { command: 'omd_mods:mods', args: 'filter' } },
      ...(configurable.length ? [{ type: 'select' as const, id: 'omd_mods_settings', label: 'Settings', value: key(configurable[0]),
        options: configurable.slice(0, 16).map(item => ({ value: key(item), label: friendly(item.id) })), action: { command: 'omd_mods:mods', args: 'details' } }] : []),
      { type: 'input', id: 'omd_mods_install', label: 'Install a mod folder', placeholder: '/absolute/path/to/mod', action: { command: 'omd_mods:mods', args: 'install' } },
    ];
  };
  const tag = (text: string) => {
    let hash = 2166136261;
    for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(36);
  };
  const control = (item: PackageState, name: string, property: Property): TerminalComponent => {
    const current = item.settings?.[name];
    const label = name.replace(/_/g, ' ');
    const action = { command: 'omd_mods:mods', args: `set ${key(item)} ${name}` };
    const id = `omd_mods_setting_${tag(`${key(item)} ${name}`)}`;
    if (property.type === 'boolean') return { type: 'select', id, label, value: String(current === true), options: [{ value: 'true', label: 'on' }, { value: 'false', label: 'off' }], action };
    if (property.enum?.length) return { type: 'select', id, label, value: String(current ?? property.enum[0]), options: property.enum.slice(0, 16).map(value => ({ value: String(value), label: String(value) })), action };
    if (property.type === 'string' || property.type === 'number') return { type: 'input', id, label, value: current === undefined || current === null ? '' : String(current), placeholder: property.type === 'number' ? 'a number, Enter saves' : 'Enter saves', action };
    return line(`setting_${name}`.slice(0, 40), label, `${label}: set with omd-mod settings from a shell`, 'muted', 1);
  };
  const details = (item: PackageState): TerminalComponent[] => {
    const [mark, word, tone] = status(item);
    return [
      { type: 'line', id: 'omd_mods_details_title', label: friendly(item.id), spans: [{ text: `${mark} `, tone }, { text: friendly(item.id), bold: true }, { text: ` ${word}`, tone: 'muted' }] },
      line('description', 'What it adds', item.description ?? 'No description', 'normal', 3),
      ...(item.failed ? [line('failed', 'Why it failed', brief(item.failed), 'failure', 2)] : []),
      ...item.conflicts.map((conflict, index) => line(`conflict_${index}`, 'Conflict', conflict, 'attention', 2)),
      button('toggle', item.enabled ? 'Turn off' : 'Turn on', key(item)),
      ...properties(item).slice(0, 16).map(([name, property]) => control(item, name, property)),
      ...(item.source !== 'selection' ? [button('update', 'Update', key(item)), button('rollback', 'Roll back', key(item)), button('remove', 'Remove', key(item))]
        : item.failed?.startsWith('source_changed') ? [button('trust', 'Trust the edited source', key(item))] : []),
      line('package', 'Package', `${item.id} ${item.version} · ${item.scope} · ${item.source === 'selection' ? 'local folder' : item.source}${item.compatible ? '' : ' · needs a newer Oh My Diff'}`, 'muted', 2),
      button('back', 'Back'),
    ];
  };
  const dialog = (state: Saved): TerminalComponent => {
    const on = state.packages.filter(item => item.effective).length;
    const installed = state.packages.filter(item => item.installed).length;
    const current = state.details ? state.packages.find(item => key(item) === state.details) : undefined;
    const children: TerminalComponent[] = [
      { type: 'line', id: 'omd_mods_header', label: 'Mods', spans: [{ text: 'Mods', bold: true, tone: 'accent' }, { text: `  ${on} of ${installed} on`, tone: 'muted' }] },
      ...(state.reloadError ? [line('reload_error', 'Rejected change', `The last change was rejected; your mods keep running as before. ${brief(state.reloadError)}`, 'failure', 3)] : []),
      ...(state.notice ? [line('notice', 'Result', state.notice, 'attention', 3)] : []),
      ...(state.review ? [line('review', 'Review', reviewText(state.review), 'accent', 3), button('apply', 'Apply'), button('cancel', 'Cancel')] : []),
      ...(current ? details(current) : listing(state)),
      line('hint', 'Keys', current ? '↑↓ move · enter changes · esc close' : HINT, 'muted', 1),
    ];
    return { type: 'dialog', id: 'omd_mods_dialog', label: 'Oh My Diff mods', title: current ? friendly(current.id) : 'Mods', children };
  };
  const welcome = (identity: TerminalIdentity | undefined): TerminalComponent[] => {
    const mods = identity?.mods;
    const counts = mods ? `${mods.active} of ${mods.installed} mods on${mods.failed ? `, ${mods.failed} failed` : ''}` : 'Mods are loading';
    const lines = identity?.install_profile === 'platform_only'
      ? ['Oh My Diff Core: the mod host without built-in task features', `${counts}. /mods turns mods on, /omd fixes a broken one.`, 'Write your own with omd-mod-author create DIR ID.']
      : ['Oh My Diff: most mods start off.', `${counts}. /mods turns more on, /omd fixes a broken one.`];
    return lines.map((text, index) => line(`welcome_${index}`, 'Getting started', text, index ? 'muted' : 'normal', 2, 56));
  };
  api.on('terminal', (input): TerminalPatch | null => {
    let state = saved();
    const phase = input.presentation?.phase;
    if (input.event === 'startup' && state.open) api.state.set(state = { ...state, open: false, details: null, review: null, notice: null });
    if (!state.onboarded && phase && phase !== 'fresh') api.state.set({ ...state, onboarded: true });
    const intro = !state.onboarded && phase === 'fresh';
    if (!intro && !state.open) return null;
    return { sites: {
      ...(intro ? { welcome: { mode: 'wrap', components: [{ type: 'slot' }, ...welcome(input.identity)] } } : {}),
      ...(state.open ? { dialog: { mode: 'wrap', components: [{ type: 'slot' }, dialog(state)] } } : {}),
    } };
  });
}
