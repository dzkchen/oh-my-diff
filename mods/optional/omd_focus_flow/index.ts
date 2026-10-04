import type { ModAPI, RenderEvent, TerminalPatch } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  const compact = () => api.state.get() !== false;

  api.command('toggle', () => {
    const next = !compact();
    api.state.set(next);
    return { display: `Completed agent tools: ${next ? 'compact' : 'expanded'}. Active work, failures, prompts, evidence and recovery stay visible.` };
  }, { description: 'Toggle compact completed agent tools' });

  api.intercept('render', { match: { component: 'command_output', lifecycle: 'final' } }, (event, next) => {
    const { props } = event as RenderEvent<'command_output'>;
    if (!compact() || props.exit_code !== 0 || props.user_shell) return next(event);
    const command = props.command.length > 120 ? `${props.command.slice(0, 119)}…` : props.command;
    return { tree: [{ type: 'line', id: 'focus_flow_compact', label: 'Completed command', spans: [
      { text: `• Ran ${command}`, tone: 'success' }, { text: ` · ${props.output_lines} output lines`, tone: 'muted' }] }] };
  });

  api.on('terminal', (): TerminalPatch => ({
    keybindings: { F9: { command: 'omd_focus_flow:toggle' } },
  }));
}
