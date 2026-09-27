import type { ModAPI, TerminalView } from '@oh-my-diff/mod-api/0.1';

export default function activate(api: ModAPI) {
  api.command('layout', argument => ({ display: `Layout request: ${String(argument)}` }), {
    description: 'Apply an example component value',
  });
  api.replace('terminal', ({ event }) => {
    const view: TerminalView = {
      title: 'My workspace',
      foreground: 81,
      sidebar_width: 32,
      sidebar_side: 'left',
      sites: {
        sidebar: {
          components: [{
            type: 'pane', id: 'activity', label: 'Activity pane', title: 'Activity', children: [
              { type: 'text', id: 'latest_event', label: 'Latest event', text: `Latest event: ${event}`, tone: 'accent' },
              { type: 'markdown', id: 'review_help', label: 'Review help', text: '**Review mode** keeps native controls available.' },
              { type: 'code', id: 'review_command', label: 'Review command', text: 'pnpm check', language: 'shell' },
            ],
          }],
        },
        header: { components: [{ type: 'text', id: 'workspace_header', label: 'Workspace header', text: 'Review mode' }] },
        above_composer: { components: [{ type: 'text', id: 'shortcut_help', label: 'Shortcut help', text: 'F6 draft · Alt+r review · F8 settings', tone: 'muted' }] },
        dialog: {
          components: [{
            type: 'dialog', id: 'review_dialog', label: 'Review settings', title: 'Review settings', children: [
              { type: 'input', id: 'review_input', label: 'Review prompt', value: 'remaining risks', action: { command: 'terminal:layout', args: 'review' } },
              { type: 'select', id: 'side_select', label: 'Sidebar side', value: 'left', options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }], action: { command: 'terminal:layout', args: 'side' } },
              { type: 'button', id: 'copy_shortcuts', label: 'Copy shortcuts', text: 'Copy shortcuts', action: { copy: 'F6 draft · Alt+r review · F8 settings', label: 'terminal example shortcuts' } },
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
        F6: 'Review the current changes and explain remaining risks.',
        F8: { focus: 'review_input' },
        'Alt+r': { submit: 'Review the current changes and list remaining risks.' },
      },
      message_template: '│ {text}',
      tool_template: '› {text}',
    };
    return view;
  });
}
