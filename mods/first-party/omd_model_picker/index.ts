import type { ModAPI, TerminalComponent, TerminalListEvent, TerminalListRow, TerminalTone } from '../../api.d.ts';

export default function activate(api: ModAPI) {
  if (api.settings.layout === 'native') return;
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const brand = typeof api.settings.brand === 'string' ? clean(api.settings.brand).slice(0, 24) : 'oh my diff';
  const shorten = (value: string, limit: number) => {
    const text = Array.from(clean(value));
    return text.length <= limit ? text.join('') : `${text.slice(0, Math.max(1, limit - 1)).join('')}…`;
  };
  api.replace('list', (event: TerminalListEvent): TerminalComponent[] | null => {
    if (!['model', 'reasoning', 'advanced_reasoning'].includes(event.view_id) || event.items.length > 200 || event.width < 20) return null;
    const narrow = event.width < 72;
    const width = Math.min(256, event.width);
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
    return components;
  });
}
