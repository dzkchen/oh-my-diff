import type { ComponentKey, ComponentPointer, ModAPI, TerminalComponent, TerminalPatch } from '@oh-my-diff/mod-api';

const W = 24;
const H = 7;
type Game = { paddle: number; ball: { x: number; y: number; dx: number }; score: number; lives: number };

const start = (): Game => ({ paddle: W / 2 - 2, ball: { x: 3, y: 0, dx: 1 }, score: 0, lives: 3 });
const over = (game: Game) => game.lives === 0;
const move = (game: Game, paddle: number): Game => ({ ...game, paddle: Math.max(0, Math.min(W - 4, paddle)) });

function key(game: Game, event: ComponentKey): Game | void {
  const key = event.text ?? event.key;
  if (over(game)) return key === ' ' || key === 'Enter' ? start() : undefined;
  if (key === 'a' || key === 'Left') return move(game, game.paddle - 2);
  if (key === 'd' || key === 'Right') return move(game, game.paddle + 2);
}

function pointer(game: Game, event: ComponentPointer): Game | void {
  if (event.action === 'down' && over(game)) return start();
  if (['down', 'move', 'drag'].includes(event.action)) return move(game, event.column - 2);
}

function tick(game: Game, post: (data: { score: number }) => void): Game {
  if (over(game)) return game;
  let { x, y, dx } = game.ball;
  x += dx;
  if (x <= 0 || x >= W - 1) dx = -dx;
  y += 1;
  if (y < H - 1) return { ...game, ball: { x, y, dx } };
  const ball = { x: (x * 7 + 5) % (W - 2) + 1, y: 0, dx };
  if (x >= game.paddle && x < game.paddle + 4) return { ...game, score: game.score + 1, ball };
  if (game.lives === 1) post({ score: game.score });
  return { ...game, lives: game.lives - 1, ball };
}

function view(game: Game): TerminalComponent {
  const rows = Array.from({ length: H }, (_, row) => Array.from({ length: W }, (_, column) => {
    if (row === H - 1 && column >= game.paddle && column < game.paddle + 4) return '▀';
    return row === game.ball.y && column === game.ball.x ? '●' : '·';
  }).join(''));
  const status = over(game) ? `Game over at ${game.score}. Click or press Space.` : `Score ${game.score}  ·  lives ${game.lives}  ·  a/d or the pointer`;
  return { type: 'text', id: 'board', label: 'Catch board', text: [...rows, status].join('\n') };
}

export default function activate(api: ModAPI) {
  api.component<Game>('catch', {
    init: start,
    key,
    pointer,
    every: { ms: game => over(game) ? null : 120, tick: (game, ui) => tick(game, score => ui.post(score)) },
    view,
  });
  const best = () => Number((api.state.get() as { best?: number } | null)?.best ?? 0);
  api.on('component_post', ({ data }) => {
    const score = Number((data as { score?: number } | null)?.score ?? 0);
    if (score > best()) api.state.set({ best: score });
  });
  api.on('terminal', (): TerminalPatch => ({
    sites: {
      above_composer: { mode: 'wrap', components: [
        { type: 'slot' },
        { type: 'pane', id: 'catch_pane', label: 'Catch', title: `Catch · best ${best()}`, children: [
          { type: 'module', id: 'catch_game', label: 'Catch game', module: 'catch', height: H + 1, keys: true, pointer: true },
        ] },
      ] },
    },
  }));
}
