import type { ModAPI, TerminalPatch } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('layout', argument => ({ display: `Layout request: ${String(argument)}` }), {
    description: 'Apply an example component value',
  });
  // A patch wraps the sites other mods (such as the default omd_workspace) render, so both stay visible.
  api.on('terminal', ({ event }): TerminalPatch => ({
    title: 'My workspace',
    sidebar_width: 32,
    sites: {
      sidebar: {
        mode: 'wrap',
        components: [{
          type: 'pane', id: 'activity', label: 'Activity pane', title: 'Activity', children: [
            { type: 'text', id: 'latest_event', label: 'Latest event', text: `Latest event: ${event}`, tone: 'accent' },
            { type: 'markdown', id: 'review_help', label: 'Review help', text: '**Review mode** keeps native controls available.' },
            { type: 'code', id: 'review_command', label: 'Review command', text: 'pnpm check', language: 'shell' },
          ],
        }, { type: 'slot' }],
      },
      above_composer: { mode: 'wrap', components: [{ type: 'slot' }, { type: 'text', id: 'shortcut_help', label: 'Shortcut help', text: 'F10 review prompt · Ctrl+Alt+r review', tone: 'muted' }] },
      dialog: {
        mode: 'replace',
        components: [{
          type: 'dialog', id: 'review_dialog', label: 'Review settings', title: 'Review settings', children: [
            { type: 'input', id: 'review_input', label: 'Review prompt', value: 'remaining risks', action: { command: 'terminal:layout', args: 'review' } },
            { type: 'select', id: 'side_select', label: 'Sidebar side', value: 'left', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }], action: { command: 'terminal:layout', args: 'side' } },
            { type: 'button', id: 'copy_shortcuts', label: 'Copy shortcuts', text: 'Copy shortcuts', action: { copy: 'F10 review prompt · Ctrl+Alt+r review', label: 'terminal example shortcuts' } },
          ],
        }],
      },
    },
    status: ['review mode'],
    theme: {
      accent: 81,
      user_message_background: '#1f2a33',
      syntax: 'github',
      success: 78,
      attention: 214,
      failure: '#ff5f5f',
      diff_added: 78,
      diff_removed: '#ff5f5f',
      muted: 244,
      border: 'rounded',
      density: 'compact',
      icons: 'unicode',
    },
    keybindings: {
      F10: { focus: 'review_input' },
      'Ctrl+Alt+r': { submit: 'Review the current changes and list remaining risks.' },
    },
  }));
}
