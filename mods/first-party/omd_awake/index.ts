import type { Json, ModAPI, TerminalPatch } from '../../api.d.ts';

type State = { running: boolean; lease: string | null; lid_closed: boolean; since: number; idle_since: number; paused: string | null;
  offline: number; warned: boolean; failed: boolean; hotspot_checked: string };

const CHECK_MS = 60_000;
const NETWORK_CHECK_MS = 15_000;
const MIN_HOLD_MS = 60_000;
const REJOIN_ATTEMPTS = 20;
const HEAVY_THERMAL_PRESSURE = 2;
const THERMAL = 'com.apple.system.thermalpressurelevel';
const LOW_POWER = 'com.apple.system.lowpowermode';
const TITLE = 'Oh My Diff awake';
const IDLE: Partial<State> = { running: false, lease: null, lid_closed: false, since: 0, idle_since: 0, paused: null, offline: 0 };
const USAGE = '/awake on|off · lid on|off · hotspot <network>|off · grace <seconds> · battery <percent> · hours <1-24>';

export default function activate(api: ModAPI) {
  api.builtins({ features: { remove: ['prevent_idle_sleep'] } });
  const enabled = api.settings.enabled !== false;
  const graceMs = Math.max(0, Number(api.settings.grace_seconds ?? 120)) * 1000;
  const floor = Number(api.settings.battery_floor ?? 20);
  const hours = Math.min(24, Math.max(1, Number(api.settings.max_hours ?? 4)));
  const lidClosed = api.settings.lid_closed !== false;
  const hotspot = String(api.settings.hotspot_ssid ?? '').trim();
  const load = (): State => ({ running: false, lease: null, lid_closed: false, since: 0, idle_since: 0, paused: null, offline: 0, warned: false,
    failed: false, hotspot_checked: '', ...(api.state.get() as Partial<State> | null) });
  const run = (program: string, argv: string[], unsandboxed = false) => {
    const result = api.host.tryCall('exec.run', { program, argv, timeout_ms: 20_000, max_output_bytes: 16_384, ...(unsandboxed ? { sandbox: 'none' as const } : {}) });
    return result.ok && result.value.exit_code === 0 && !result.value.timed_out ? result.value.stdout : null;
  };
  const tell = (text: string, kind: 'info' | 'warning' | 'error' = 'warning') => {
    api.host.tryCall('terminal.notice', { text, kind, placement: 'toast', ttl_ms: 15_000, id: 'awake' });
    api.host.tryCall('terminal.notify', { title: TITLE, body: text });
  };
  const wifi = () => (run('/usr/sbin/networksetup', ['-listallhardwareports'], true) ?? '').match(/Hardware Port: Wi-Fi\nDevice: (\S+)/)?.[1];
  const closed = () => (run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1']) ?? '').includes('"AppleClamshellState" = Yes');
  const agentsRunning = () => {
    const inventory = api.host.tryCall('agents.inventory', null);
    return inventory.ok && inventory.value.agents.some(agent => agent.status === 'running');
  };

  const safeguard = (state: State): string | null => {
    if (Date.now() - state.since >= hours * 3_600_000) return `reached the ${hours} h limit`;
    const battery = run('/usr/bin/pmset', ['-g', 'batt']) ?? '';
    const level = battery.match(/(\d+)%/);
    if (battery.includes("'Battery Power'") && level && Number(level[1]) <= floor) return `battery at ${level[1]}%`;
    const flags = run('/usr/bin/notifyutil', ['-g', THERMAL, '-g', LOW_POWER]) ?? '';
    const flag = (key: string) => Number(flags.split('\n').find(line => line.startsWith(`${key} `))?.slice(key.length + 1) ?? 0);
    if (flag(LOW_POWER) > 0) return 'Low Power Mode is on';
    if (flag(THERMAL) >= HEAVY_THERMAL_PRESSURE) return 'the Mac is under heavy thermal pressure';
    return null;
  };

  const release = (state: State) => {
    if (state.lease) api.host.tryCall('power.release', { lease: state.lease });
    state.lease = null;
    state.offline = 0;
  };

  const acquire = (state: State) => {
    const remaining = Math.max(MIN_HOLD_MS, state.since + hours * 3_600_000 - Date.now());
    const hold = (lid_closed: boolean) => api.host.tryCall('power.hold', { reason: 'Oh My Diff agents are working', lid_closed, max_duration_ms: remaining });
    let held = hold(lidClosed);
    if (!held.ok && lidClosed) {
      if (!state.warned) tell(`Lid-closed wake is off (${held.error.replace(/^power_unavailable: /, '')}); the Mac stays awake only while the lid is open`, 'info');
      state.warned = true;
      held = hold(false);
    } else if (held.ok && held.value.lid_closed) {
      state.warned = false;
    }
    if (!held.ok) {
      if (!state.failed) tell(`Couldn't keep the Mac awake: ${held.error}`, 'error');
      state.failed = true;
      return;
    }
    const previous = state.lease;
    Object.assign(state, { lease: held.value.lease, lid_closed: held.value.lid_closed, failed: false });
    api.state.set(state);
    if (previous) api.host.tryCall('power.release', { lease: previous });
    if (state.lid_closed && hotspot && state.hotspot_checked !== hotspot) {
      state.hotspot_checked = hotspot;
      const device = wifi();
      const saved = device ? run('/usr/sbin/networksetup', ['-listpreferredwirelessnetworks', device], true) : null;
      if (saved !== null && !saved.split('\n').some(line => line.trim() === hotspot)) {
        tell(`${hotspot} isn't a saved Wi-Fi network, so it can't be joined while the lid is closed. Join it once from the menu bar so macOS keeps its password.`);
      }
    }
  };

  const rejoin = (state: State) => {
    if (!closed()) return;
    if (run('/sbin/route', ['-n', 'get', 'default'], true) !== null) return void (state.offline = 0);
    if (state.offline > REJOIN_ATTEMPTS) return;
    state.offline += 1;
    if (state.offline > REJOIN_ATTEMPTS) return void tell(hotspot ? `Couldn't rejoin Wi-Fi or the ${hotspot} hotspot` : "Couldn't rejoin a known Wi-Fi network");
    const device = wifi();
    if (!device) return;
    if (hotspot && state.offline > 1) return void run('/usr/sbin/networksetup', ['-setairportnetwork', device, hotspot], true);
    if (state.offline % 2 === 0) return;
    run('/usr/sbin/networksetup', ['-setairportpower', device, 'off'], true);
    run('/usr/sbin/networksetup', ['-setairportpower', device, 'on'], true);
  };

  const tick = (state: State) => {
    const now = Date.now();
    if (!enabled) {
      release(state);
      api.state.set({ ...state, ...IDLE, running: state.running });
      return;
    }
    const active = state.running || agentsRunning();
    if (!active) {
      state.idle_since ||= now;
      if (now - state.idle_since >= graceMs) {
        release(state);
        Object.assign(state, { paused: null, since: 0 });
      }
    } else {
      state.idle_since = 0;
      state.since ||= now;
      const reason = state.paused ? null : safeguard(state);
      if (reason) {
        release(state);
        state.paused = reason;
        tell(`Stopped keeping the Mac awake: ${reason}. It sleeps normally until the agents finish.`);
      } else if (!state.paused) {
        if (!state.lease || lidClosed || state.lid_closed) acquire(state);
        if (state.lease && state.lid_closed) rejoin(state);
      }
    }
    if (state.lease || state.paused) {
      const idleLeft = state.idle_since ? Math.max(1000, state.idle_since + graceMs - now) : CHECK_MS;
      const network = state.lease && state.lid_closed && state.offline <= REJOIN_ATTEMPTS;
      api.host.tryCall('events.schedule', { key: 'check', delay_ms: Math.min(idleLeft, network ? NETWORK_CHECK_MS : CHECK_MS) });
    }
    api.state.set(state);
  };

  api.on('turn_start', () => tick({ ...load(), running: true }));
  api.on('turn_end', () => tick({ ...load(), running: false }));
  api.on('timer', event => { if (event.key === 'check') tick(load()); });
  api.on('channel', event => { if (event.channel === 'omd_awake/apply') api.host.tryCall('events.schedule', { key: 'check', delay_ms: 1000 }); });

  api.command('awake', input => {
    const [verb = '', ...rest] = String(input ?? '').trim().split(/\s+/).filter(Boolean);
    const value = rest.join(' '), number = Number(value);
    const values: Record<string, Json> | null =
      verb === 'on' || verb === 'off' ? { enabled: verb === 'on' }
      : verb === 'lid' && (value === 'on' || value === 'off') ? { lid_closed: value === 'on' }
      : verb === 'hotspot' && value ? { hotspot_ssid: value === 'off' ? '' : value }
      : verb === 'grace' && value && Number.isInteger(number) && number >= 0 && number <= 3600 ? { grace_seconds: number }
      : verb === 'battery' && value && Number.isInteger(number) && number >= 0 && number <= 100 ? { battery_floor: number }
      : verb === 'hours' && value && Number.isInteger(number) && number >= 1 && number <= 24 ? { max_hours: number }
      : null;
    if (verb && !values) return { display: `Usage: ${USAGE}` };
    const settings = { enabled, lid_closed: lidClosed, hotspot_ssid: hotspot, grace_seconds: graceMs / 1000, battery_floor: floor, max_hours: hours, ...values };
    if (values) {
      api.host.tryCall('events.publish', { channel: 'apply', data: null });
      const written = api.host.tryCall('settings.write', { values });
      if (!written.ok) return { display: `Not saved (${written.error})` };
    }
    const state = load();
    const now = !settings.enabled ? 'off' : state.paused ? `paused: ${state.paused}` : !state.lease ? 'on, waiting for agents'
      : state.lid_closed ? 'holding, lid can close' : 'holding, lid must stay open';
    return { display: [
      `Stay awake while agents work: ${now}`,
      `Lid closed: ${settings.lid_closed ? 'on (needs the authority broker)' : 'off'} · grace ${settings.grace_seconds} s · battery floor ${settings.battery_floor}% · max ${settings.max_hours} h · hotspot: ${settings.hotspot_ssid || 'none'}`,
      USAGE,
    ].join('\n') };
  }, { description: 'Keep the Mac awake while agents work (replaces Prevent sleep while running)', args_hint: 'on|off|lid|hotspot|grace|battery|hours' });
  for (const event of ['start', 'resume'] as const) {
    api.on(event, () => {
      const state = load();
      release(state);
      api.state.set({ ...state, ...IDLE });
    });
  }

  api.on('terminal', (): TerminalPatch | null => {
    const state = load();
    if (state.paused) return { status: [`awake off: ${state.paused}`.slice(0, 40)] };
    if (!state.lease) return null;
    return { status: [state.idle_since ? 'awake: winding down' : state.lid_closed ? 'awake · lid can close' : 'awake'] };
  });
}
