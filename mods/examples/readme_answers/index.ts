import type { ModAPI } from '@oh-my-diff/mod-api';

const head = (text: string, budget: number) => {
  let [used, end] = [0, 0];
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    used += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used > budget) break;
    end += character.length;
  }
  return text.slice(0, end);
};

export default function activate(api: ModAPI) {
  api.tool({ name: 'ask_readme', description: 'Answer a question from the repository README with a configured worker route, reusing the cached README prefix.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } }, input => {
    const readme = api.host.call('workspace.read', { paths: ['README.md'] }).files['README.md'];
    if (!readme) throw new Error('readme_missing');
    const result = api.host.call('model.complete', { route: String(api.settings.route ?? 'worker'), system: 'Answer only from the document; say so when it does not cover the question.',
      context: [head(readme.text, 30_000)], prompt: String((input as { question: string }).question).slice(0, 2000), cache: { through: 0 } });
    return { answer: result.text, cache: result.cache };
  });
}
