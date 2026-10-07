import type { Json, ModAPI, TerminalSpan } from '../../api.d.ts';

type Board = { id: number; seed: number; mines: number[]; revealed: number[]; flags: number[]; first: number | null; result: 'ready' | 'playing' | 'won' | 'lost'; elapsed_ms: number };
type Game = { serial: number; revision: number; board: Board; best: number | null; wins: number; cursor: number; open: boolean; focused: boolean; paused: boolean; clock: string | null; at: number | null; generation: number | null; ticks: number; last: number | null };
type Intent = { action: string; token?: string; board?: number; cell?: number; seed?: number; dx?: number; dy?: number; keys?: Intent[] };
const CHANNEL = 'omd_minefield/play';
const DOC = 'minefield_board';
const neighbours = (cell: number) => {
  const out: number[] = [];
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const col = cell % 9 + x, row = Math.floor(cell / 9) + y;
    if ((x || y) && col >= 0 && col < 9 && row >= 0 && row < 9) out.push(row * 9 + col);
  }
  return out;
};
const board = (id: number, seed: number): Board => ({ id, seed, mines: [], revealed: [], flags: [], first: null, result: 'ready', elapsed_ms: 0 });
const initial = (): Game => ({ serial: 1, revision: 0, board: board(1, 1), best: null, wins: 0, cursor: 40, open: false, focused: false, paused: true, clock: null, at: null, generation: null, ticks: 0, last: null });
const token = (game: Game) => `${game.board.id}_${game.revision}`;
const number = (value: number | undefined) => Number.isInteger(value) && value! >= 0 && value! < 81;
const count = (game: Board, cell: number) => neighbours(cell).filter(item => game.mines.includes(item)).length;
const generate = (game: Board, first: number) => {
  const safe = new Set([first, ...neighbours(first)]);
  const candidates = Array.from({ length: 81 }, (_, cell) => cell).filter(cell => !safe.has(cell));
  let seed = game.seed;
  for (let index = candidates.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
  }
  game.mines = candidates.slice(0, 10).sort((a, b) => a - b);
  game.first = first;
  game.result = 'playing';
};
const reveal = (game: Board, cells: number[]) => {
  const queue = cells.slice();
  while (queue.length && game.result === 'playing') {
    const cell = queue.pop()!;
    if (game.flags.includes(cell) || game.revealed.includes(cell)) continue;
    game.revealed.push(cell);
    if (game.mines.includes(cell)) { game.result = 'lost'; break; }
    if (!count(game, cell)) queue.push(...neighbours(cell));
  }
  game.revealed.sort((a, b) => a - b);
  if (game.result === 'playing' && game.revealed.length === 71) game.result = 'won';
};
const glyph = (game: Board, cell: number) => {
  if (game.result === 'lost' && game.mines.includes(cell)) return '*';
  if (game.flags.includes(cell)) return game.result === 'lost' && !game.mines.includes(cell) ? '!' : 'F';
  return game.revealed.includes(cell) ? String(count(game, cell)) : '#';
};

