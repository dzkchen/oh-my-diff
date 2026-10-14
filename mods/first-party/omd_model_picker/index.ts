import type { ModAPI, RenderEvent, TerminalComponent, TerminalListRow, TerminalTone } from '../../api.d.ts';

type Profiles = { profiles?: { name: string; model: string; billing: string; available: boolean }[]; current?: string | null };

export default function activate(api: ModAPI) {
  if (api.settings.layout === 'native') return;
  api.on('channel', ({ channel, data }) => {
    if (channel === 'omd_profiles/routes') api.state.set(data);
  });
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const brand = typeof api.settings.brand === 'string' ? [...clean(api.settings.brand)].slice(0, 24).join('') : 'oh my diff';
  const shorten = (value: string, limit: number) => {
    const text = Array.from(clean(value));
    const size = (chars: string[]) => chars.reduce((sum, char) => {
      const code = char.codePointAt(0) ?? 0;
      return sum + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);
    }, 0);
    if (text.length <= limit && size(text) <= 256) return text.join('');
    const kept = text.slice(0, Math.max(1, limit - 1));
    while (size(kept) > 253) kept.pop();
    return `${kept.join('')}…`;
  };
  api.intercept('render', { match: { component: 'list' } }, (input, next) => {
    const { props: event, viewport } = input as RenderEvent<'list'>;
    if (!['model', 'reasoning', 'advanced_reasoning'].includes(event.view_id) || event.items.length > 200 || viewport.columns < 20) return next(input);
    const narrow = viewport.columns < 72;
    const width = Math.min(256, viewport.columns);
    const title = `${brand ? `${brand} · ` : ''}${clean(event.title)}`;
    const rows: TerminalListRow[] = event.items.map(item => {
      const tag = item.disabled ? ' · unavailable' : item.current ? ' · current' : '';
      const description = !narrow && item.description ? ` · ${clean(item.description)}` : '';
      const label = shorten(item.label, Math.max(8, width - 8 - tag.length));
      const tone: TerminalTone = item.disabled ? 'muted' : item.current ? 'accent' : 'normal';
      return { value: String(item.order), label, spans: [{ text: shorten(`${label}${tag}${description}`, Math.max(8, width - 4)), tone }] };
    });
    const selected = event.selected === null ? undefined : rows.find(row => row.value === String(event.selected))?.value;
    const components: TerminalComponent[] = [
      { type: 'text', id: 'omd_picker_title', label: event.title, text: shorten(title, width - 2), tone: 'accent' },
      { type: 'list', id: 'omd_picker_choices', label: 'Picker choices', rows, selected, height: Math.min(8, Math.max(1, rows.length)), action: { command: 'model' } },
      { type: 'text', id: 'omd_picker_hints', label: 'Picker controls', text: narrow ? 'up/down · enter · esc' : 'up/down move · enter select · esc close', tone: 'muted' },
    ];
    if (!narrow && event.subtitle) components.splice(1, 0, { type: 'text', id: 'omd_picker_subtitle', label: 'Picker help', text: shorten(event.subtitle, width - 2), tone: 'muted' });
    const { profiles = [], current = null } = (api.state.get() ?? {}) as Profiles;
    if (event.view_id === 'model' && profiles.length) components.splice(-1, 0,
      { type: 'text', id: 'omd_picker_profiles_title', label: 'Profiles', text: 'profiles · /profile use NAME switches this thread at its next turn', tone: 'muted' },
      ...profiles.slice(0, 4).map((profile, index): TerminalComponent => ({ type: 'text', id: `omd_picker_profile_${index}`, label: `Profile ${profile.name}`,
        text: shorten(`${profile.name === current ? '●' : '○'} ${profile.name} · ${profile.model}${profile.billing === 'included_subscription' ? '' : ' · paid'}`, Math.max(8, width - 4)),
        tone: profile.name === current ? 'accent' : profile.available ? 'normal' : 'muted' })));
    return { tree: components };
  });
}
