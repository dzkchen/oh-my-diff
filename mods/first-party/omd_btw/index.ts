import type { ModAPI } from '../../api.d.ts';

type Exchange = { question: string; answer: string };

const KEEP = 20;
const SHOW = 5;
const CONTEXT_BYTES = 30_000;
const QUESTION_BYTES = 6_000;
const PICK = 'pick one in /mods, then Btw, then Side question model.';
const SYSTEM = 'The user is asking a side question while the conversation above continues. Answer it briefly from what the conversation already shows. You have no tools in this answer, so never claim to have run, read or changed anything. The question and your answer stay out of the main conversation.';
const encoder = new TextEncoder();

const clip = (text: string, bytes: number) => {
  if (encoder.encode(text).length <= bytes) return text;
  return text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes - 3)).read) + '...';
};

export default function activate(api: ModAPI) {
  const configured = typeof api.settings.route === 'string' ? api.settings.route : '';
  api.builtins({ commands: { replace: { btw: 'aside' } } });

  const history = (): Exchange[] => {
    const value = api.state.get();
    return Array.isArray(value) ? value as Exchange[] : [];
  };

  const earlier = (past: Exchange[]) => {
    const blocks: string[] = [];
    let room = CONTEXT_BYTES;
    for (const { question, answer } of [...past].reverse()) {
      const block = `Side question: ${question}\nYour answer: ${answer}`;
      room -= encoder.encode(block).length + 2;
      if (room < 0) break;
      blocks.unshift(block);
    }
    return blocks.length ? [`Earlier side questions in this thread, oldest first:\n\n${blocks.join('\n\n')}`] : [];
  };

  const show = (past: Exchange[], latest: Exchange) => {
    const before = past.slice(-SHOW).map(item => `  · ${item.question}`);
    return `${before.length ? `Earlier side questions:\n${before.join('\n')}\n\n` : ''}btw: ${latest.question}\n\n${latest.answer}`;
  };

  const panel = (notice = '') => {
    const past = history();
    const shown = api.host.tryCall('terminal.panel', {
      title: 'Side conversation', subtitle: clip(notice || 'Saved in this thread. Select an exchange to read it, or ask a follow-up.', 2000),
      action: { command: 'asidepanel' },
      items: [
        { id: 'ask', kind: 'text', label: 'Ask a follow-up', value: '' },
        ...past.map((entry, index) => ({ id: `exchange:${index}`, kind: 'action' as const, label: clip(entry.question, 128), detail: clip(`You: ${entry.question}\n\nAssistant: ${entry.answer}`, 2000) })).reverse(),
      ],
    });
    return shown.ok ? null : { display: `Could not open /btw: ${shown.error}` };
  };

  api.command('asidepanel', value => {
    const raw = String(value ?? '');
    if (raw.startsWith('ask ')) {
      const result = answer(raw.slice(4));
      return panel(result?.display ?? '');
    }
    const entry = history()[Number(raw.slice('exchange:'.length))];
    if (raw.startsWith('exchange:') && entry) return { display: `You: ${entry.question}\n\nAssistant: ${entry.answer}` };
    return panel();
  }, { description: 'Side conversation panel', immediate: true });

  const answer = (value: unknown) => {
    const question = typeof value === 'string' ? clip(value.trim(), QUESTION_BYTES) : '';
    const past = history();
    if (!question) return panel();
    let route = configured;
    if (!route) {
      const added = api.host.tryCall('routes.add', {});
      if (!added.ok) return { display: `No model for /btw yet (${added.error}): ${PICK}` };
      if ('status' in added.value) return { display: `No model for /btw yet. Run /btw again to allow one, or ${PICK}` };
      route = added.value.route;
    }
    api.host.tryCall('terminal.notice', { id: 'omd_btw', text: 'btw: answering...', placement: 'status', ttl_ms: 60_000 });
    const reply = api.host.tryCall('model.fork', { prompt: question, system: SYSTEM, context: earlier(past), route, timeout_ms: 60_000 });
    api.host.tryCall('terminal.notice', { id: 'omd_btw', placement: 'status', clear: true });
    const text = reply.ok ? reply.value.text.trim() : '';
    let display: string;
    if (!reply.ok || reply.value.status === 'failed' || !text) display = `/btw failed: ${reply.ok ? reply.value.error ?? 'the model returned no answer' : reply.error}`;
    else {
      const answer = text + (reply.value.status === 'incomplete' ? ' (cut off)' : '');
      api.state.set([...past, { question, answer: clip(answer, 8_000) }].slice(-KEEP));
      display = show(past, { question, answer });
    }
    const saved = route === configured || api.host.tryCall('settings.write', { values: { route } });
    return { display: saved === true || saved.ok ? display : `${display}\n\nbtw couldn't save its model (${saved.error}); ${PICK}` };
  };
  api.command('aside', answer, { description: 'Open the saved side conversation or ask a question', args_hint: '[question]', immediate: true });
}
