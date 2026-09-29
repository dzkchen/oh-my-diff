import type { ModAPI, TerminalPatch, TerminalTheme } from '../../api.d.ts';

const palettes: Record<string, { foreground: number; background: number; theme: TerminalTheme }> = {
  midnight: {
    foreground: 255,
    background: 235,
    theme: { accent: '#80d8ff', success: '#91e6aa', attention: '#ffe08a', failure: '#ff9b9b', diff_added: '#91e6aa', diff_removed: '#ff9b9b', muted: '#b4beca', user_message_background: '#303942', border: 'plain', density: 'comfortable' },
  },
  paper: {
    foreground: 234,
    background: 231,
    theme: { accent: '#005f9e', success: '#176b37', attention: '#805300', failure: '#a21d2b', diff_added: '#176b37', diff_removed: '#a21d2b', muted: '#555d66', user_message_background: '#e8edf1', border: 'plain', density: 'comfortable' },
  },
  contrast: {
    foreground: 231,
    background: 16,
    theme: { accent: '#91dcff', success: '#a5f5a5', attention: '#fff39a', failure: '#ffabab', diff_added: '#a5f5a5', diff_removed: '#ffabab', muted: '#d6d6d6', user_message_background: '#202020', border: 'double', density: 'comfortable' },
  },
};

export default function activate(api: ModAPI) {
  api.on('terminal', (): TerminalPatch => {
    const selected = typeof api.settings.palette === 'string' ? api.settings.palette : 'midnight';
    const palette = palettes[selected] ?? palettes.midnight;
    const icons = api.settings.symbols === 'unicode' ? 'unicode' : 'ascii';
    const glyphs: Record<string, string> = icons === 'unicode' ? { '===': '≡  ', '->': '→ ', '<=': '≤ ' } : {};
    return { foreground: palette.foreground, background: palette.background, theme: { ...palette.theme, icons, glyphs } };
  });
}
