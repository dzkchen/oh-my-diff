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
    const side = [
      [span('oh my diff', 'normal', true)],
      [span(`${profile ?? 'Oh My Diff'} ${dot} OMD enabled`, 'muted')],
      [span(`Codex ${identity ? `v${identity.codex_version}` : 'version unknown'} ${dot} ${identity?.mods.active ?? 0} of ${identity?.mods.installed ?? 0} mods active`, 'muted')],
    ];
    const rows = (id: string, wide: boolean): TerminalComponent[] => mark.map((text, index) => ({
      type: 'line', id: `${id}_${index + 1}`, label: index === 0 ? 'Oh My Diff' : text,
      spans: [span('+ ', 'success'), span(text, 'success'), ...(wide ? [span('   '), ...side[index]] : [])],
    }));
    return {
      greeting: '',
      ...(profile ? { session_title_suffix: ` | ${profile}` } : {}),
      welcome: { show_while_composing: true },
      sites: input.presentation?.phase === 'fresh' ? {
        welcome: { mode: 'replace', components: [
          { type: 'box', id: 'omd_logo_mark', label: 'Oh My Diff logo', min_width: 60, children: rows('omd_logo_wide', true) },
          { type: 'box', id: 'omd_logo_narrow', label: 'Oh My Diff logo', min_width: 15, max_width: 59, children: rows('omd_logo_small', false) },
          { type: 'box', id: 'omd_logo_plain', label: 'Oh My Diff', max_width: 14, children: [{ type: 'text', id: 'omd_logo_text', label: 'Oh My Diff', text: 'OMD' }] },
        ] },
      } : {},
    };
  });
}
