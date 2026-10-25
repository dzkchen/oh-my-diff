import type { ModAPI, TerminalComponent, TerminalSpan } from '../../api.d.ts';

const MARK = ['╭─╮ ╭╮╭╮ ┌─╮', '│ │ │╰╯│ │ │', '╰─╯ ╵  ╵ └─╯'];
const MARK_ASCII = ['.-. |\\/| |-.', '| | |  | | |', "'-' |  | |-'"];
const PROFILES: Record<string, string> = { full: 'OMD+', platform_only: 'OMD Core' };

export default function activate(api: ModAPI) {
  api.on('terminal', input => {
    const ascii = api.settings.icons === 'ascii';
    const mark = ascii ? MARK_ASCII : MARK;
    const profile = PROFILES[input.identity?.install_profile ?? ''];
    const identity = input.identity;
    const dot = ascii ? '-' : '·';
    const span = (text: string, tone: TerminalSpan['tone'] = 'normal', bold = false): TerminalSpan => ({ text, tone, bold });
    const release = [identity?.omd_version, profile && `${dot} ${profile}`].filter(Boolean).join(' ');
    const title = [span('oh my diff', 'normal', true), ...(release ? [span(` ${release}`, 'muted')] : [])];
    const side = [
      title,
      [span(`Codex ${identity ? `v${identity.codex_version}` : 'version unknown'}`, 'muted')],
      [span(identity ? `${identity.mods.active} of ${identity.mods.installed} mods on` : 'mods loading', 'muted')],
    ];
    // The mark uses the terminal's own foreground so it stays readable on light and dark backgrounds.
    const rows = (id: string, wide: boolean): TerminalComponent[] => mark.map((text, index) => ({
      type: 'line', id: `${id}_${index + 1}`, label: index === 0 ? 'Oh My Diff' : text,
      spans: [span('+ ', 'accent'), span(text, 'normal', true), ...(wide ? [span('   '), ...side[index]] : [])],
    }));
    const line = (id: string, spans: TerminalSpan[]): TerminalComponent => ({ type: 'line', id, label: spans.map(item => item.text).join('').trim(), spans: [span('  '), ...spans] });
    const fit = 2 + [...`oh my diff ${release}`.trim()].length;
    const stacked = [title[0], ...[identity?.omd_version, profile].filter((text): text is string => !!text).map(text => span(text, 'muted'))];
    return {
      greeting: '',
      ...(profile ? { session_title_suffix: ` | ${profile}` } : {}),
      welcome: { show_while_composing: true },
      sites: input.presentation?.phase === 'fresh' ? {
        welcome: { mode: 'replace', components: [
          { type: 'box', id: 'omd_logo_mark', label: 'Oh My Diff logo', min_width: 60, children: rows('omd_logo_wide', true) },
          { type: 'box', id: 'omd_logo_narrow', label: 'Oh My Diff logo', min_width: Math.max(15, fit), max_width: 59, children: [...rows('omd_logo_small', false), line('omd_logo_small_title', title)] },
          ...(fit > 15 ? [{ type: 'box' as const, id: 'omd_logo_stacked', label: 'Oh My Diff logo', min_width: 15, max_width: fit - 1,
            children: [...rows('omd_logo_stacked', false), ...stacked.map((item, index) => line(`omd_logo_stacked_title_${index + 1}`, [item]))] }] : []),
          { type: 'box', id: 'omd_logo_plain', label: 'Oh My Diff', max_width: 14, children: [{ type: 'text', id: 'omd_logo_text', label: 'Oh My Diff', text: 'OMD' }] },
        ] },
      } : {},
    };
  });
}
