import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.tool({ name: 'ask_readme', description: 'Answer a question from the repository README with a configured worker route, reusing the cached README prefix.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } }, input => {
    const readme = api.host.call('workspace.read', { paths: ['README.md'] }).files['README.md'];
    if (!readme) throw new Error('readme_missing');
    const result = api.host.call('model.complete', { route: String(api.settings.route ?? 'worker'), system: 'Answer only from the document; say so when it does not cover the question.',
      context: [readme.text.slice(0, 24_000)], prompt: String((input as { question: string }).question).slice(0, 2000), cache: { through: 0 } });
    return { answer: result.text, cache: result.cache };
  });
}
