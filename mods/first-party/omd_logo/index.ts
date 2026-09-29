import type { ModAPI, TerminalComponent, TerminalIdentity, TerminalPatch, TerminalTone } from '../../api.d.ts';

const MARK = ['╭─╮ ╭╮╭╮ ┌─╮', '│ │ │╰╯│ │ │', '╰─╯ ╵  ╵ └─╯'];
const MARK_ASCII = ['.-. |\\/| |-.', '| | |  | | |', "'-' |  | |-'"];
const PROFILES: Record<string, [string, string]> = {
  full: ['Full OMD', 'Full'],
  platform_only: ['Modding platform only', 'Platform'],
  private: ['Private foundation', 'Private'],
};
const MODES: Record<string, [string, string]> = {
  omd: ['OMD enabled', 'enabled'],
};

export default function activate(api: ModAPI) {
  const span = (text: string, tone: TerminalTone = 'normal', bold = false) => ({ text, tone, bold });

  const view = (identity: TerminalIdentity | undefined, settled: boolean): TerminalPatch => {
    const ascii = api.settings.icons === 'ascii';
    const dot = ascii ? '-' : '·';
    const mark = ascii ? MARK_ASCII : MARK;
    const profile = identity?.install_profile ?? 'unreported';
    const mode = identity?.mode ?? '';
    const version = identity?.codex_version;
    const active = identity?.mods?.active ?? 0;
    const installed = identity?.mods?.installed ?? 0;
    const [profileLong, profileShort] = PROFILES[profile] ?? ['Oh My Diff', 'OMD'];
    const [modeLong, modeShort] = MODES[mode] ?? ['mod host', 'mods'];
    const release = typeof version === 'string' ? `v${version}` : 'version unknown';
    const counts = profile === 'platform_only'
      ? `${active} ${active === 1 ? 'mod' : 'mods'} active`
      : `${active} of ${installed} mods active`;
    const compact = (id: string, long: boolean): TerminalComponent => {
      const status = long ? `${profileLong} ${dot} ${modeLong} ${dot} ${release}` : `${profileShort} ${dot} ${modeShort} ${dot} ${release}`;
      return {
        type: 'box', id, label: 'Oh My Diff status', ...(long ? { min_width: 60 } : { max_width: 59 }),
        children: [{
          type: 'line', id: `${id}_line`, label: `Oh My Diff, ${status}`,
          spans: [span(ascii ? '+-' : '±', 'success'), span(' '), span('omd', 'normal', true), span(`  ${status}`, 'muted')],
        }],
      };
    };
    const rows = [
      [span('oh my diff', 'normal', true)],
      [span(`${profileLong} ${dot} ${modeLong}`, 'muted')],
      [span(`Codex ${release} ${dot} ${counts}`, 'muted')],
    ];
    const components: TerminalComponent[] = settled ? [compact('omd_logo_after_turn', true)] : [
      {
        type: 'box', id: 'omd_logo_mark', label: 'Oh My Diff logo', min_width: 60,
        children: rows.map((side, index) => ({
          type: 'line' as const,
          id: `omd_logo_mark_${index + 1}`,
          label: index === 0 ? 'Oh My Diff' : side.map(part => part.text).join(''),
          spans: [span('+ ', 'success'), span(mark[index], 'success'), span('   '), ...side],
        })),
      },
      compact('omd_logo_narrow', false),
    ];
    return { sites: { header: { mode: 'wrap', components: [...components, { type: 'slot' }] } } };
  };

  api.on('terminal', input => {
    const stored = api.state.get();
    const settled = stored !== null && typeof stored === 'object' && !Array.isArray(stored) && stored.settled === true;
    if (input.event === 'start' && settled) api.state.set({ settled: false });
    if (input.event === 'turn_end' && !settled) api.state.set({ settled: true });
    return view(input.identity, input.event === 'start' ? false : settled || input.event === 'turn_end');
  });
}
