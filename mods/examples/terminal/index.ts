import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.replace('terminal', ({ event }) => ({
    title: 'My workspace', foreground: 81, sidebar_width: 32, sidebar_side: 'left',
    panels: [{ title: 'Activity', lines: [`Latest event: ${event}`, 'F6 drafts and Alt+r submits.'] }],
    header: { title: 'Workspace', lines: ['Review mode'] },
    footer: { title: 'Shortcuts', lines: ['F6 draft · Alt+r review'] },
    status: ['review mode'],
    theme: { accent: 81, user_message_background: '#1f2a33', syntax: 'github', success: 78, attention: 214, failure: '#ff5f5f' },
    keybindings: {
      F6: 'Review the current changes and explain remaining risks.',
      'Alt+r': { submit: 'Review the current changes and list remaining risks.' },
    },
    message_template: '│ {text}', tool_template: '› {text}',
  }));
}
