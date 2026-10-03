import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Cache = Record<string, string>;

export default function activate(api: ModAPI) {
  api.intercept('tool', { match: { tool: 'view_image' } }, async (e, next) => {
    const key = JSON.stringify(e.arguments);
    const cache = (api.state.get() as Cache | null) ?? {};
    if (cache[key]) return { output: cache[key], success: true };
    const result = await next(e);
    if (result.success && !result.truncated) api.state.set({ ...cache, [key]: result.output } as Json);
    return result;
  });

  api.intercept('tool', { match: { tool: 'exec_command', arguments: { cmd: /\bgit\s+push\b/ } } }, async (e, next) => {
    const check = api.host.call('tools.check', { tool: e.tool, arguments: e.arguments });
    if (check.decision === 'deny') return { deny: check.reason ?? 'command policy forbids this push' };
    const answer = api.host.call('terminal.prompt', { kind: 'confirm', title: 'Push?', message: String((e.arguments as { cmd: string }).cmd) });
    return answer.status === 'accepted' ? next(e) : { deny: 'push declined' };
  });

  api.intercept('tool', { match: { tool: 'exec_command', arguments: { cmd: /^(cargo|pnpm) / } } }, async (e, next) => {
    const first = await next(e);
    if (first.success && !/Exit code: [1-9]/.test(first.output)) return first;
    return next(e);
  });
}
