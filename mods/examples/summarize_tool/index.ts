import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.tool({ name: 'summarize_text', description: 'Summarize a long text in three bullet points with a configured worker route.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }, input => {
    const text = String((input as { text: string }).text).slice(0, 6000);
    return api.host.call('model.complete', { route: String(api.settings.route ?? 'worker'), prompt: `Summarize in three bullets:\n${text}` });
  });
}
