import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.intercept('input', { required: true }, (e, next) => {
    if (/(?:sk|ghp)_[A-Za-z0-9]{16,}/.test(e.text)) return { deny: 'the prompt appears to contain a credential' };
    return next(e.text.startsWith('@@review ') ? { ...e, text: `Review ${e.text.slice(9)} and list correctness risks before style issues.` } : e);
  });
  api.on('turn_start', ({ turn_id }) => api.state.set({ ...Object(api.state.get()), last_turn: turn_id }));
  api.on('turn_end', ({ outcome }) => {
    const state = Object(api.state.get());
    api.state.set({ ...state, outcomes: [...(Array.isArray(state.outcomes) ? state.outcomes : []), outcome].slice(-16) });
  });
}