export default function activate(api: ModAPI) {
  const now = Date.now();
  const state = () => api.state.get() as unknown as Game | null;
  const save = (game: Game) => api.state.set(game as unknown as Json);
  const publish = (intent: Intent) => api.host.call('events.publish', { channel: CHANNEL, data: intent as unknown as Json });
  const accrue = (game: Game) => {
    if (game.at !== null && game.open && game.focused && !game.paused && game.board.result === 'playing') game.board.elapsed_ms += Math.max(0, now - game.at);
    game.at = Math.max(now, game.at ?? now);
  };
  const stop = (game: Game) => {
    if (game.clock) api.host.call('events.cancel', { key: game.clock });
    game.clock = null;
    game.generation = null;
    game.at = null;
    game.paused = true;
  };
  const schedule = (game: Game) => {
    if (!game.open || !game.focused || game.paused || game.board.result !== 'playing' || game.clock) return;
    if (game.generation === null) game.generation = api.host.call('packages.list', null).generation;
    if (game.at === null) game.at = now;
    game.clock = `mine-${game.board.id}-${++game.ticks}`;
    api.host.call('events.schedule', { key: game.clock, delay_ms: 1000 });
  };
  const apply = (intent: Intent, sequence: number) => {
    const game = state() ?? initial();
    if (game.last !== null && sequence <= game.last || intent.token !== undefined && intent.token !== token(game) || intent.board !== undefined && intent.board !== game.board.id) return;
    if (game.clock && api.host.call('packages.list', null).generation !== game.generation) { stop(game); game.focused = false; }
    accrue(game);
    game.last = sequence;
    let changed = false;
    for (const item of intent.action === 'keys' ? (intent.keys ?? []).slice(0, 128) : [intent]) {
      const intent = item, action = intent.action;
      if (action === 'new') {
        stop(game);
        game.board = board(++game.serial, intent.seed ?? game.serial);
        game.cursor = 40;
        game.open = true;
        game.focused = false;
      } else if (action === 'open') {
        stop(game);
        game.open = true;
        game.focused = false;
      } else if (!game.open) continue;
      else if (action === 'close') { stop(game); game.open = false; game.focused = false; }
      else if (action === 'pause' || action === 'blur') { stop(game); if (action === 'blur') game.focused = false; }
      else if (action === 'focus' || action === 'resume') {
        game.focused = true;
        if (action === 'resume') game.paused = false;
      } else if (action === 'move') {
        game.cursor = Math.max(0, Math.min(8, Math.floor(game.cursor / 9) + (intent.dy ?? 0))) * 9 + Math.max(0, Math.min(8, game.cursor % 9 + (intent.dx ?? 0)));
      } else if (['reveal', 'flag', 'unflag', 'chord'].includes(action) && number(intent.cell ?? game.cursor) && (game.board.result === 'ready' || game.board.result === 'playing' && !game.paused)) {
        const cell = intent.cell ?? game.cursor;
        game.cursor = cell;
        const b = game.board;
        if (action === 'flag' && !b.revealed.includes(cell) && !b.flags.includes(cell) && b.flags.length < 10) b.flags.push(cell);
        if (action === 'unflag') b.flags = b.flags.filter(item => item !== cell);
        if (action === 'reveal' && !b.flags.includes(cell) && !b.revealed.includes(cell)) {
          if (b.first === null) generate(b, cell);
          reveal(b, [cell]);
          game.focused = true;
          game.paused = false;
        }
        if (action === 'chord' && b.revealed.includes(cell) && count(b, cell) > 0 && neighbours(cell).filter(item => b.flags.includes(item)).length === count(b, cell)) reveal(b, neighbours(cell));
        if (b.result === 'won') { game.wins++; game.best = game.best === null ? b.elapsed_ms : Math.min(game.best, b.elapsed_ms); }
        if (b.result === 'won' || b.result === 'lost') stop(game);
      } else continue;
      if (!['focus', 'blur'].includes(action)) game.revision++;
      changed = true;
    }
    if (!changed) return;
    schedule(game);
    save(game);
  };
  api.on('channel', event => {
    if (event.publisher !== 'omd_minefield' || event.channel !== CHANNEL || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const intent = event.data as unknown as Intent;
    if (typeof intent.action !== 'string' || intent.seed !== undefined && (!Number.isInteger(intent.seed) || intent.seed < 0 || intent.seed > 0xffffffff)) return;
    apply(intent, event.sequence);
  });
  api.command('minefield', args => {
    const words = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const action = words[0] ?? 'open';
    if (action === 'help') return { display: `Minefield: F6 focus, arrows move, Enter/Space reveal, f flag, u unflag, c chord, p pause, r resume, Esc close. /minefield new [SEED], reveal/flag/unflag/chord ROW COL (1–9), pause, resume, close. # covered, F flag, 0 empty, 1–8 adjacent mines, * mine, ! wrong flag. Seed ${(state() ?? initial()).board.seed}.` };
    let intent: Intent = { action };
    if (action === 'new' && words.length <= 2 && (words.length === 1 || /^\d{1,10}$/.test(words[1]) && Number(words[1]) <= 0xffffffff)) intent.seed = words.length === 2 ? Number(words[1]) : undefined;
    else if (['open', 'resume', 'pause', 'close'].includes(action) && words.length <= 1) {}
    else if (['reveal', 'flag', 'unflag', 'chord'].includes(action) && words.length === 3 && /^[1-9]$/.test(words[1]) && /^[1-9]$/.test(words[2])) intent.cell = (Number(words[1]) - 1) * 9 + Number(words[2]) - 1;
    else return { display: 'Use /minefield [new SEED|resume|pause|close|reveal ROW COL|flag ROW COL|unflag ROW COL|chord ROW COL]. Rows and columns: 1–9; seed: 0–4294967295.' };
    intent.token = token(state() ?? initial());
    publish(intent);
    return { display: 'Minefield: F6 focuses the board; Esc closes. f flags, u unflags, c chords; p pauses, r resumes.' };
  }, { description: 'Open Minefield; new SEED, resume, pause, close, reveal/flag/unflag/chord ROW COL', immediate: true });
  const key = (name: string | null, text: string | null | undefined): Intent | null => {
    const action = text?.toLowerCase() || name?.toLowerCase();
    const intent: Intent | null = name === 'Esc' ? { action: 'close' }
      : name === 'Up' ? { action: 'move', dy: -1 } : name === 'Down' ? { action: 'move', dy: 1 }
      : name === 'Left' ? { action: 'move', dx: -1 } : name === 'Right' ? { action: 'move', dx: 1 }
      : name === 'Enter' || name === 'Space' || text === ' ' ? { action: 'reveal' }
      : action === 'f' ? { action: 'flag' } : action === 'u' ? { action: 'unflag' }
      : action === 'c' ? { action: 'chord' } : action === 'p' ? { action: 'pause' } : action === 'r' ? { action: 'resume' } : null;
    return intent;
  };
  api.on('component_event', event => {
    const game = state();
    if (!game?.open) return;
    if (event.component === DOC) {
      if (event.kind === 'focus' || event.kind === 'blur') publish({ action: event.kind, board: game.board.id });
      const keys = event.kind === 'key' ? [key(event.key ?? null, event.text)] : event.kind === 'input' ? (event.events ?? []).map(input => 'key' in input ? key(input.key, input.text) : null) : [];
      if (keys.some(Boolean)) publish({ action: 'keys', board: game.board.id, keys: keys.filter((item): item is Intent => item !== null) });
    }
    const match = /^minefield_hit_(\d+_\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/.exec(event.component);
    if (match && event.kind === 'pointer' && event.pointer?.action === 'down' && ['left', 'right', 'middle'].includes(event.pointer.button ?? '')) {
      const [, expected, firstRow, firstCol, rows, cols] = match;
      const col = Math.floor((event.pointer.column - 5) / 3), row = event.pointer.row;
      if (event.pointer.column < 5 || col < 0 || col >= Number(cols) || row < 0 || row >= Number(rows)) return;
      publish({ action: event.pointer.button === 'left' ? 'reveal' : event.pointer.button === 'right' ? 'flag' : 'chord', token: expected, cell: (Number(firstRow) + row) * 9 + Number(firstCol) + col });
    }
  });
  api.on('timer', event => {
    const game = state();
    if (!game || event.key !== game.clock) return;
    game.clock = null;
    if (!game.open || !game.focused || game.paused || game.board.result !== 'playing') { save(game); return; }
    if (api.host.call('packages.list', null).generation !== game.generation) { stop(game); game.focused = false; save(game); return; }
    accrue(game);
    schedule(game);
    save(game);
  });
  const pause = () => {
    const game = state();
    if (!game || !game.open && !game.clock) return;
    accrue(game);
    stop(game);
    game.focused = false;
    save(game);
  };
  const restart = () => {
    const game = state();
    if (!game) return;
    stop(game);
    game.focused = false;
    game.last = null;
    save(game);
  };
  api.on('start', restart);
  api.on('resume', restart);
  api.on('stop', pause);
  const unfocus = () => { const game = state(); if (game?.open) publish({ action: 'blur', board: game.board.id }); };
  api.on('focus', event => { if (!event.focused) unfocus(); });
  api.on('view', event => { if (event.phase === 'opened') unfocus(); });
  api.on('terminal', event => {
    const game = state();
    if (!game?.open) return null;
    const width = Math.max(1, event.client?.columns ?? 80), height = event.client?.rows ?? 24;
    const cols = Math.max(1, Math.min(9, Math.floor((width - 5) / 3))), rows = 4;
    const firstRow = Math.min(9 - rows, Math.max(0, Math.floor(game.cursor / 9) - rows + 1));
    const firstCol = Math.min(9 - cols, Math.max(0, game.cursor % 9 - cols + 1));
    const lines: TerminalSpan[][] = Array.from({ length: rows }, (_, row) => [{ text: `${firstRow + row + 1} ` }, ...Array.from({ length: cols }, (_, col): TerminalSpan => {
      const cell = (firstRow + row) * 9 + firstCol + col;
      const value = game.paused && game.board.result === 'playing' ? '#' : glyph(game.board, cell);
      return { text: cell === game.cursor ? `[${value}]` : ` ${value} `, bold: cell === game.cursor, tone: cell === game.cursor ? 'accent' : 'normal' };
    })]);
    const cell = `R${Math.floor(game.cursor / 9) + 1} C${game.cursor % 9 + 1}: ${game.paused && game.board.result === 'playing' ? 'paused' : glyph(game.board, game.cursor) === '#' ? 'covered' : glyph(game.board, game.cursor) === 'F' ? 'flagged' : glyph(game.board, game.cursor)}`;
    const text = width < 40 ? [cell, `${game.board.result} F${game.board.flags.length}/10`, `${game.paused ? 'paused' : 'play'} ${Math.floor(game.board.elapsed_ms / 1000)}s`, 'F6 f/u/c p/r Esc'] : [`Minefield ${game.board.result} ${game.paused ? 'paused' : 'playing'}`,
      `${cell}; flags ${game.board.flags.length}/10`,
      `${(game.board.elapsed_ms / 1000).toFixed(1)}s; best ${game.best === null ? '-' : (game.best / 1000).toFixed(1)}s; wins ${game.wins}; seed ${game.board.seed}`,
      'F6 focus; arrows; Enter; f/u/c; p/r; Esc'];
    if (height < 16 || width < 8) text.splice(3, 1, lines[Math.floor(game.cursor / 9) - firstRow].map(span => span.text).join(''), '/minefield help');
    const wrapped = text.flatMap(line => {
      const out: string[] = [];
      for (let offset = 0; offset < line.length; offset += width) out.push(line.slice(offset, offset + width));
      return out;
    });
    return {
      sites: {
        ...(height >= 16 && width >= 8 ? { header: { mode: 'wrap' as const, components: [{ type: 'box' as const, id: `minefield_hit_${token(game)}_${firstRow}_${firstCol}_${rows}_${cols}`, label: 'Minefield board', pointer: true,
          children: [{ type: 'document' as const, id: DOC, label: 'Minefield board; arrows move; Enter reveals; f flags; u unflags; c chords; Escape closes', keys: true, lines, height: rows }] }, { type: 'slot' as const }] } } : {}),
        above_composer: { mode: 'wrap', components: [{ type: 'text', id: 'minefield_status', label: 'Minefield status and keyboard help', text: wrapped.join('\n') }, { type: 'slot' }] },
      },
      ...(height >= 16 && width >= 8 ? { keybindings: { F6: { focus: DOC } } } : {}),
    };
  });
}
