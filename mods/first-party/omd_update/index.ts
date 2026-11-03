import type { Json, ModAPI, TerminalComponent, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Release = { version: string; prerelease?: boolean; notes?: string; page?: string; user_mods?: string[]; mod_api?: string };
type Mods = { omd: string; serial: number; changed?: string[]; notes?: string; page?: string };
type Info = {
  installed?: string; checked_at?: number | null; available?: Release | null; blocked?: { version: string; reasons?: string[] } | null;
  error?: string | null; pending?: { version: string } | null; failed?: { version: string; error?: string; at: number } | null;
  last?: { from: string; to: string; at: number } | null; held?: { version: string } | null; request_done?: string | null;
  withdrawn?: { version: string; run?: string | null } | null; mods?: Mods | null;
  last_mods?: { serial: number; changed?: string[]; at: number } | null; failed_mods?: { omd?: string; serial: number; error?: string; at: number } | null;
  held_mods?: { omd: string; serial: number } | null; pending_mods?: { omd: string; serial: number } | null;
};
type Saved = {
  info: Info | null; open: boolean; notice: string | null; banner: string[]; overrides: Record<string, string>;
  snoozed: { version: string; until: number } | null; skipped: string | null; shown: { version: string; at: number } | null;
  seen: number; requests: number; mark: { shown: { version: string; at: number } | null; seen: number } | null;
};
const EMPTY: Saved = { info: null, open: false, notice: null, banner: [], overrides: {}, snoozed: null, skipped: null, shown: null, seen: 0, requests: 0, mark: null };
const DAY = 86_400_000;
const CHOICES: Record<string, string[]> = { checks: ['on', 'off'], auto: ['off', 'on'], channel: ['stable', 'prerelease', 'nightly'], cadence: ['daily', 'weekly'] };

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ ...EMPTY, ...(api.state.get() as Partial<Saved> | null ?? {}) });
  const save = (patch: Partial<Saved>) => api.state.set({ ...saved(), ...patch } as unknown as Json);
  const visible = (value: unknown, limit: number) => typeof value === 'string' ? [...value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')].slice(0, limit).join('') : '';
  const withdrawn = (info: Info | null) => info?.withdrawn
    ? `Oh My Diff ${visible(info.withdrawn.version, 40)} was withdrawn${info.withdrawn.run ? `; run ${visible(info.withdrawn.run, 40)} in a shell` : ''}.` : '';
  const setting = (state: Saved, name: string) => state.overrides[name] ?? String(api.settings[name] ?? '');
  const names = (list: string[] | undefined) => (list ?? []).map(name => visible(name, 64)).join(', ');
  const modKey = (mods: Mods) => `mods-${mods.omd}-${mods.serial}`;
  const same = (mods: Mods, other?: { omd?: string; serial: number } | null) => other?.omd === mods.omd && other.serial === mods.serial;
  const offer = (state: Saved, info: Info | null) => info?.available?.version ?? (info?.mods && (setting(state, 'auto') !== 'on'
    || same(info.mods, info.failed_mods) || same(info.mods, info.held_mods) || same(info.mods, info.pending_mods)) ? modKey(info.mods) : null);

  const read = (): Info | null => {
    const env = api.host.tryCall('environment.read', { names: ['OH_MY_DIFF_UPDATE'] });
    const row = env.ok ? env.value.values.OH_MY_DIFF_UPDATE?.value : null;
    try {
      const value = row ? JSON.parse(row) as unknown : null;
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Info : null;
    } catch {
      return null;
    }
  };

  const detect = (resumed: boolean) => {
    const info = read();
    const previous = saved();
    const overrides = resumed ? Object.fromEntries(Object.entries(previous.overrides).filter(([name, value]) => String(api.settings[name] ?? '') !== value)) : {};
    const state = { ...previous, overrides };
    const now = Date.now();
    const available = info?.available;
    const banner: string[] = info?.withdrawn ? [withdrawn(info)] : [];
    if (info?.failed && info.failed.at > state.seen) banner.push(`The update to Oh My Diff ${visible(info.failed.version, 40)} failed and nothing changed. /update shows why.`);
    if (info?.last && info.last.at > state.seen) banner.push(`Oh My Diff was updated from ${visible(info.last.from, 40)} to ${visible(info.last.to, 40)}.`);
    if (info?.failed_mods && info.failed_mods.at > state.seen) banner.push('The first-party mod update failed and nothing changed. /update shows why.');
    if (info?.last_mods && info.last_mods.at > state.seen) banner.push(`First-party mods were updated: ${names(info.last_mods.changed)}.`);
    const offered = offer(state, info);
    const due = offered && setting(state, 'checks') !== 'off' && state.skipped !== offered
      && !(state.snoozed?.version === offered && now < state.snoozed.until)
      && !(state.shown?.version === offered && now - state.shown.at < DAY);
    if (due) banner.push(!available ? (info?.mods && same(info.mods, info.pending_mods)
      ? `Updates to first-party mods (${names(info.mods.changed)}) are downloaded and install the next time OMD starts with no other session open.`
      : `Updates to first-party mods are out: ${names(info?.mods?.changed)}. Run omd update in a shell, or /update.`)
      : info?.pending?.version === available.version
      ? `Oh My Diff ${visible(available.version, 40)} is downloaded and installs the next time OMD starts with no other session open.`
      : `Oh My Diff ${visible(available.version, 80)}${available.prerelease ? ' (prerelease)' : ''} is out; you have ${visible(info?.installed, 80)}. Run omd update in a shell, or /update for the notes.`);
    save({ info, banner, overrides, notice: null, open: false, mark: { shown: due ? { version: offered, at: now } : state.shown,
      seen: Math.max(state.seen, info?.last?.at ?? 0, info?.failed?.at ?? 0, info?.last_mods?.at ?? 0, info?.failed_mods?.at ?? 0) } });
    const request = info?.request_done ? api.host.tryCall('store.get', { key: 'request', scope: 'user' }) : null;
    if (request?.ok && request.value && (request.value.value as { id?: string } | null)?.id === info?.request_done) {
      api.host.tryCall('store.delete', { key: 'request', expected_revision: request.value.revision, scope: 'user' });
    }
  };
  api.on('start', () => detect(false));
  api.on('resume', () => detect(true));

  const act = (state: Saved, verb: string, value: string): Partial<Saved> => {
    const available = state.info?.available;
    if (Object.hasOwn(CHOICES, verb)) {
      if (!CHOICES[verb].includes(value)) return { notice: `${verb} takes ${CHOICES[verb].join(' or ')}` };
      const written = api.host.tryCall('settings.write', { values: { [verb]: value } });
      return written.ok ? { overrides: { ...state.overrides, [verb]: value }, notice: 'Saved; it applies from the next check.' } : { notice: `Not saved (${written.error})` };
    }
    if (!['request', 'mods', 'later', 'skip'].includes(verb)) return { notice: null };
    const offered = available?.version ?? (state.info?.mods ? modKey(state.info.mods) : null);
    if (!offered) return { notice: 'No update is known yet; run omd update check in a shell.' };
    if (verb === 'later') return { snoozed: { version: offered, until: Date.now() + 7 * DAY }, notice: 'You will be reminded in a week.' };
    if (verb === 'skip') return { skipped: offered, notice: available ? `Version ${visible(available.version, 40)} will not be mentioned again.` : 'These mod updates will not be mentioned again.' };
    const mods = verb === 'mods' ? state.info?.mods : null;
    if (verb === 'mods' ? !mods : !available) return { notice: 'That update is no longer offered; run omd update check in a shell.' };
    const current = api.host.tryCall('store.get', { key: 'request', scope: 'user' });
    const queued: Json = mods ? { id: `${modKey(mods)}#${state.requests + 1}`, mods: mods.serial, omd: mods.omd } : { id: `${offered}#${state.requests + 1}`, version: offered };
    const put = current.ok ? api.host.tryCall('store.put', { key: 'request', value: queued, expected_revision: current.value?.revision ?? null, scope: 'user' }) : current;
    return put.ok
      ? { requests: state.requests + 1, notice: mods ? 'The mod updates install the next time OMD starts. Quit this session to update now.'
        : `Oh My Diff ${visible(offered, 40)} installs the next time OMD starts with no other session open. Quit this session to update now.` }
      : { notice: `The update could not be queued (${put.error}); run omd update in a shell.` };
  };
  api.command('update', input => {
    const [verb = '', value = ''] = String(input ?? '').trim().split(/\s+/);
    if (verb === 'close') { save({ open: false, notice: null }); return null; }
    const state = saved();
    save({ ...act(state, verb, value), open: true });
    return null;
  }, { description: 'See whether a newer Oh My Diff is out and change update checks and automatic updates' });
  api.on('component_event', event => {
    if (event.component.startsWith('omd_update_') && event.kind === 'close') save({ open: false, notice: null });
  });

  // Dialog height counts text lines, so long text is wrapped here instead of by the renderer.
  const wrap = (value: string, lines: number, width = 72) => visible(value, 2000).split(/(\n)| /).filter(word => word !== undefined).reduce<string[]>((rows, word) => {
    if (word === '\n') return [...rows, ''];
    const last = rows.length ? `${rows[rows.length - 1]} ${word}`.trimStart() : word;
    if (rows.length && last.length <= width) rows[rows.length - 1] = last; else rows.push(word);
    return rows;
  }, []).slice(0, lines).join('\n');
  const line = (id: string, label: string, value: string, tone: TerminalTone = 'normal', lines = 3, width = 72): TerminalComponent =>
    ({ type: 'text', id: `omd_update_${id}`, label, text: wrap(value, lines, width), tone });
  const button = (verb: string, label: string): TerminalComponent =>
    ({ type: 'button', id: `omd_update_${verb.replace(/\W+/g, '_')}`, label, text: label, action: { command: 'omd_update:update', args: verb } });
  const when = (seconds: number | null | undefined) => seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never';

  const release = (state: Saved, available: Release): TerminalComponent[] => [
    line('available', 'Available', `Oh My Diff ${visible(available.version, 80)}${available.prerelease ? ' (prerelease)' : ''} is out. To install it, quit OMD and run:`, 'accent', 2),
    { type: 'code', id: 'omd_update_command', label: 'Update command', text: 'omd update', language: 'sh' },
    ...(available.notes ? [line('notes', 'Release notes', available.notes, 'normal', 8)] : []),
    ...(available.page ? [line('page', 'Release page', available.page, 'muted', 2)] : []),
    ...(available.user_mods?.length ? [line('user_mods', 'Incompatible mods', `These enabled mods do not support mod API ${visible(available.mod_api, 40)} and stop loading after the update: ${available.user_mods.map(name => visible(name, 64)).join(', ')}.`, 'attention', 3)] : []),
    ...(state.info?.pending?.version === available.version ? [line('pending', 'Downloaded', 'Downloaded and verified; it installs the next time OMD starts with no other session open.', 'success', 2)]
      : [button('request', 'Update now (installs when OMD next starts)')]),
    button('later', 'Remind me in a week'),
    button('skip', 'Skip this version'),
  ];
  const modUpdates = (info: Info, mods: Mods): TerminalComponent[] => [
    line('mods', 'Mod updates', `Updates to first-party mods are out: ${names(mods.changed)}. Your Oh My Diff version stays the same.`, 'accent', 3),
    ...(same(mods, info.pending_mods) ? [line('mods_pending', 'Downloaded', 'Downloaded and verified; they install the next time OMD starts with no other session open.', 'success', 2)] : []),
    ...(same(mods, info.held_mods) ? [line('mods_held', 'Rolled back', 'You rolled these back; automatic updates skip them. Choose Update mods to install them again.', 'muted', 2)] : []),
    ...(mods.notes ? [line('mods_notes', 'Notes', mods.notes, 'normal', 8)] : []),
    ...(mods.page ? [line('mods_page', 'Release page', mods.page, 'muted', 2)] : []),
    button('mods', 'Update mods (installs when OMD next starts)'),
    button('later', 'Remind me in a week'),
    button('skip', 'Skip these updates'),
  ];
  const dialog = (state: Saved): TerminalComponent => {
    const info = state.info;
    const checks = setting(state, 'checks'), auto = setting(state, 'auto'), channel = setting(state, 'channel'), cadence = setting(state, 'cadence');
    const status = !info ? [line('unmanaged', 'Installation', 'This Oh My Diff was not installed by the OMD installer, so it has no update checks.', 'muted')]
      : [
        line('installed', 'Installed', `Installed ${visible(info.installed, 40)} · last check ${when(info.checked_at)}`, 'normal', 1),
        ...(info.withdrawn ? [line('withdrawn', 'Withdrawn', withdrawn(info), 'attention', 2)] : []),
        ...(info.held ? [line('held', 'Rolled back', `You rolled back from ${visible(info.held.version, 40)}; automatic updates skip it. Run omd update to install it again.`, 'muted', 2)] : []),
        ...(info.failed ? [line('failed', 'Last update', `The update to ${visible(info.failed.version, 40)} failed and nothing changed: ${visible(info.failed.error, 300)}`, 'failure', 4)] : []),
        ...(info.failed_mods ? [line('failed_mods', 'Last mod update', `The first-party mod update failed and nothing changed: ${visible(info.failed_mods.error, 300)}`, 'failure', 4)] : []),
        ...(info.available ? release(state, info.available) : info.mods ? modUpdates(info, info.mods)
          : [line('current', 'Status', info.error ? `The last check failed: ${visible(info.error, 200)}` : info.checked_at ? 'You have the newest release for your settings.' : 'No check has run yet; run omd update check in a shell.', info.error ? 'attention' : 'muted', 3)]),
        ...(info.blocked ? [line('blocked', 'Not compatible', `Oh My Diff ${visible(info.blocked.version, 40)} needs: ${(info.blocked.reasons ?? []).map(reason => visible(reason, 120)).join('; ')}`, 'attention', 4)] : []),
      ];
    const children: TerminalComponent[] = [
      { type: 'line', id: 'omd_update_header', label: 'Updates', spans: [{ text: 'Updates', bold: true, tone: 'accent' }] },
      ...(state.notice ? [line('notice', 'Result', state.notice, 'attention')] : []),
      ...status,
      ...!info ? [] : [line('settings', 'Settings', `Checks ${checks}, ${cadence} · channel ${channel} · automatic updates ${auto} · pin ${visible(api.settings.pin, 40) || 'none'}`, 'muted', 2),
      button(`checks ${checks === 'off' ? 'on' : 'off'}`, checks === 'off' ? 'Turn update checks on' : 'Turn update checks off'),
      button(`auto ${auto === 'on' ? 'off' : 'on'}`, auto === 'on' ? 'Turn automatic updates off' : 'Turn automatic updates on'),
      ...CHOICES.channel.filter(value => value !== channel).map(value => button(`channel ${value}`, `Use ${value} releases`)),
      button(`cadence ${cadence === 'weekly' ? 'daily' : 'weekly'}`, cadence === 'weekly' ? 'Check daily' : 'Check weekly'),
      line('help', 'More', 'Automatic updates download in the background and install releases and first-party mod updates when OMD starts with no other session open; they never touch mods you installed. Pin with omd update pin VERSION. omd update rollback undoes the last update.', 'muted', 4)],
      button('close', 'Close'),
    ];
    return { type: 'dialog', id: 'omd_update_dialog', label: 'Oh My Diff updates', title: 'Updates', children };
  };

  api.on('terminal', (input): TerminalPatch | null => {
    const state = saved();
    const presentation = input.presentation;
    const intro = state.banner.length > 0 && presentation?.phase === 'fresh' && presentation.surface !== 'inline';
    if (intro && state.mark && presentation?.surface === 'fullscreen') save({ ...state.mark, mark: null });
    if (!intro && !state.open) return null;
    return { sites: {
      ...(intro ? { welcome: { mode: 'wrap', components: [{ type: 'slot' }, ...state.banner.map((value, index) => line(`welcome_${index}`, 'Update', value, index === state.banner.length - 1 ? 'accent' : 'muted', 2, 56))] } } : {}),
      ...(state.open ? { dialog: { mode: 'wrap', components: [{ type: 'slot' }, dialog(state)] } } : {}),
    } };
  });
}
