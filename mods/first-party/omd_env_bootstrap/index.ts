import type { ModAPI } from '../../api.d.ts';
import SNAPSHOT from './snapshot.ts';

const BYTES = 1536;
const TRIES = 2;
const encoder = new TextEncoder();

const clip = (text: string) => {
  if (encoder.encode(text).length <= BYTES) return text;
  const cut = text.slice(0, encoder.encodeInto(text, new Uint8Array(BYTES)).read);
  return cut.slice(0, cut.lastIndexOf('\n') + 1 || cut.length);
};

export default function activate(api: ModAPI) {
  api.intercept('model_request', async (event, next) => {
    const saved = api.state.get();
    let text = saved;
    if (typeof text !== 'string') {
      const failed = typeof saved === 'number' ? saved : 0;
      if (failed >= TRIES) return next(event);
      const run = api.host.tryCall('exec.run', { program: 'sh', argv: ['-s'], stdin: SNAPSHOT, timeout_ms: 3000, max_output_bytes: 8192 });
      const lines = run.ok ? run.value.stdout.split('\n').filter(line => /^[a-z]+(?: \(\d+\))?:\s*\S/.test(line)).join('\n') : '';
      if (!lines) {
        api.state.set(failed + 1);
        return next(event);
      }
      text = clip(`Workspace snapshot taken before the first model request; it is not refreshed, so verify anything your own changes may affect.\n${lines}\n`);
      api.state.set(text);
    }
    const anchor = event.sections.findIndex(section => section.id === 'environments.environment_context');
    const at = anchor >= 0 ? anchor + 1 : event.sections.findIndex(section => section.role === 'user' || section.role === 'developer') + 1;
    const sections = [...event.sections.slice(0, at), { id: 'mod:omd_env_bootstrap' as const, text }, ...event.sections.slice(at)];
    return next({ ...event, sections: sections as typeof event.sections });
  });
}
