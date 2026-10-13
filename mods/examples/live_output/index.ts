import type { ModAPI, ProcessChunk, TerminalPatch } from '@oh-my-diff/mod-api';

const LIMIT = 49_152;
type Output = { run: number; command: string; text: string; status: string; held?: Record<string, string> };

const bytes = (text: string) => {
  let count = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    count += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return count;
};

const fit = (text: string, limit: number) => {
  const clean = text.replace(/\p{Cc}/gu, ' ');
  if (bytes(clean) <= limit) return clean;
  let [cut, used] = ['', 3];
  for (const character of clean) {
    used += bytes(character);
    if (used > limit) break;
    cut += character;
  }
  return `${cut}…`;
};

const decoded = (base64: string) => base64.length * 3 / 4 - (base64.match(/=*$/)?.[0].length ?? 0);

const live = (run: number) => `live-${run}`;

const append = (text: string, held: string, data: string): [string, string] => {
  const input = held + data;
  const tail = input.match(/(\u001b(\[[0-9;?]*[ -/]*)?|\r)$/)?.[0] ?? '';
  const body = input.slice(0, input.length - tail.length).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n');
  return [(text + body).replace(/[^\n]*\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), tail];
};

export default function activate(api: ModAPI) {
  const output = () => (api.state.get() as Output | null) ?? { run: 0, command: '', text: '', status: 'idle' };

  api.command('run', args => {
    const command = typeof args === 'string' ? args.trim() : '';
    if (!command) return { display: 'Usage: /live_output:run COMMAND' };
    const asked = api.host.tryCall('events.publish', { channel: 'run', data: command });
    return { display: asked.ok ? `Running ${command}` : 'Running is unavailable here' };
  }, { description: 'Run a shell command and stream its output' });

  api.on('channel', ({ channel, data }) => {
    if (channel !== 'live_output/run' || typeof data !== 'string') return;
    const previous = output().run;
    const run = previous + 1;
    api.host.tryCall('process.stop', { session: live(previous) });
    const shell = api.host.call('process.which', { names: ['sh'] }).found[0];
    if (!shell) return api.state.set({ run, command: data, text: '', status: 'cannot find sh' });
    const started = api.host.tryCall('process.start', {
      session: live(run), name: 'sh', path: shell.path, sha256: shell.sha256, arguments: ['-c', data], framing: 'raw', stdin: 'null', notify: ['output', 'exit'],
    });
    api.state.set({ run, command: data, text: '', status: started.ok ? 'running' : started.error });
  });

  const drain = (run: number, exit: boolean) => {
    const current = output();
    if (current.run !== run || current.status !== 'running') return;
    let { text } = current;
    let status = current.status as string;
    const held = { ...current.held };
    let more = false;
    for (let page = 0; page < 2; page += 1) {
      const answer = api.host.tryCall('process.exchange', { session: live(run), wait_ms: 0 });
      if (!answer.ok) {
        if (answer.error.startsWith('process_stopped')) status = 'exited';
        more = false;
        break;
      }
      for (const chunk of answer.value.messages as ProcessChunk[]) {
        if (chunk.data === undefined) text += `[${decoded(chunk.data_base64 ?? '')} binary bytes]\n`;
        else [text, held[chunk.stream]] = append(text, held[chunk.stream] ?? '', chunk.data);
      }
      more = answer.value.messages.length >= 64 || exit;
      if (!more) break;
    }
    if (more) api.host.tryCall('events.schedule', { key: exit ? `${live(run)}-exit` : live(run), delay_ms: 50 });
    while (bytes(JSON.stringify(text)) > LIMIT) {
      const cut = text.slice(Math.max(1024, text.length - LIMIT));
      text = cut.slice(cut.indexOf('\n') + 1);
    }
    const next = { ...current, text, status, held: status === 'exited' ? {} : held };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    api.state.set(next);
    api.host.tryCall('terminal.pane', { action: 'scroll', id: 'live_output', offset: Math.max(0, text.split('\n').length - 9) });
  };

  api.on('process_event', ({ session, kind }) => {
    const run = /^live-(\d+)$/.exec(session)?.[1];
    if (run) drain(Number(run), kind === 'exit');
  });

  api.on('timer', ({ key }) => {
    const match = /^live-(\d+)(-exit)?$/.exec(key);
    if (match) drain(Number(match[1]), match[2] !== undefined);
  });

  api.on('terminal', (input): TerminalPatch => {
    if (input.event === 'startup' && output().status === 'running') api.state.set({ ...output(), status: 'stopped' });
    const { command, text, status } = output();
    if (!command) return {};
    return { sites: { above_composer: { components: [
      { type: 'pane', id: 'live_output', label: fit(`${fit(command, 64)} — ${status}`, 128), children: [
        { type: 'code', id: 'live_output_text', label: 'Output', text: text || ' ' },
      ] },
    ] } } };
  });
}
