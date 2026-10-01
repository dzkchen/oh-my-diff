import type { Json, ModAPI, PackageRequest, PackageState, TerminalComponent, TerminalIdentity, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Review = { request: PackageRequest; label: string; changes: Json; grants: string[] };
type Saved = { open: boolean; generation: number; packages: PackageState[]; reloadError: string | null; selected: string | null; review: Review | null; notice: string | null; onboarded: boolean };
const EMPTY: Saved = { open: false, generation: 0, packages: [], reloadError: null, selected: null, review: null, notice: null, onboarded: false };
const REVIEWED = ['update', 'remove', 'rollback', 'trust'];

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ ...EMPTY, ...(api.state.get() as Partial<Saved> | null ?? {}) });
  const visible = (value: string, limit = 400) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, limit);
  const key = (item: PackageState) => `${item.scope}:${item.id}`;
  const refresh = (state: Saved, notice: string | null): Saved => {
    const listed = api.host.tryCall('packages.list', null);
    if (!listed.ok) return { ...state, packages: [], notice: `Mod list unavailable: ${listed.error}` };
    const packages = [...listed.value.packages].sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
    return { ...state, packages, generation: listed.value.generation, reloadError: listed.value.reload_error, notice };
  };
  const apply = (state: Saved, request: PackageRequest, label: string): Saved => {
    const result = api.host.tryCall('packages.apply', { ...request, expected_generation: state.generation });
    const done = request.action === 'install' ? 'installed disabled; enable it to use it' : 'applied; it takes effect at the next turn';
    const notice = !result.ok ? `${label} failed: ${result.error}` : result.value.status === 'declined' ? `${label} declined` : `${label} ${done}`;
    return refresh({ ...state, review: null, selected: request.id ? `${request.scope ?? 'user'}:${request.id}` : state.selected }, notice);
  };
  const review = (state: Saved, request: PackageRequest, label: string): Saved => {
    const result = api.host.tryCall('packages.preview', { ...request, expected_generation: state.generation });
    return result.ok
      ? { ...state, review: { request: { ...request, id: result.value.id }, label, changes: result.value.changes, grants: result.value.grants_added }, notice: null }
      : { ...state, review: null, notice: `${label} unavailable: ${result.error}` };
  };
  const act = (state: Saved, verb: string, argument: string): Saved => {
    if (verb === 'select') return { ...state, selected: argument };
    if (verb === 'cancel') return { ...state, review: null, notice: null };
    if (verb === 'apply') return state.review ? apply(state, state.review.request, state.review.label) : { ...state, notice: 'Nothing to apply' };
    if (verb === 'install') return argument ? review(state, { action: 'install', source: { kind: 'local', path: argument } }, `Install ${argument}`) : { ...state, notice: 'Enter an absolute mod directory' };
    if (verb === 'reload') {
      const result = api.host.tryCall('packages.reload', null);
      return refresh(state, !result.ok ? `Reload failed: ${result.error}` : `Every enabled mod revalidates at the next turn${result.value.failed.length ? `; failing now: ${result.value.failed.join(', ')}` : ''}`);
    }
    if (!verb) return state;
    const target = state.packages.find(item => item.installed && (key(item) === argument || item.id === argument));
    if (!target) return { ...state, notice: `No installed mod ${argument || 'selected'}` };
    const request = { id: target.id, scope: target.scope };
    if (verb === 'enable' || verb === 'disable') return apply(state, { action: verb, ...request }, `${verb} ${target.id}`);
    if (REVIEWED.includes(verb)) return review(state, { action: verb as PackageRequest['action'], ...request }, `${verb} ${target.id}`);
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
    return plan.packages ? plan.packages.map(version).join(', ') : plan.removed ? `remove ${plan.removed.map(version).join(', ')}` : plan.version ? `roll back ${version(plan).trim()}` : JSON.stringify(changes).slice(0, 160);
  };
  const reviewText = (review: Review) => `Review ${review.label} · ${changed(review.changes)} · new capabilities: ${review.grants.join(', ') || 'none'}`;
  api.command('mods', input => {
    const [verb = '', ...rest] = String(input ?? '').trim().split(/\s+/);
    const current = saved();
    if (verb === 'close') { api.state.set({ ...current, open: false, review: null, notice: null }); return null; }
    const state = ['select', 'cancel', 'apply'].includes(verb) ? current : refresh(current, null);
    const next = act(state, verb === 'open' ? '' : verb, rest.join(' '));
    const open = current.open || !verb || verb === 'open';
    api.state.set({ ...next, open });
    if (open) return null;
    return { display: next.review ? `${reviewText(next.review)}\nRun /mods apply or /mods cancel` : next.notice ?? 'No change' };
  }, { description: 'Show mods; /mods ACTION MOD enables, disables, trusts, updates, rolls back or removes one' });

  // Dialog height counts text lines, so long text is wrapped here instead of by the renderer.
  const wrap = (text: string, lines = 6) => visible(text, 2000).split(' ').reduce<string[]>((rows, word) => {
    const last = rows.length ? `${rows[rows.length - 1]} ${word}` : word;
    if (rows.length && last.length <= 72) rows[rows.length - 1] = last; else rows.push(word);
    return rows;
  }, []).slice(0, lines).join('\n');
  const line = (id: string, label: string, text: string, tone: TerminalTone = 'normal', lines = 6): TerminalComponent => ({ type: 'text', id: `omd_mods_${id}`, label, text: wrap(text, lines), tone });
  const button = (verb: string, text: string, value = ''): TerminalComponent => ({ type: 'button', id: `omd_mods_${verb}`, label: `${text} mod`, text, action: { command: 'omd_mods:mods', args: `${verb} ${value}`.trim() } });
  const status = (item: PackageState): [string, string, TerminalTone] =>
    !item.installed ? ['~', 'removed; runs until the next turn', 'attention']
      : item.failed ? ['!', 'failed', 'failure']
      : item.pending ? ['~', item.effective ? 'stops at the next turn' : 'starts at the next turn', 'attention']
      : item.effective ? ['●', 'active', 'success']
      : item.enabled ? ['○', item.conflicts[0] ?? 'shadowed by the project scope', 'muted']
      : ['○', 'disabled', 'muted'];
  const actions = (item: PackageState): TerminalComponent[] => {
    if (!item.installed) return [];
    const toggle = button(item.enabled ? 'disable' : 'enable', item.enabled ? 'Disable' : 'Enable', key(item));
    if (item.source !== 'selection') return [toggle, button('update', 'Update', key(item)), button('rollback', 'Roll back', key(item)), button('remove', 'Remove', key(item))];
    return item.failed?.startsWith('source_changed') ? [toggle, button('trust', 'Trust edited source', key(item))] : [toggle];
  };
  const details = (item: PackageState): TerminalComponent[] => [
    line('description', 'What it adds', item.description ?? 'No description', 'normal', 3),
    line('package', 'Package', `${item.version} · ${item.scope} scope · ${item.source === 'selection' ? 'trusted selection' : `${item.source} package`} · API ${item.api}${item.compatible ? '' : ' (incompatible)'} · capabilities: ${item.grants.join(', ') || 'none'}`, 'muted'),
    ...(item.failed ? [line('failed', 'Failure', `Failed: ${brief(item.failed)}`, 'failure')] : []),
    ...item.conflicts.map((conflict, index) => line(`conflict_${index}`, 'Conflict', `Conflict: ${conflict}`, 'attention')),
    ...(item.path ? [line('path', 'Source', item.path, 'muted', 1)] : []),
  ];
  const dialog = (state: Saved): TerminalComponent => {
    const current = state.packages.find(item => key(item) === state.selected) ?? state.packages[0];
    const count = (test: (item: PackageState) => boolean) => state.packages.filter(test).length;
    const children: TerminalComponent[] = [
      line('summary', 'Mods', `${count(item => item.effective)} active · ${count(item => item.enabled)} enabled · ${count(item => item.installed)} installed · changes apply at the next turn`),
      ...(state.reloadError ? [line('reload_error', 'Rejected change', `Rejected change; the previous mods keep running: ${brief(state.reloadError)}`, 'failure')] : []),
      ...(state.notice ? [line('notice', 'Result', state.notice, 'attention')] : []),
      ...(state.review ? [
        line('review', 'Review', reviewText(state.review), 'accent'),
        button('apply', 'Apply'), button('cancel', 'Cancel'),
      ] : []),
      ...(current ? [{ type: 'list' as const, id: 'omd_mods_list', label: 'Installed mods', height: 8, selected: key(current), action: { command: 'omd_mods:mods', args: 'select' },
        rows: state.packages.map(item => { const [mark, text, tone] = status(item); return { value: key(item), label: item.id, spans: [{ text: `${mark} ${item.id}`, tone }, { text: `  ${item.version} · ${item.scope} · ${text}`, tone: 'muted' as const }] }; }) },
        button('close', 'Close'), button('reload', 'Reload'), ...actions(current), ...details(current)]
        : [line('empty', 'Installed mods', 'No mods are installed'), button('close', 'Close'), button('reload', 'Reload')]),
      { type: 'input', id: 'omd_mods_install', label: 'Install a mod directory', placeholder: '/absolute/path/to/mod', action: { command: 'omd_mods:mods', args: 'install' } },
    ];
    return { type: 'dialog', id: 'omd_mods_dialog', label: 'Oh My Diff mods', title: 'Mods', children };
  };
  const welcome = (identity: TerminalIdentity | undefined): TerminalComponent[] => {
    const counts = identity ? `${identity.mods.active} of ${identity.mods.installed} mods active` : 'Mods installed';
    const lines = identity?.install_profile === 'platform_only'
      ? ['OMD Core: the mod host, with no first-party task behavior', `${counts} · /mods installs and toggles mods · /omd recovers a broken one`, 'Write your own: omd-mod-author create DIR ID, then /mods install DIR']
      : ['OMD+: most mods stay off until you enable them', `${counts} · /mods shows what each adds to Codex · /omd recovers a broken one`, 'Plain Codex any time: omd-package activate direct'];
    return lines.map((text, index) => line(`welcome_${index}`, 'Getting started', text, index ? 'muted' : 'normal'));
  };
  api.on('terminal', (input): TerminalPatch | null => {
    let state = saved();
    const phase = input.presentation?.phase;
    if (input.event === 'startup' && state.open) api.state.set(state = { ...state, open: false, review: null, notice: null });
    if (!state.onboarded && phase && phase !== 'fresh') api.state.set({ ...state, onboarded: true });
    const intro = !state.onboarded && phase === 'fresh';
    if (!intro && !state.open) return null;
    return { sites: {
      ...(intro ? { welcome: { mode: 'wrap', components: [{ type: 'slot' }, ...welcome(input.identity)] } } : {}),
      ...(state.open ? { dialog: { mode: 'wrap', components: [{ type: 'slot' }, dialog(state)] } } : {}),
    } };
  });
}
