import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.replace('input', ({ text }) => {
    if (/(?:sk|ghp)_[A-Za-z0-9]{16,}/.test(text)) return { deny: 'the prompt appears to contain a credential' };
    if (text.startsWith('@@review ')) return { text: `Review ${text.slice(9)} and list correctness risks before style issues.` };
    return null;
  });
  api.on('turn_start', ({ turn_id }) => api.state.set({ ...Object(api.state.get()), last_turn: turn_id }));
  api.on('turn_end', ({ outcome }) => {
    const state = Object(api.state.get());
    api.state.set({ ...state, outcomes: [...(Array.isArray(state.outcomes) ? state.outcomes : []), outcome].slice(-16) });
  });
}
