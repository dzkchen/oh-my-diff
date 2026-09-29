import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('recap', note => {
    const { turns, recording } = api.host.call('turns.activity', { last: 1 });
    if (!recording || turns.length === 0) return { display: 'No recorded turn activity yet.' };
    const turn = turns[0];
    const pending = turn.tool_calls.filter(call => call.finished_at === null).map(call => call.tool);
    const summary = `Last turn ${turn.outcome}; unfinished tools: ${pending.join(', ') || 'none'}; files: ${turn.files.length}.`;
    return { submit: `Continue where you stopped. ${summary}${typeof note === 'string' && note ? ` Note: ${note}` : ''}` };
  }, { description: 'Resume after an interrupted turn' });
}
