import type { ModAPI, TerminalPatch } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  const compact = () => api.state.get() !== false;

  api.command('toggle', () => {
    const next = !compact();
    api.state.set(next);
    return { display: `Completed agent tools: ${next ? 'compact' : 'expanded'}. Active work, failures, prompts, evidence and recovery stay visible.` };
  }, { description: 'Toggle compact completed agent tools' });

  api.on('terminal', (): TerminalPatch => ({
    completed_tools: compact() ? 'compact' : 'normal',
    keybindings: { F9: { command: 'omd_focus_flow:toggle' } },
  }));
}
