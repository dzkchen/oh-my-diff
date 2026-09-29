import type { Json, Ledger, ModAPI, TerminalComponent, TerminalIdentity, TerminalPatch } from '../../api.d.ts';

type Snapshot = { open: boolean; ledger: Ledger | null; contract: string; limits: string; workerLimits: string; error: string | null };
const EMPTY: Snapshot = { open: false, ledger: null, contract: 'unavailable', limits: 'unavailable', workerLimits: 'unavailable', error: null };

export default function activate(api: ModAPI) {
  const saved = (): Snapshot => ({ ...EMPTY, ...(api.state.get() as Partial<Snapshot> | null ?? {}) });
  const save = (state: Snapshot) => api.state.set(state);
  const visible = (value: string, limit = 160) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, limit);
  const summary = (value: Json): string => typeof value === 'string' ? visible(value) : value === null ? 'unavailable' : visible(JSON.stringify(value), 200);
  const line = (id: string, label: string, text: string): TerminalComponent => ({ type: 'text', id, label, text: visible(text, 400) });
  const capture = (state: Snapshot): Snapshot => {
    const task = api.host.tryCall('task.status', null);
    const contract = api.host.tryCall('contract.status', null);
    const active = contract.ok && contract.value.status === 'active' ? contract.value.active : null;
    return {
      ...state,
      ledger: task.ok ? task.value.ledger : state.ledger,
      limits: task.ok ? summary(task.value.limits) : 'unavailable',
      workerLimits: task.ok ? summary(task.value.worker_limits) : 'unavailable',
      contract: active ? `${visible(active.id, 80)}@${active.version} (${visible(active.assurance, 80)})` : contract.ok ? contract.value.status : 'unavailable',
      error: task.ok || contract.ok ? null : 'Live task and contract status are unavailable',
    };
  };
  const view = (identity: TerminalIdentity | undefined, ledger: Ledger | null): TerminalPatch | null => {
    const state = saved();
    if (!state.open) return null;
    const effective = ledger ?? state.ledger;
    const cost = effective?.cost && typeof effective.cost === 'object' && !Array.isArray(effective.cost) ? effective.cost : null;
    const children: TerminalComponent[] = [
      line('omd_inspector_mode', 'Mode', identity?.mode === 'omd' ? 'Oh My Diff' : 'unavailable'),
      line('omd_inspector_profile', 'Install profile', identity?.install_profile ?? 'unreported'),
      line('omd_inspector_mods', 'Mods', identity ? `${identity.mods.active} active · ${identity.mods.enabled} enabled · ${identity.mods.installed} installed` : 'unavailable'),
      line('omd_inspector_thread', 'Session', effective?.thread_id ?? 'unavailable'),
      line('omd_inspector_contract', 'Contract', state.contract),
      line('omd_inspector_limits', 'Task limits', state.limits),
      line('omd_inspector_worker_limits', 'Worker limits', state.workerLimits),
      line('omd_inspector_cost', 'Ledger', cost ? summary(cost) : 'unavailable'),
      ...(state.error ? [line('omd_inspector_error', 'Status', state.error)] : []),
      { type: 'button', id: 'omd_inspector_refresh', label: 'Refresh inspector', text: 'Refresh', action: { command: 'omd_inspector:refresh' } },
      { type: 'button', id: 'omd_inspector_close', label: 'Close inspector', text: 'Close', action: { command: 'omd_inspector:close' } },
    ];
    return { sites: { dialog: { mode: 'replace', components: [{ type: 'dialog', id: 'omd_inspector_dialog', label: 'Oh My Diff inspector', title: 'Oh My Diff inspector', children }] } }, keybindings: { 'Alt+i': { command: 'omd_inspector:close' } } };
  };
  const open = () => { save(capture({ ...saved(), open: true })); return null; };
  api.command('open', open, { description: 'Open the Oh My Diff inspector' });
  api.command('omd', open, { description: 'Open the Oh My Diff inspector' });
  api.command('refresh', () => { save(capture({ ...saved(), open: true })); return null; }, { description: 'Refresh the Oh My Diff inspector' });
  api.command('close', () => { save({ ...saved(), open: false }); return null; }, { description: 'Close the Oh My Diff inspector' });
  api.on('terminal', input => view(input.identity, input.ledger));
}
