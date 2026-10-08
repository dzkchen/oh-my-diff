import type { Json, ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

type State = { open: boolean; coding: 'idle' | 'running' | 'finished' };

const URL = 'https://www.chess.com/play/online';
const VERBS = ['open', 'hide', 'end'];

export default function activate(api: ModAPI) {
  const load = (): State => ({ open: false, coding: 'idle', ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);
  const notice = (text: string, kind: 'info' | 'warning') => api.host.tryCall('terminal.notice', { text, kind, placement: 'toast', ttl_ms: 8_000, id: 'omd_chess' });
  const browser = (method: 'open' | 'close', input: Json) => {
    try {
      api.services.call('omd.browser', method, input);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      notice(`Chess needs the omd_browser mod from the omd-browser plugin (${error.message})`, 'warning');
    }
  };

  api.command('chess', value => {
    const verb = String(value ?? '').trim() || 'open';
    if (verb === 'system') {
      const opened = api.host.tryCall('terminal.open', { url: URL });
      return { display: opened.ok && 'opened' in opened.value
        ? 'Opened Chess.com in your system browser: a fallback outside OMD with no pane and no coding notices'
        : 'Chess.com was not opened' };
    }
    if (!VERBS.includes(verb)) return { display: 'usage: /chess [open|hide|end|system]' };
    api.host.tryCall('events.publish', { channel: 'request', data: verb });
    return { display: verb === 'open' ? 'Opening Chess.com beside the conversation…' : verb === 'hide' ? 'Hiding Chess.com; the game keeps running' : 'Ending the Chess.com browser session…' };
  }, { description: 'Play on Chess.com in a user-only browser pane beside the conversation', args_hint: '[open|hide|end|system]' });

  api.on('channel', event => {
    const state = load();
    const data = event.data as { session?: string; open?: boolean; display?: string } | null;
    if (event.channel === 'omd_browser/opened' || event.channel === 'omd_browser/closed') {
      if (data?.session !== 'chess') return;
      const open = event.channel.endsWith('/opened') && data.open === true;
      if (open !== state.open) save({ ...state, open });
      if (event.channel.endsWith('/opened')) notice(String(data.display ?? ''), open ? 'info' : 'warning');
      return;
    }
    const verb = String(event.data);
    if (VERBS.includes(verb)) browser(verb === 'open' ? 'open' : 'close', verb === 'open' ? { session: 'chess', url: URL, user_only: true, zoom: 0.8 } : { session: 'chess', end: verb === 'end' });
  });

  api.on('turn_start', () => {
    const state = load();
    if (state.open) save({ ...state, coding: 'running' });
  });
  api.on('turn_end', ({ outcome }) => {
    const state = load();
    if (!state.open) return;
    save({ ...state, coding: 'finished' });
    notice(`Coding turn ${outcome === 'completed' ? 'finished' : outcome}; your game continues`, 'info');
  });

  api.on('terminal', (): TerminalPatch => {
    const state = load();
    return state.open ? { status: [state.coding === 'running' ? '♟ coding turn running' : state.coding === 'finished' ? '♟ coding turn finished' : '♟ Chess.com open'] } : {};
  });
}
