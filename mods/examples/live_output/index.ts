import type { ModAPI, ProcessChunk, TerminalPatch } from '@oh-my-diff/mod-api';

const LIMIT = 49_152;
type Output = { command: string; text: string; status: string; held?: Record<string, string> };

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

const append = (text: string, held: string, data: string): [string, string] => {
  const input = held + data;
  const tail = input.match(/(\u001b(\[[0-9;?]*[ -/]*)?|\r)$/)?.[0] ?? '';
  const body = input.slice(0, input.length - tail.length).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n');
  return [(text + body).replace(/[^\n]*\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), tail];
};

export default function activate(api: ModAPI) {
  const output = () => (api.state.get() as Output | null) ?? { command: '', text: '', status: 'idle' };

  api.command('run', args => {
    const command = typeof args === 'string' ? args.trim() : '';
    if (!command) return { display: 'Usage: /live_output:run COMMAND' };
    const asked = api.host.tryCall('events.publish', { channel: 'run', data: command });
    return { display: asked.ok ? `Running ${command}` : 'Running is unavailable here' };
  }, { description: 'Run a shell command and stream its output' });

  api.on('channel', ({ channel, data }) => {
    if (channel !== 'live_output/run' || typeof data !== 'string') return;
    api.host.tryCall('process.stop', { session: 'live' });
    const shell = api.host.call('process.which', { names: ['sh'] }).found[0];
    if (!shell) return api.state.set({ command: data, text: '', status: 'cannot find sh' });
    const started = api.host.tryCall('process.start', {
      session: 'live', name: 'sh', path: shell.path, sha256: shell.sha256, arguments: ['-c', data], framing: 'raw', stdin: 'null', notify: ['output', 'exit'],
    });
    api.state.set({ command: data, text: '', status: started.ok ? 'running' : started.error });
  });

  api.on('process_event', ({ session, kind }) => {
    if (session !== 'live') return;
    const current = output();
    let { text, status } = current;
    const held = { ...current.held };
    for (let page = 0; page < 8; page += 1) {
      const answer = api.host.tryCall('process.exchange', { session: 'live', wait_ms: 0 });
      if (!answer.ok) { status = 'exited'; break; }
      for (const chunk of answer.value.messages as ProcessChunk[]) {
        if (chunk.data === undefined) text += `[${decoded(chunk.data_base64 ?? '')} binary bytes]\n`;
        else [text, held[chunk.stream]] = append(text, held[chunk.stream] ?? '', chunk.data);
      }
      if (answer.value.messages.length < 64 && kind !== 'exit') break;
    }
    while (bytes(JSON.stringify(text)) > LIMIT) {
      const cut = text.slice(Math.max(1024, text.length - LIMIT));
      text = cut.slice(cut.indexOf('\n') + 1);
    }
    const next = { ...current, text, status, held: status === 'exited' ? {} : held };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    api.state.set(next);
    api.host.tryCall('terminal.pane', { action: 'scroll', id: 'live_output', offset: Math.max(0, text.split('\n').length - 9) });
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
