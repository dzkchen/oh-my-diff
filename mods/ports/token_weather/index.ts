import type { Json, ModAPI, TerminalSpan } from '@oh-my-diff/mod-api';

type Reading = { tokens: number; window: number };
type State = { readings: Reading[]; pending: Reading | null };

const HISTORY = 12;
const BARS = '▁▂▃▄▅▆▇█';
const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: '#e5c07b' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: '#56b6c2' },
  { upTo: 75, icon: '☂', word: 'Showers', color: '#61afef' },
  { upTo: 90, icon: '☇', word: 'Storm', color: '#c678dd' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: '#e06c75' },
] as const;

const short = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k` : String(n);

export default function activate(api: ModAPI) {
  const saved = (): State => ({ readings: [], pending: null, ...(api.state.get() as Partial<State> | null) });
  const save = (state: State) => api.state.set(state as unknown as Json);

  api.on('model_response', response => {
    const context = response.scope.kind === 'main' && !response.scope.agent_id ? api.usage.summarize(response).context : null;
    if (context && context.window > 0) save({ ...saved(), pending: { tokens: context.used, window: context.window } });
  });

  api.on('turn_end', () => {
    const { readings, pending } = saved();
    if (pending) save({ readings: [...readings, pending].slice(-HISTORY), pending: null });
  });

  api.on('terminal', input => {
    const { readings } = saved();
    const now = readings[readings.length - 1];
    if (!now) return null;
    const percent = Math.round((now.tokens / now.window) * 100);
    const forecast = FORECAST.find(band => percent < band.upTo)!;
    const spans: TerminalSpan[] = [
      { text: `${forecast.icon}  ${forecast.word}`, bold: true, fg: forecast.color },
      { text: `  ${percent}% of context` },
      { text: `  ${short(now.tokens)} / ${short(now.window)}`, tone: 'muted' },
    ];
    if ((input.client?.columns ?? 80) >= 60) {
      const top = Math.max(...readings.map(r => r.tokens), 1);
      const delta = readings.length > 1 ? now.tokens - readings[readings.length - 2]!.tokens : 0;
      spans.push({ text: '   last turns ', tone: 'muted' });
      spans.push({ text: readings.map(r => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))]).join(''), fg: forecast.color });
      if (readings.length > 1) spans.push({ text: delta > 0 ? `  ▲ +${short(delta)} last turn` : delta < 0 ? `  ▼ ${short(-delta)} last turn` : '  steady', tone: 'muted' });
    }
    return { sites: { above_composer: { mode: 'wrap', components: [{ type: 'slot' }, { type: 'line', id: 'token_weather_line', label: 'Context forecast', spans }] } } };
  });
}
