import type { ModAPI } from '@oh-my-diff/mod-api';

const LIMIT = 4000;

export default function activate(api: ModAPI) {
  api.intercept('tool', async (e, next) => {
    const result = await next(e);
    if (result.output.length <= LIMIT && !result.truncated) return result;
    const folded = `${result.output.slice(0, LIMIT / 2)}\n… output folded; the host keeps the original …\n${result.output.slice(-LIMIT / 4)}`;
    return { ...result, output: folded };
  });
}
