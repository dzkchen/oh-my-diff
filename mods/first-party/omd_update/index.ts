import type { Json, ModAPI, TerminalComponent, TerminalPatch, TerminalTone } from '../../api.d.ts';

type Release = { version: string; prerelease?: boolean; notes?: string; page?: string; user_mods?: string[]; manifest?: { mod_api?: string } };
type Info = {
  installed?: string; checked_at?: number | null; available?: Release | null; blocked?: { version: string; reasons?: string[] } | null;
  error?: string | null; pending?: { version: string } | null; failed?: { version: string; error?: string; at: number } | null;
  last?: { from: string; to: string; at: number } | null; held?: { version: string } | null; request_done?: string | null;
};
type Saved = {
  info: Info | null; open: boolean; notice: string | null; banner: string[]; overrides: Record<string, string>;
  snoozed: { version: string; until: number } | null; skipped: string | null; shown: { version: string; at: number } | null;
  seen: number; requests: number; mark: { shown: { version: string; at: number } | null; seen: number } | null;
};
const EMPTY: Saved = { info: null, open: false, notice: null, banner: [], overrides: {}, snoozed: null, skipped: null, shown: null, seen: 0, requests: 0, mark: null };
const DAY = 86_400_000;
const VARIABLE = 'OH_MY_DIFF_UPDATE=';
const CHOICES: Record<string, string[]> = { checks: ['on', 'off'], auto: ['off', 'on'], channel: ['stable', 'beta', 'nightly'], cadence: ['daily', 'weekly'] };

