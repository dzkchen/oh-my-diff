import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('note', () => {
    const note = api.host.call('terminal.prompt', { kind: 'text', title: 'Note', message: 'Text to send with the next turn' });
    if (note.status !== 'accepted' || !note.value) return { display: 'No note' };
    const confirmed = api.host.call('terminal.prompt', { kind: 'confirm', title: 'Send note?', message: note.value });
    return confirmed.status === 'accepted' ? { submit: note.value } : { display: 'Not sent' };
  });
}
