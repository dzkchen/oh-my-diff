import type { ModAPI } from '../../api.d.ts';

// Suggests the rest of a recent prompt that starts with the current draft.
export default function activate(api: ModAPI) {
  const recent = api.atom<string[]>('recent', []);
  api.middleware('prompt', event => {
    recent.update(list => [event.effective, ...list.filter(text => text !== event.effective)].slice(0, 20));
  });
  api.on('composer', event => {
    if (event.kind !== 'change' || event.origin === api.package.id) return;
    const draft = api.host.call('composer.read', null);
    const match = draft.text.length >= 3 && recent.get().find(text => text.length > draft.text.length && text.startsWith(draft.text));
    if (match) api.host.tryCall('composer.suggest', { revision: draft.revision, id: `h${draft.revision}`, text: match.slice(draft.text.length) });
  });
}