export default function activate(api: ModAPI) {
  const saved = (): Saved => ({ ...EMPTY, ...(api.state.get() as Partial<Saved> | null ?? {}) });
  const save = (patch: Partial<Saved>) => api.state.set({ ...saved(), ...patch } as unknown as Json);
  const visible = (value: unknown, limit: number) => typeof value === 'string' ? [...value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')].slice(0, limit).join('') : '';
  const setting = (state: Saved, name: string) => state.overrides[name] ?? String(api.settings[name] ?? '');

  const read = (): Info | null => {
    const env = api.host.tryCall('exec.run', { program: 'env', timeout_ms: 2000, max_output_bytes: 65536 });
    const row = (env.ok && env.value.exit_code === 0 ? env.value.stdout : '').split('\n').find(line => line.startsWith(VARIABLE));
    try {
      const value = row ? JSON.parse(row.slice(VARIABLE.length)) as unknown : null;
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
    const banner: string[] = [];
    if (info?.failed && info.failed.at > state.seen) banner.push(`The update to Oh My Diff ${visible(info.failed.version, 40)} failed and nothing changed. /update shows why.`);
    if (info?.last && info.last.at > state.seen) banner.push(`Oh My Diff was updated from ${visible(info.last.from, 40)} to ${visible(info.last.to, 40)}.`);
    const due = available && setting(state, 'checks') !== 'off' && state.skipped !== available.version
      && !(state.snoozed?.version === available.version && now < state.snoozed.until)
      && !(state.shown?.version === available.version && now - state.shown.at < DAY);
    if (due) banner.push(info?.pending?.version === available.version
      ? `Oh My Diff ${visible(available.version, 40)} is downloaded and installs the next time OMD starts with no other session open.`
      : `Oh My Diff ${visible(available.version, 80)}${available.prerelease ? ' (prerelease)' : ''} is out; you have ${visible(info?.installed, 80)}. Run omd update in a shell, or /update for the notes.`);
    save({ info, banner, overrides, notice: null, open: false, mark: { shown: due ? { version: available.version, at: now } : state.shown,
      seen: Math.max(state.seen, info?.last?.at ?? 0, info?.failed?.at ?? 0) } });
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
    if (!['request', 'later', 'skip'].includes(verb)) return { notice: null };
    if (!available) return { notice: 'No newer release is known yet; run omd update check in a shell.' };
    if (verb === 'later') return { snoozed: { version: available.version, until: Date.now() + 7 * DAY }, notice: 'You will be reminded in a week.' };
    if (verb === 'skip') return { skipped: available.version, notice: `Version ${visible(available.version, 40)} will not be mentioned again.` };
    const current = api.host.tryCall('store.get', { key: 'request', scope: 'user' });
    const id = `${available.version}#${state.requests + 1}`;
    const put = current.ok ? api.host.tryCall('store.put', { key: 'request', value: { id, version: available.version }, expected_revision: current.value?.revision ?? null, scope: 'user' }) : current;
    return put.ok
      ? { requests: state.requests + 1, notice: `Oh My Diff ${visible(available.version, 40)} installs the next time OMD starts with no other session open. Quit this session to update now.` }
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
    if (event.component.startsWith('omd_update_') && event.events?.some(input => 'key' in input && input.key === 'Esc')) save({ open: false, notice: null });
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
  const when = (seconds: number | null | undefined) => seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never';

  const release = (state: Saved, available: Release): TerminalComponent[] => [
    line('available', 'Available', `Oh My Diff ${visible(available.version, 80)}${available.prerelease ? ' (prerelease)' : ''} is out. To install it, quit OMD and run:`, 'accent', 2),
    { type: 'code', id: 'omd_update_command', label: 'Update command', text: 'omd update', language: 'sh' },
    ...(available.notes ? [line('notes', 'Release notes', available.notes, 'normal', 8)] : []),
    ...(available.page ? [line('page', 'Release page', available.page, 'muted', 2)] : []),
    ...(available.user_mods?.length ? [line('user_mods', 'Incompatible mods', `These enabled mods do not support mod API ${visible(available.manifest?.mod_api, 40)} and stop loading after the update: ${available.user_mods.map(name => visible(name, 64)).join(', ')}.`, 'attention', 3)] : []),
    ...(state.info?.pending?.version === available.version ? [line('pending', 'Downloaded', 'Downloaded and verified; it installs the next time OMD starts with no other session open.', 'success', 2)]
      : [button('request', 'Update now (installs when OMD next starts)')]),
    button('later', 'Remind me in a week'),
    button('skip', 'Skip this version'),
  ];
  const dialog = (state: Saved): TerminalComponent => {
    const info = state.info;
    const checks = setting(state, 'checks'), auto = setting(state, 'auto'), channel = setting(state, 'channel'), cadence = setting(state, 'cadence');
    const status = !info ? [line('unmanaged', 'Installation', 'This Oh My Diff was not installed by the OMD installer, so it has no update checks.', 'muted')]
      : [
        line('installed', 'Installed', `Installed ${visible(info.installed, 40)} · last check ${when(info.checked_at)}`, 'normal', 1),
        ...(info.held ? [line('held', 'Rolled back', `You rolled back from ${visible(info.held.version, 40)}; automatic updates skip it. Run omd update to install it again.`, 'muted', 2)] : []),
        ...(info.failed ? [line('failed', 'Last update', `The update to ${visible(info.failed.version, 40)} failed and nothing changed: ${visible(info.failed.error, 300)}`, 'failure', 4)] : []),
        ...(info.available ? release(state, info.available)
          : [line('current', 'Status', info.error ? `The last check failed: ${visible(info.error, 200)}` : info.checked_at ? 'You have the newest release for your settings.' : 'No check has run yet; run omd update check in a shell.', info.error ? 'attention' : 'muted', 3)]),
        ...(info.blocked ? [line('blocked', 'Not compatible', `Oh My Diff ${visible(info.blocked.version, 40)} needs: ${(info.blocked.reasons ?? []).map(reason => visible(reason, 120)).join('; ')}`, 'attention', 4)] : []),
      ];
    const children: TerminalComponent[] = [
      { type: 'line', id: 'omd_update_header', label: 'Updates', spans: [{ text: 'Updates', bold: true, tone: 'accent' }] },
      ...(state.notice ? [line('notice', 'Result', state.notice, 'attention')] : []),
      ...status,
      line('settings', 'Settings', `Checks ${checks}, ${cadence} · channel ${channel} · automatic updates ${auto} · pin ${visible(api.settings.pin, 40) || 'none'}`, 'muted', 2),
      button(`checks ${checks === 'off' ? 'on' : 'off'}`, checks === 'off' ? 'Turn update checks on' : 'Turn update checks off'),
      button(`auto ${auto === 'on' ? 'off' : 'on'}`, auto === 'on' ? 'Turn automatic updates off' : 'Turn automatic updates on'),
      ...CHOICES.channel.filter(value => value !== channel).map(value => button(`channel ${value}`, `Use ${value} releases`)),
      button(`cadence ${cadence === 'weekly' ? 'daily' : 'weekly'}`, cadence === 'weekly' ? 'Check daily' : 'Check weekly'),
      line('help', 'More', 'Automatic updates download in the background and install when OMD starts with no other session open; they never touch mods you installed. Pin a version with omd update pin VERSION or in /mods. omd update rollback restores the previous version.', 'muted', 4),
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
