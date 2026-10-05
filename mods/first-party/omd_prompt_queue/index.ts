import type { Json, ModAPI, ResourceRef } from '../../api.d.ts';

type Status = 'queued' | 'sent' | 'failed' | 'needs_consent';
type Entry = { id: string; text: string; attachments: ResourceRef[]; consent: string | null; status: Status; client_id: string | null; reason: string | null; attempts: number };
type Queue = { entries: Entry[]; paused: string | null; serial: number };

const LIMIT = 32;
const USAGE = 'usage: /queue [add TEXT | edit N TEXT | move N M | remove N | join N M | send N | retry N | pause | resume]; Alt+q queues the draft';

export default function activate(api: ModAPI) {
  const load = (): Queue => ({ entries: [], paused: null, serial: 0, ...(api.state.get() as Partial<Queue> | null) });
  const save = (queue: Queue) => api.state.set(queue as unknown as Json);
  const consent = (text: string, attachments: ResourceRef[]) => api.host.tryCall('prompts.consent', { text, attachments });
  const revoke = (entry: Entry) => { if (entry.consent) api.host.tryCall('prompts.revoke', { consent: entry.consent }); };
  const pick = (queue: Queue, value: string | undefined) => {
    const index = Number(value) - 1;
    return Number.isInteger(index) && index >= 0 && index < queue.entries.length ? index : -1;
  };
  const line = (entry: Entry, index: number) =>
    `${index + 1}. [${entry.status}${entry.reason ? `: ${entry.reason}` : ''}] ${entry.text.replace(/\s+/g, ' ').slice(0, 80)}${entry.attachments.length ? ` (+${entry.attachments.length} image)` : ''}`;
  const listing = (queue: Queue) => queue.entries.length
    ? [`Queued prompts (yours, sent as you)${queue.paused ? `, paused: ${queue.paused}` : ''}:`, ...queue.entries.map(line)].join('\n')
    : 'The prompt queue is empty.';

  // A consented entry: the host keeps the consent, the queue keeps the content it covers.
  const grant = (queue: Queue, text: string, attachments: ResourceRef[], previous?: Entry): Entry | string => {
    const granted = consent(text, attachments);
    if (!granted.ok) return granted.error;
    if (previous) revoke(previous);
    queue.serial += 1;
    return { id: previous?.id ?? `q${queue.serial}`, text, attachments, consent: granted.value.consent, status: 'queued', client_id: null, reason: null, attempts: previous?.attempts ?? 0 };
  };

  // Settles an entry the host may have submitted; a delivered one leaves the queue.
  const reconcile = (queue: Queue, entry: Entry) => {
    if (!entry.consent) return;
    const found = api.host.tryCall('prompts.status', { consent: entry.consent });
    if (!found.ok) return;
    const state = found.value.state;
    if (state === 'delivered') queue.entries = queue.entries.filter(item => item !== entry);
    else if (state === 'missing') Object.assign(entry, { status: 'needs_consent', consent: null, reason: 'not consented in this thread; /queue retry' });
    else if (state === 'unconfirmed' && entry.status !== 'sent') Object.assign(entry, { status: 'failed', reason: 'delivery unconfirmed; /queue retry to send again' });
  };

  const submit = (queue: Queue, entry: Entry, mode: 'turn' | 'steer') => {
    entry.attempts += 1;
    const client = `${entry.id}-${entry.attempts}`;
    const sent = api.host.tryCall('prompts.submit', { consent: entry.consent ?? '', text: entry.text, attachments: entry.attachments, mode, client_id: client });
    if (!sent.ok) {
      if (/consent_spent/.test(sent.error)) return reconcile(queue, entry);
      Object.assign(entry, { status: /consent_(missing|content_changed)/.test(sent.error) ? 'needs_consent' : 'failed', reason: sent.error.slice(0, 120) });
      return;
    }
    if (sent.value.status === 'not_submitted') {
      if (sent.value.reason !== 'busy') Object.assign(entry, { status: 'failed', reason: sent.value.reason });
      return;
    }
    Object.assign(entry, { status: 'sent', client_id: sent.value.client_id, reason: null });
  };

  const drain = () => {
    const queue = load();
    for (const entry of queue.entries.filter(item => item.status === 'sent')) reconcile(queue, entry);
    const head = queue.entries.find(item => item.status === 'queued');
    if (!queue.paused && head && !queue.entries.some(item => item.status === 'sent')) submit(queue, head, 'turn');
    save(queue);
  };

  api.on('idle', drain);
  api.on('turn_start', () => {
    const queue = load();
    for (const entry of queue.entries.filter(item => item.status === 'sent')) reconcile(queue, entry);
    save(queue);
  });
  api.on('turn_end', event => {
    if (event.outcome !== 'aborted') return;
    const queue = load();
    if (!queue.entries.length) return;
    for (const entry of queue.entries.filter(item => item.status === 'sent')) {
      reconcile(queue, entry);
      if (entry.status === 'sent') Object.assign(entry, { status: 'failed', reason: 'turn stopped before delivery was confirmed; /queue retry' });
    }
    save({ ...queue, paused: 'the turn was stopped; /queue resume' });
  });
  api.on('terminal', () => {
    const queue = load();
    const keybindings = { 'Alt+q': { command: 'queue', args: 'capture' } };
    if (!queue.entries.length) return { keybindings };
    const failed = queue.entries.filter(item => item.status === 'failed' || item.status === 'needs_consent').length;
    return { keybindings, status: [`queue ${queue.entries.length}${queue.paused ? ' paused' : ''}${failed ? ` ${failed} need you` : ''}`] };
  });

  api.command('queue', value => {
    const args = typeof value === 'string' ? value.trim() : '';
    const [verb = '', first, second] = args.split(/\s+/);
    const rest = (count: number) => args.split(/\s+/).slice(count).join(' ').trim();
    const queue = load();
    const done = (display: string) => { save(queue); return { display }; };
    if (verb === '' || verb === 'list') return { display: listing(queue) };
    if (verb === 'capture' || verb === 'add') {
      if (queue.entries.length >= LIMIT) return { display: `The queue holds at most ${LIMIT} prompts.` };
      let text = rest(1);
      let attachments: ResourceRef[] = [];
      let clear: number | null = null;
      if (verb === 'capture') {
        const draft = api.host.tryCall('composer.read', null);
        if (!draft.ok) return { display: `Cannot read the draft: ${draft.error}` };
        text = draft.value.text.trim();
        attachments = draft.value.attachments.flatMap(item => item.resource ? [item.resource] : []);
        clear = draft.value.revision;
      }
      if (!text) return { display: `Nothing to queue. ${USAGE}` };
      const entry = grant(queue, text, attachments);
      if (typeof entry === 'string') return { display: `Not queued: ${entry}` };
      if (clear !== null) {
        const cleared = api.host.tryCall('composer.write', { revision: clear, edit: { kind: 'fill', text: '' } });
        if (!cleared.ok) {
          revoke(entry);
          return { display: `Not queued: the draft changed while it was captured (${cleared.error}); try again.` };
        }
      }
      queue.entries.push(entry);
      const display = done(`Queued as #${queue.entries.length}${queue.paused ? ' (the queue is paused; /queue resume)' : ''}.`);
      drain();
      return display;
    }
    if (verb === 'pause') return done((queue.paused = 'paused by you', 'Queue paused.'));
    if (verb === 'resume') {
      queue.paused = null;
      save(queue);
      drain();
      return { display: 'Queue resumed; the next prompt is sent when the session is idle.' };
    }
    const index = pick(queue, first);
    if (index < 0) return { display: USAGE };
    const entry = queue.entries[index];
    if (verb === 'remove') {
      revoke(entry);
      queue.entries.splice(index, 1);
      return done(`Removed #${index + 1}.`);
    }
    if (verb === 'move') {
      const target = pick(queue, second);
      if (target < 0) return { display: USAGE };
      queue.entries.splice(target, 0, ...queue.entries.splice(index, 1));
      return done(`Moved #${index + 1} to #${target + 1}.`);
    }
    if (entry.status === 'sent') return { display: `#${index + 1} was sent; it leaves the queue once delivered.` };
    if (verb === 'edit' || verb === 'retry') {
      const text = verb === 'edit' ? rest(2) : entry.text;
      if (!text) return { display: USAGE };
      const updated = grant(queue, text, entry.attachments, entry);
      if (typeof updated === 'string') return { display: `Not changed: ${updated}` };
      queue.entries[index] = updated;
      return done(`#${index + 1} ${verb === 'edit' ? 'updated' : 'will be sent again'}.`);
    }
    if (verb === 'join') {
      const other = pick(queue, second);
      if (other < 0 || other === index || queue.entries[other].status === 'sent') return { display: USAGE };
      const joined = grant(queue, `${entry.text}\n\n${queue.entries[other].text}`, [...entry.attachments, ...queue.entries[other].attachments].slice(0, 8), entry);
      if (typeof joined === 'string') return { display: `Not joined: ${joined}` };
      revoke(queue.entries[other]);
      queue.entries[index] = joined;
      queue.entries.splice(other, 1);
      return done(`Joined into #${Math.min(index, other) + 1}.`);
    }
    if (verb === 'send') {
      if (entry.status !== 'queued') return { display: `#${index + 1} needs /queue retry first.` };
      submit(queue, entry, 'turn');
      if (entry.status === 'queued') submit(queue, entry, 'steer');
      return done((entry.status as Status) === 'sent' ? `#${index + 1} sent.` : `#${index + 1} was not sent: ${entry.reason ?? 'try again'}`);
    }
    return { display: USAGE };
  }, { description: 'Queue prompts to send as you, in order, when the session is idle', args_hint: 'add|list|edit|move|remove|join|send|retry|pause|resume' });
}
