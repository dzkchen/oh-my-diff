import type { CommandResult, ComposerDraft, Json, ModAPI, RenderEvent, ResourceRef, TerminalComponent, TerminalRenderSite } from '../../api.d.ts';

const DIR = '.omd/preview';
const TEXT_BYTES = 4_000;
const DIFF_BYTES = 48_000;
const MAX_WATCHES = 8;
const POLL_MS = 2_000;
const MAX_IMAGES = 16;
const SHOWN_IMAGES = 3;
const SOURCE_BYTES = 4_000;
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_ROWS = 200;
const DRAWN_BYTES = 10_000;
const MESSAGE_DIAGRAMS = 4;
const USAGE = 'usage: /preview [N | list | PATH] [--inline] [--watch] | /preview diagrams [N] | /preview image [N] | /preview server [PORT] | /preview unwatch | /preview close';

type Inline = { title: string; kind: string; text: string; source?: string; image?: ResourceRef };
type Picture = { id: string; label: string; owner: string; image: ResourceRef | null };
type State = { inline: Inline | null; revision: number; watch: string[]; hashes: Record<string, string>; images: Picture[] };
type Turn = { items?: { type?: string; text?: string }[] };
type Rendered = { path: string } | { error: string };

// Inline views reject control characters, so line endings, tabs and terminal escapes are normalized first.
const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const clamp = (text: string, limit: number) => {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) return { text: out, cut: true };
    out += char;
  }
  return { text: out, cut: false };
};
const size = (text: string) => { let total = 0; for (const char of text) { const code = char.codePointAt(0) ?? 0; total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; } return total; };
const outputFor = (source: string) => `${DIR}/${source.replace(/[/\\]/g, '__')}.html`;
const inlineKind = (path: string) => {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  return ['diff', 'patch'].includes(extension) ? 'diff' : extension;
};
const pictures = (draft: ComposerDraft): Picture[] => draft.attachments.filter(item => item.kind === 'image').slice(0, MAX_IMAGES)
  .map(item => ({ id: item.id, label: clamp(clean(item.label).replace(/\n/g, ' '), 64).text || 'image', owner: item.owner, image: item.resource }));

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;
const charCells = (char: string) => ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
const cells = (text: string) => { let total = 0; for (const char of text) total += charCells(char); return total; };
const fit = (text: string, max: number) => { let out = '', used = 0; for (const char of text) { const width = charCells(char); if (out && used + width > max) break; out += char; used += width; } return out; };
const wrap = (text: string, max: number) => text.split('\n').flatMap(raw => {
  const lines: string[] = [];
  let line = '';
  for (let word of raw.split(/\s+/).filter(Boolean)) {
    while (cells(word) > max) { if (line) lines.push(line); line = ''; const head = fit(word, max); lines.push(head); word = word.slice(head.length); }
    if (!word) continue;
    if (line && cells(line) + 1 + cells(word) > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  return line || !lines.length ? [...lines, line] : lines;
});
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (raw: string) => fit(raw.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^\x60([\s\S]*)\x60$/, '$1').replace(/<br\s*\/?>/gi, '\n')
  .replace(/[&#]#?(\w{1,8});/g, (all, name: string) => /^\d+$/.test(name) ? Number(name) <= 0x10ffff ? String.fromCodePoint(Number(name)) : all : ENTITIES[name] ?? all)
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ''), 240);
const label = (raw: string) => wrap(decode(raw), 28);

const BOX = ' │─└││┌├─┘─┴┐┤┬┼';
const OPPOSITE = [0, 4, 8, 0, 1, 0, 0, 0, 2];
const glyph = (bits: number, style: string | undefined, unicode: boolean) => {
  const vertical = !(bits & 10), horizontal = !(bits & 5);
  if (!bits) return ' ';
  if (style && (vertical || horizontal)) return (unicode ? style === 'dot' ? '┆┄' : '┃━' : style === 'dot' ? ':.' : '|=')[vertical ? 0 : 1];
  return unicode ? BOX[bits] : vertical ? '|' : horizontal ? '-' : '+';
};
class Canvas {
  chars: string[][] = [];
  links: number[][] = [];
  styles: string[][] = [];
  unicode: boolean;
  constructor(unicode: boolean) { this.unicode = unicode; }
  grow(y: number) {
    if (y < 0 || y >= MAX_ROWS) throw new Error(`it is taller than ${MAX_ROWS} rows`);
    while (this.chars.length <= y) { this.chars.push([]); this.links.push([]); this.styles.push([]); }
  }
  text(x: number, y: number, text: string) {
    this.grow(y);
    const row = this.chars[y];
    for (const char of text) {
      const width = charCells(char);
      if (!width) { let at = x - 1; while (at > 0 && row[at] === '') at--; if (at >= 0) row[at] = (row[at] ?? ' ') + char; continue; }
      row[x] = char;
      if (width === 2) row[x + 1] = '';
      x += width;
    }
  }
  link(x: number, y: number, bits: number, style: string) { this.grow(y); this.links[y][x] = (this.links[y][x] ?? 0) | bits; if (style) this.styles[y][x] = style; }
  path(points: number[][], style: string) {
    const cellsOnPath: number[][] = [points[0]];
    for (let index = 1; index < points.length; index++) {
      const [x0, y0] = points[index - 1], [x1, y1] = points[index];
      for (let step = 1; step <= Math.abs(x1 - x0) + Math.abs(y1 - y0); step++) cellsOnPath.push(x1 !== x0 ? [x0 + Math.sign(x1 - x0) * step, y0] : [x0, y0 + Math.sign(y1 - y0) * step]);
    }
    const bit = (from: number[], to: number[]) => to[0] > from[0] ? 2 : to[0] < from[0] ? 8 : to[1] > from[1] ? 4 : 1;
    if (cellsOnPath.length === 1) return this.link(points[0][0], points[0][1], points[0][2] ?? 5, style);
    cellsOnPath.forEach((cell, index) => {
      const last = cellsOnPath.length - 1;
      const into = index ? OPPOSITE[bit(cellsOnPath[index - 1], cell)] : OPPOSITE[bit(cell, cellsOnPath[1])];
      this.link(cell[0], cell[1], into | (index < last ? bit(cell, cellsOnPath[index + 1]) : bit(cellsOnPath[index - 1], cell)), style);
    });
  }
  lines() {
    return this.chars.map((row, y) => {
      let out = '';
      for (let x = 0; x < Math.max(row.length, this.links[y].length); x++) if (row[x] !== '') out += row[x] ?? glyph(this.links[y][x] ?? 0, this.styles[y][x], this.unicode);
      return out.trimEnd();
    });
  }
}

type Shape = 'rect' | 'round' | 'diamond' | 'plain';
type GraphNode = { sections: string[][]; shape: Shape };
type GraphEdge = { from: string; to: string; label: string[]; head: string; tail: string; style: string };
type Graph = { direction: string; nodes: Map<string, GraphNode>; edges: GraphEdge[]; legend: string[] };
type Segment = { from: Slot; to: Slot; edge: GraphEdge; reversed: boolean; start: number; end: number; track: number };
type Slot = { node?: GraphNode; text?: string[]; style?: string; rank: number; row: number; order: number; weight: number; w: number; h: number; pos: number; ins: Segment[]; outs: Segment[] };
const FRAMES: Record<string, string[]> = { rect: ['┌┐└┘', '++++'], round: ['╭╮╰╯', "..''"], diamond: ['╱╲╲╱', '/\\\\/'] };
const MARKS: Record<string, string[]> = { arrow: ['▼▲►◄', 'v^><'], open: ['▽△▷◁', 'v^><'], async: ['▽△▷◁', 'v^><'], diamond: ['◆◆◆◆', '****'], hollow: ['◇◇◇◇', 'oooo'], circle: ['○○○○', 'oooo'], cross: ['××××', 'xxxx'] };
const DIRECTIONS: Record<string, string> = { TB: 'TD', TD: 'TD', BT: 'BT', LR: 'LR', RL: 'RL' };
const TURNED: Record<string, string> = { TD: 'LR', BT: 'RL', LR: 'TD', RL: 'BT' };

const frame = (canvas: Canvas, x: number, y: number, node: GraphNode, width: number) => {
  if (node.shape === 'plain') { node.sections.flat().forEach((line, index) => canvas.text(x + Math.floor((width - cells(line)) / 2), y + index, line)); return; }
  const unicode = canvas.unicode, [tl, tr, bl, br] = [...FRAMES[node.shape][unicode ? 0 : 1]], h = unicode ? '─' : '-', v = unicode ? '│' : '|';
  canvas.text(x, y, tl + h.repeat(width - 2) + tr);
  let row = y + 1;
  node.sections.forEach((lines, index) => {
    if (index) canvas.text(x, row++, (unicode ? '├' : '+') + h.repeat(width - 2) + (unicode ? '┤' : '+'));
    for (const line of lines) { canvas.text(x, row, v + ' '.repeat(width - 2) + v); canvas.text(x + 2 + (index ? 0 : Math.floor((width - 4 - cells(line)) / 2)), row++, line); }
  });
  canvas.text(x, row, bl + h.repeat(width - 2) + br);
};

const layered = (graph: Graph, direction: string, unicode: boolean) => {
  const across = direction === 'LR' || direction === 'RL', back = direction === 'BT' || direction === 'RL', forward = (across ? 2 : 0) + (back ? 1 : 0);
  const slots = new Map<string, Slot>();
  for (const [id, node] of graph.nodes) {
    const loops = graph.edges.filter(edge => edge.from === id && edge.to === id).map(edge => `${unicode ? '↻' : 'loop:'} ${edge.label.join(' ')}`.trim());
    const sections = loops.length ? [...node.sections.slice(0, -1), [...node.sections.at(-1)!, ...loops]] : node.sections, all = sections.flat();
    const inner = Math.max(1, ...all.map(cells));
    const [w, h] = node.shape === 'plain' ? [inner, all.length] : [inner + 4, all.length + 1 + sections.length];
    slots.set(id, { node: { ...node, sections }, rank: 0, row: 0, order: 0, weight: 0, w, h, pos: 0, ins: [], outs: [] });
  }
  const edges = graph.edges.filter(edge => edge.from !== edge.to), visiting = new Map<string, number>(), reversed = new Set<GraphEdge>();
  const visit = (id: string) => {
    visiting.set(id, 1);
    for (const edge of edges) if (edge.from === id) { const seen = visiting.get(edge.to); if (seen === 1) reversed.add(edge); else if (!seen) visit(edge.to); }
    visiting.set(id, 2);
  };
  for (const id of slots.keys()) if (!visiting.has(id)) visit(id);
  const links = edges.map(edge => reversed.has(edge) ? { from: slots.get(edge.to)!, to: slots.get(edge.from)!, edge, reversed: true } : { from: slots.get(edge.from)!, to: slots.get(edge.to)!, edge, reversed: false });
  const step = edges.some(edge => edge.label.length) ? 2 : 1;
  for (let pass = 0; pass <= slots.size; pass++) for (const link of links) link.to.rank = Math.max(link.to.rank, link.from.rank + step);
  for (const slot of slots.values()) {
    const below = links.filter(link => link.from === slot).map(link => link.to.rank);
    if (below.length && !links.some(link => link.to === slot)) slot.rank = Math.min(...below) - step;
  }
  const ranks: Slot[][] = [];
  const add = (slot: Slot) => (ranks[slot.rank] ??= []).push(slot);
  slots.forEach(add);
  const segments: Segment[] = [];
  for (const link of links) {
    const middle = link.from.rank + Math.floor((link.to.rank - link.from.rank) / 2);
    let previous = link.from;
    for (let rank = link.from.rank + 1; rank <= link.to.rank; rank++) {
      const text = rank === middle && link.edge.label.length ? link.edge.label : undefined;
      const next: Slot = rank === link.to.rank ? link.to : { text, style: link.edge.style, rank, row: 0, order: 0, weight: 0, w: text ? Math.max(...text.map(cells)) : 1, h: text ? text.length : 1, pos: 0, ins: [], outs: [] };
      if (next !== link.to) add(next);
      const segment = { from: previous, to: next, edge: link.edge, reversed: link.reversed, start: 0, end: 0, track: 0 };
      previous.outs.push(segment);
      next.ins.push(segment);
      segments.push(segment);
      previous = next;
    }
  }
  const rows = ranks.filter(Boolean), all = rows.flat();
  if (all.length > 400) throw new Error('it has too many long edges to draw');
  rows.forEach((row, index) => row.forEach((slot, order) => { slot.row = index; slot.order = order; }));
  const sort = (row: Slot[], near: (slot: Slot) => number[]) => {
    for (const slot of row) { const values = near(slot); slot.weight = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : slot.order; }
    row.sort((left, right) => left.weight - right.weight).forEach((slot, order) => slot.order = order);
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let index = 1; index < rows.length; index++) sort(rows[index], slot => slot.ins.map(segment => segment.from.order));
    for (let index = rows.length - 2; index >= 0; index--) sort(rows[index], slot => slot.outs.map(segment => segment.to.order));
  }
  const cross = (slot: Slot) => across ? slot.h : slot.w, main = (slot: Slot) => across ? slot.w : slot.h;
  const gap = across ? 1 : 2, middleOf = (slot: Slot) => slot.pos + Math.floor(cross(slot) / 2);
  const mean = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  for (const row of rows) {
    let end = -gap;
    for (const slot of row) {
      const near = slot.ins.map(segment => middleOf(segment.from));
      slot.pos = Math.max(end + gap, near.length ? mean(near) - Math.floor(cross(slot) / 2) : 0);
      end = slot.pos + cross(slot);
    }
  }
  for (let index = rows.length - 2; index >= 0; index--) {
    let limit = Infinity;
    for (const slot of [...rows[index]].reverse()) {
      const near = slot.outs.map(segment => middleOf(segment.to));
      if (near.length) slot.pos = Math.max(slot.pos, Math.min(mean(near) - Math.floor(cross(slot) / 2), limit - gap - cross(slot)));
      limit = slot.pos;
    }
  }
  for (const slot of all) {
    const inner = slot.node && slot.node.shape !== 'plain' ? cross(slot) - 4 : 0;
    const spread = (list: Segment[], key: 'start' | 'end', other: (segment: Segment) => Slot) => list.sort((left, right) => middleOf(other(left)) - middleOf(other(right)))
      .forEach((segment, index) => segment[key] = inner > 0 && list.length > 1 ? slot.pos + 2 + Math.round(index * (inner - 1) / (list.length - 1)) : middleOf(slot));
    spread(slot.outs, 'start', segment => segment.to);
    spread(slot.ins, 'end', segment => segment.from);
  }
  const band = rows.map(row => Math.max(1, ...row.map(main)));
  const tracks = rows.slice(0, -1).map(row => {
    const list = row.flatMap(slot => slot.outs).filter(segment => segment.start !== segment.end && segment.edge.style !== 'hidden');
    const within = (at: number, segment: Segment) => at >= Math.min(segment.start, segment.end) && at <= Math.max(segment.start, segment.end);
    // A segment whose stem lies in another's span, or whose span holds another's drop, must take the upper track or the lines cross.
    const above = (upper: Segment, lower: Segment) => upper !== lower && ((upper.start !== lower.start && within(upper.start, lower)) || (lower.end !== upper.end && within(lower.end, upper)));
    const used: number[][][] = [], placed: Segment[] = [];
    while (list.length) {
      const segment = list.find(candidate => !list.some(other => above(other, candidate))) ?? list[0];
      list.splice(list.indexOf(segment), 1);
      const low = Math.min(segment.start, segment.end), high = Math.max(segment.start, segment.end);
      let track = Math.max(0, ...placed.filter(other => above(other, segment)).map(other => other.track + 1));
      while ((used[track] ?? []).some(([from, to]) => low <= to + 1 && high >= from - 1)) track++;
      (used[track] ??= []).push([low, high]);
      segment.track = track;
      placed.push(segment);
    }
    return used.length;
  });
  const starts: number[] = [];
  let total = 0;
  rows.forEach((_, index) => { starts[index] = total; total += band[index] + (index < tracks.length ? tracks[index] ? tracks[index] + 2 : across ? 3 : 1 : 0); });
  const canvas = new Canvas(unicode), flip = (at: number) => back ? total - 1 - at : at;
  const point = (along: number, side: number) => across ? [flip(along), side, 10] : [side, flip(along), 5];
  const corner = (slot: Slot, along: number) => { const at = back ? total - along - main(slot) : along; return across ? [at, slot.pos] : [slot.pos, at]; };
  const draw = (points: number[][], style: string) => canvas.path(points.map(([along, side]) => point(along, side)), style);
  for (const segment of segments) {
    if (segment.edge.style === 'hidden') continue;
    const { from, to, edge } = segment, gap0 = starts[from.row] + band[from.row], first = from.node ? starts[from.row] + main(from) : gap0, end = starts[to.row] - 1, track = gap0 + 1 + segment.track;
    draw(segment.start === segment.end ? [[first, segment.start], [end, segment.end]] : [[first, segment.start], [track, segment.start], [track, segment.end], [end, segment.end]], edge.style);
    const into = to.node ? segment.reversed ? edge.tail : edge.head : '', out = from.node ? segment.reversed ? edge.head : edge.tail : '';
    if (into) { const [x, y] = point(end, segment.end); canvas.text(x, y, MARKS[into][unicode ? 0 : 1][forward]); }
    if (out) { const [x, y] = point(first, segment.start); canvas.text(x, y, MARKS[out][unicode ? 0 : 1][forward ^ 1]); }
  }
  for (const slot of all) {
    const along = starts[slot.row], at = middleOf(slot), length = band[slot.row];
    if (slot.node) { const [x, y] = corner(slot, along); frame(canvas, x, y, slot.node, slot.w); continue; }
    if (slot.style === 'hidden') continue;
    if (!slot.text) { draw([[along, at], [along + length - 1, at]], slot.style ?? ''); continue; }
    const first = along + Math.floor((length - main(slot)) / 2);
    if (first > along) draw([[along, at], [first - 1, at]], slot.style ?? '');
    if (first + main(slot) < along + length) draw([[first + main(slot), at], [along + length - 1, at]], slot.style ?? '');
    const [x, y] = corner(slot, first);
    slot.text.forEach((line, index) => canvas.text(x + Math.floor((slot.w - cells(line)) / 2), y + index, line));
  }
  return canvas.lines();
};

const NODE_ID = /^[\p{L}\p{N}_]+(?:[.\-][\p{L}\p{N}_]+)*/u;
const SHAPES: [string, string, Shape][] = [['(((', ')))', 'round'], ['((', '))', 'round'], ['([', '])', 'round'], ['[[', ']]', 'rect'], ['[(', ')]', 'round'], ['[/', '', 'rect'], ['[\\', '', 'rect'], ['{{', '}}', 'diamond'], ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond'], ['>', ']', 'rect']];
const TEXT_LINK = /^([<ox]?)(--|==|-\.)\s+(.+?)\s+(-{2,}|={2,}|\.+-)([>ox]?)\s*/;
const LINK = /^([<ox]?)(-{2,}|={2,}|-\.+-|~{3,})([>ox]?)\s*(?:\|([^|]*)\|\s*)?/;
const ENDS: Record<string, string> = { '>': 'arrow', '<': 'arrow', o: 'circle', x: 'cross' };
const unreadable = (text: string) => new Error(`cannot read "${fit(text, 32)}"`);
const closing = (body: string, close: string) => {
  const quoted = /^\s*\x22[^\x22]*\x22\s*/.exec(body), from = quoted ? quoted[0].length : 0;
  const at = close ? body.indexOf(close, from) : body.slice(from).search(/[\/\\]\]/) + from;
  if (at < from || (quoted && at !== from)) throw new Error('a node shape is not closed');
  return [quoted ? quoted[0] : body.slice(0, at), at + (close || '/]').length] as const;
};

const flowchart = (statements: string[], direction: string): Graph => {
  const graph: Graph = { direction, nodes: new Map(), edges: [], legend: [] };
  const groups: { id: string; title: string; members: Set<string> }[] = [], open: number[] = [];
  const touch = (id: string, text?: string, shape: Shape = 'rect') => {
    if (text !== undefined || !graph.nodes.has(id)) graph.nodes.set(id, { sections: [label(text ?? id)], shape });
    for (const index of open) groups[index].members.add(id);
  };
  for (const statement of statements) {
    if (/^(?:classDef|class|style|linkStyle|click)\s/.test(statement)) continue;
    const turn = /^direction\s+(\w+)$/.exec(statement), sub = /^subgraph\s+(.+)$/.exec(statement);
    if (turn) { if (!open.length && DIRECTIONS[turn[1]]) graph.direction = DIRECTIONS[turn[1]]; continue; }
    if (sub) {
      const named = /^([^\s\[]+)\s*\[(.*)\]$/.exec(sub[1]);
      groups.push({ id: named?.[1] ?? sub[1], title: decode(named?.[2] ?? sub[1]), members: new Set() });
      open.push(groups.length - 1);
      continue;
    }
    if (statement === 'end') { open.pop(); continue; }
    let rest = statement;
    const group = () => {
      const ids: string[] = [];
      do {
        rest = rest.replace(/^\s*&?\s*/, '');
        const id = NODE_ID.exec(rest);
        if (!id) throw unreadable(rest);
        rest = rest.slice(id[0].length);
        const shape = SHAPES.find(([start]) => rest.startsWith(start));
        if (shape) {
          const [text, used] = closing(rest.slice(shape[0].length), shape[1]);
          rest = rest.slice(shape[0].length + used);
          touch(id[0], text, shape[2]);
        } else touch(id[0]);
        rest = rest.replace(/^:::[\w-]+/, '');
        ids.push(id[0]);
      } while (/^\s*&/.test(rest));
      return ids;
    };
    let left = group();
    while (rest.trim()) {
      rest = rest.trimStart();
      const text = TEXT_LINK.exec(rest), plain = text ? null : LINK.exec(rest), link = text ?? plain;
      if (!link || (plain && !plain[3] && plain[2].length < 3)) throw unreadable(rest);
      rest = rest.slice(link[0].length);
      const body = text ? text[2] + text[4] : plain![2], words = text ? text[3] : plain![4];
      const style = body.includes('~') ? 'hidden' : body.includes('=') ? 'thick' : body.includes('.') ? 'dot' : '';
      const right = group();
      for (const from of left) for (const to of right) graph.edges.push({ from, to, label: words?.trim() ? label(words) : [], head: ENDS[text ? text[5] : plain![3]] ?? '', tail: ENDS[link[1]] ?? '', style });
      left = right;
    }
  }
  for (const group of groups) {
    const node = graph.nodes.get(group.id);
    if (node && node.sections[0].join(' ') === group.id) graph.nodes.set(group.id, { sections: [label(group.title)], shape: 'round' });
    group.members.delete(group.id);
    graph.legend.push(`Subgraph ${group.title}: ${[...group.members].map(id => graph.nodes.get(id)!.sections[0].join(' ')).join(', ') || 'empty'}`);
  }
  return graph;
};

const stateDiagram = (statements: string[], unicode: boolean): Graph => {
  const graph: Graph = { direction: 'TD', nodes: new Map(), edges: [], legend: [] };
  const scope: string[] = [], parts = new Map<string, string[]>();
  const state = (id: string, side: 'start' | 'end') => {
    if (id === '[*]') {
      const key = `${scope.join('/')}[*]${side}`, owner = scope.at(-1);
      if (!graph.nodes.has(key)) graph.nodes.set(key, { sections: [[`${side === 'start' ? unicode ? '●' : '(*)' : unicode ? '◉' : '(@)'}${owner ? ` ${owner}` : ''}`]], shape: 'plain' });
      return key;
    }
    if (!graph.nodes.has(id)) { graph.nodes.set(id, { sections: [[id]], shape: 'round' }); if (scope.length) parts.get(scope.at(-1)!)!.push(id); }
    return id;
  };
  const enter = (id: string) => { parts.set(id, parts.get(id) ?? []); scope.push(id); };
  let note: string[] | null = null;
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if (note) { if (/^end\s+note$/i.test(statement)) { graph.legend.push(note.join(' ')); note = null; } else note.push(statement); continue; }
    if (statement === '--' || /^(?:classDef|class|style|scale|hide empty description)\b/.test(statement)) continue;
    if ((match = /^direction\s+(\w+)$/.exec(statement))) { if (!scope.length && DIRECTIONS[match[1]]) graph.direction = DIRECTIONS[match[1]]; continue; }
    if ((match = /^note\s+(?:left|right)\s+of\s+([^\s:]+)\s*(?::\s*(.*))?$/i.exec(statement))) {
      if (match[2] === undefined) note = [`Note on ${match[1]}:`]; else graph.legend.push(`Note on ${match[1]}: ${decode(match[2])}`);
      continue;
    }
    if ((match = /^state\s+\x22([^\x22]*)\x22\s+as\s+([^\s{]+)\s*(\{)?$/.exec(statement))) {
      state(match[2], 'start');
      graph.nodes.get(match[2])!.sections = [label(match[1])];
      if (match[3]) enter(match[2]);
      continue;
    }
    if ((match = /^state\s+([^\s{<]+)\s*(?:<<(choice|fork|join)>>)?\s*(\{)?$/.exec(statement))) {
      state(match[1], 'start');
      if (match[2]) graph.nodes.set(match[1], { sections: [[match[2] === 'choice' ? unicode ? '◇' : '<>' : unicode ? '━━━' : '===']], shape: 'plain' });
      if (match[3]) enter(match[1]);
      continue;
    }
    if (statement === '}') { if (!scope.pop()) throw new Error('a } has no matching state'); continue; }
    if ((match = /^(\[\*\]|[^\s:]+)\s*-->\s*(\[\*\]|[^\s:]+)\s*(?::\s*(.*))?$/.exec(statement))) {
      graph.edges.push({ from: state(match[1], 'start'), to: state(match[2], 'end'), label: match[3]?.trim() ? label(match[3]) : [], head: 'arrow', tail: '', style: '' });
      continue;
    }
    if ((match = /^([^\s:]+)\s*:\s*(.+)$/.exec(statement))) {
      const node = graph.nodes.get(state(match[1], 'start'))!;
      node.sections = [node.sections[0], [...(node.sections[1] ?? []), ...label(match[2])]];
      continue;
    }
    if (/^[^\s:]+$/.test(statement)) { state(statement, 'start'); continue; }
    throw unreadable(statement);
  }
  if (note) throw new Error('a note is not closed');
  for (const [owner, members] of parts) graph.legend.push(`State ${owner} contains ${members.join(', ') || 'no named states'}`);
  return graph;
};

const RELATION = /^([^\s"]+)\s+(?:"([^"]*)"\s*)?(<\||\*|o|<)?(--|\.\.)(\|>|\*|o|>)?\s*(?:"([^"]*)"\s*)?([^\s":]+)\s*(?::\s*(.*))?$/;
const RELATION_MARKS: Record<string, string> = { '<|': 'open', '|>': 'open', '*': 'diamond', o: 'hollow', '<': 'arrow', '>': 'arrow' };
const classDiagram = (statements: string[], unicode: boolean): Graph => {
  const graph: Graph = { direction: 'TD', nodes: new Map(), edges: [], legend: [] };
  const generic = (text: string) => text.replace(/~([^~]*)~/g, '<$1>');
  const types = new Map<string, { stereotype: string; title: string; fields: string[]; methods: string[] }>();
  const spaces: { name: string; members: string[] }[] = [], blocks: string[] = [];
  const type = (id: string) => {
    if (!types.has(id)) { types.set(id, { stereotype: '', title: generic(id), fields: [], methods: [] }); for (const space of spaces) if (blocks.includes(`#${space.name}`)) space.members.push(generic(id)); }
    return types.get(id)!;
  };
  const member = (id: string, text: string) => {
    const entry = type(id), value = generic(text.trim()), stereotype = /^<<(.+)>>$/.exec(value);
    if (stereotype) entry.stereotype = stereotype[1]; else if (value) (value.includes('(') ? entry.methods : entry.fields).push(value);
  };
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    const block = blocks.at(-1);
    if (statement === '}') { if (!blocks.pop()) throw new Error('a } has no matching block'); continue; }
    if (block && !block.startsWith('#')) { member(block, statement); continue; }
    if (/^(?:cssClass|classDef|style|click|link|callback)\b/.test(statement)) continue;
    if ((match = /^direction\s+(\w+)$/.exec(statement))) { if (DIRECTIONS[match[1]]) graph.direction = DIRECTIONS[match[1]]; continue; }
    if ((match = /^namespace\s+(\S+)\s*\{$/.exec(statement))) { spaces.push({ name: match[1], members: [] }); blocks.push(`#${match[1]}`); continue; }
    if ((match = /^class\s+([^\s{\[":]+)(?:\s*\["([^"]*)"\])?\s*(\{)?\s*(?::::[\w-]+)?$/.exec(statement))) {
      const entry = type(match[1]);
      if (match[2]) entry.title = match[2];
      if (match[3]) blocks.push(match[1]);
      continue;
    }
    if ((match = /^<<([^>]+)>>\s*(\S+)$/.exec(statement))) { type(match[2]).stereotype = match[1]; continue; }
    if ((match = /^note\s+(?:for\s+(\S+)\s+)?\x22([^\x22]*)\x22$/.exec(statement))) { graph.legend.push(`Note${match[1] ? ` on ${match[1]}` : ''}: ${decode(match[2])}`); continue; }
    if ((match = RELATION.exec(statement))) {
      type(match[1]);
      type(match[7]);
      graph.edges.push({ from: match[1], to: match[7], label: [...(match[8] ? label(match[8]) : []), ...(match[2] || match[6] ? [`${match[2] || '-'} : ${match[6] || '-'}`] : [])],
        tail: RELATION_MARKS[match[3] ?? ''] ?? '', head: RELATION_MARKS[match[5] ?? ''] ?? '', style: match[4] === '..' ? 'dot' : '' });
      continue;
    }
    if ((match = /^([^\s:]+)\s*:\s*(.+)$/.exec(statement))) { member(match[1], match[2]); continue; }
    throw unreadable(statement);
  }
  for (const [id, entry] of types) graph.nodes.set(id, { shape: 'rect', sections: [[...(entry.stereotype ? [unicode ? `«${entry.stereotype}»` : `<<${entry.stereotype}>>`] : []), ...label(entry.title)], ...[entry.fields, entry.methods].filter(list => list.length).map(list => list.flatMap(line => wrap(line, 40)))] });
  for (const space of spaces) graph.legend.push(`Namespace ${space.name}: ${space.members.join(', ') || 'empty'}`);
  return graph;
};

const CARDINALITY: Record<string, string> = { '|o': '0..1', 'o|': '0..1', '||': '1', '}o': '0..n', 'o{': '0..n', '}|': '1..n', '|{': '1..n' };
const ENTITY = '([\\p{L}\\p{N}_-]+|"[^"]+")';
const RELATIONSHIP = new RegExp(`^${ENTITY}\\s*(\\|o|\\|\\||\\}o|\\}\\|)(--|\\.\\.)(o\\||\\|\\||o\\{|\\|\\{)\\s*${ENTITY}\\s*:\\s*(.+)$`, 'u');
const erDiagram = (statements: string[]): Graph => {
  const graph: Graph = { direction: 'TD', nodes: new Map(), edges: [], legend: [] };
  const entities = new Map<string, string[]>();
  const entity = (name: string) => { const id = name.replace(/^"|"$/g, ''); if (!entities.has(id)) entities.set(id, []); return id; };
  let open = '';
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if (open) { if (statement === '}') open = ''; else entities.get(open)!.push(...wrap(decode(statement.replace(/\s+/g, ' ')), 40)); continue; }
    if ((match = new RegExp(`^${ENTITY}\\s*\\{$`, 'u').exec(statement))) { open = entity(match[1]); continue; }
    if ((match = RELATIONSHIP.exec(statement))) {
      graph.edges.push({ from: entity(match[1]), to: entity(match[5]), label: [...label(match[6]), `${CARDINALITY[match[2]]} : ${CARDINALITY[match[4]]}`], head: '', tail: '', style: match[3] === '..' ? 'dot' : '' });
      continue;
    }
    if ((match = /^direction\s+(\w+)$/.exec(statement))) { if (DIRECTIONS[match[1]]) graph.direction = DIRECTIONS[match[1]]; continue; }
    if ((match = new RegExp(`^${ENTITY}$`, 'u').exec(statement))) { entity(match[1]); continue; }
    if (/^(?:style|classDef|class)\s/.test(statement)) continue;
    throw unreadable(statement);
  }
  for (const [id, attributes] of entities) graph.nodes.set(id, { shape: 'rect', sections: attributes.length ? [[id], attributes] : [[id]] });
  return graph;
};

type Step = { kind: 'message'; from: number; to: number; text: string[]; style: string; head: string; tail: string }
  | { kind: 'note'; from: number; to: number; side: string; text: string[] } | { kind: 'rule'; text: string; style: string };
const MESSAGE = /^(\S+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*([^:\s]+)\s*(?::\s*(.*))?$/;
const sequenceDiagram = (statements: string[], unicode: boolean) => {
  const people: string[][] = [], index = new Map<string, number>(), steps: Step[] = [], blocks: string[] = [], legend: string[] = [];
  const who = (id: string, name?: string) => {
    if (!index.has(id)) { index.set(id, people.length); people.push(label(name ?? id)); } else if (name) people[index.get(id)!] = label(name);
    return index.get(id)!;
  };
  let numbered = false, count = 0, title = '';
  for (const statement of statements) {
    let match: RegExpExecArray | null;
    if ((match = MESSAGE.exec(statement))) {
      const arrow = match[2], text = label(match[5] ?? '').filter((line, at, all) => line || all.length > 1);
      if (numbered) text[0] = `${++count}. ${text[0] ?? ''}`.trim();
      steps.push({ kind: 'message', from: who(match[1]), to: who(match[4]), text, style: arrow.includes('--') ? 'dot' : '', head: arrow.endsWith('>>') ? 'arrow' : arrow.endsWith('x') ? 'cross' : arrow.endsWith(')') ? 'async' : '', tail: arrow.startsWith('<<') ? 'arrow' : '' });
      continue;
    }
    if ((match = /^(?:create\s+)?(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(statement))) { who(match[1], match[2]); continue; }
    if (statement === 'autonumber' || statement.startsWith('autonumber ')) { numbered = true; continue; }
    if ((match = /^title\s*:?\s*(.+)$/.exec(statement))) { title = decode(match[1]); continue; }
    if (/^(?:activate|deactivate|links?|properties|details)\s/.test(statement)) continue;
    if ((match = /^destroy\s+(\S+)$/.exec(statement))) { steps.push({ kind: 'rule', text: `${match[1]} destroyed`, style: 'dot' }); continue; }
    if ((match = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:\s*(.*)$/i.exec(statement))) {
      const [first, second = first] = match[2].split(',').map(part => who(part.trim()));
      steps.push({ kind: 'note', from: Math.min(first, second), to: Math.max(first, second), side: match[1].toLowerCase(), text: label(match[3]) });
      continue;
    }
    if ((match = /^(loop|alt|opt|par|critical|break|rect|box)\b\s*(.*)$/.exec(statement))) {
      blocks.push(match[1]);
      if (match[1] === 'box') legend.push(`Box ${decode(match[2])}`); else if (match[1] !== 'rect') steps.push({ kind: 'rule', text: `${match[1]} ${decode(match[2])}`.trim(), style: '' });
      continue;
    }
    if ((match = /^(else|and|option)\b\s*(.*)$/.exec(statement))) { steps.push({ kind: 'rule', text: `${match[1]} ${decode(match[2])}`.trim(), style: 'dot' }); continue; }
    if (statement === 'end') {
      const block = blocks.pop();
      if (!block) throw new Error('an end has no matching block');
      if (block !== 'box' && block !== 'rect') steps.push({ kind: 'rule', text: `end ${block}`, style: '' });
      continue;
    }
    throw unreadable(statement);
  }
  if (!people.length) throw new Error('it has no participants');
  const widths = people.map(lines => Math.max(...lines.map(cells)) + 4), centers = people.map(() => 0);
  const need = (left: number, right: number, distance: number) => { const short = distance - (centers[right] - centers[left]); if (short > 0) for (let at = right; at < people.length; at++) centers[at] += short; };
  centers[0] = Math.floor(widths[0] / 2);
  for (let at = 1; at < people.length; at++) { centers[at] = centers[at - 1]; need(at - 1, at, Math.ceil(widths[at - 1] / 2) + Math.floor(widths[at] / 2) + 2); }
  let shift = 0;
  for (const step of steps) {
    if (step.kind === 'rule') continue;
    const width = Math.max(0, ...step.text.map(cells));
    if (step.kind === 'message' && step.from !== step.to) need(Math.min(step.from, step.to), Math.max(step.from, step.to), width + 4);
    else if (step.kind === 'message' || step.side === 'right of') { if (step.from + 1 < people.length) need(step.from, step.from + 1, width + 8); }
    else if (step.side === 'left of') { if (step.from > 0) need(step.from - 1, step.from, width + 8); else shift = Math.max(shift, width + 6 - centers[0]); }
    else shift = Math.max(shift, Math.ceil((width + 4) / 2) - centers[step.from]);
  }
  for (let at = 0; at < people.length; at++) centers[at] += shift;
  const canvas = new Canvas(unicode), top = Math.max(...people.map(lines => lines.length)) + 2, rules: [number, string, string][] = [];
  people.forEach((lines, at) => frame(canvas, centers[at] - Math.floor(widths[at] / 2), 0, { shape: 'rect', sections: [lines] }, widths[at]));
  let y = top, right = Math.max(...people.map((_, at) => centers[at] + Math.ceil(widths[at] / 2)));
  const mark = (kind: string, rightward: boolean) => MARKS[kind][unicode ? 0 : 1][rightward ? 2 : 3];
  for (const step of steps) {
    if (step.kind === 'rule') { rules.push([y++, step.text, step.style]); continue; }
    const width = Math.max(0, ...step.text.map(cells)), from = centers[step.from], to = centers[step.to];
    if (step.kind === 'note') {
      const inner = Math.max(width, step.side === 'over' && step.from !== step.to ? to - from : 0), left = step.side === 'right of' ? from + 2 : step.side === 'left of' ? from - inner - 6 : Math.floor((from + to) / 2) - Math.floor((inner + 4) / 2);
      frame(canvas, left, y, { shape: 'rect', sections: [step.text] }, inner + 4);
      right = Math.max(right, left + inner + 4);
      y += step.text.length + 2;
      continue;
    }
    if (step.from === step.to) {
      step.text.forEach((line, at) => canvas.text(from + 6, y + at, line));
      canvas.path([[from + 1, y], [from + 3, y], [from + 3, y + 1], [from + 1, y + 1]], step.style);
      if (step.head) canvas.text(from + 1, y + 1, mark(step.head, false));
      right = Math.max(right, from + 6 + width);
      y += Math.max(2, step.text.length + 1);
      continue;
    }
    const low = Math.min(from, to), high = Math.max(from, to);
    step.text.forEach((line, at) => canvas.text(low + Math.floor((high - low - cells(line)) / 2), y + at, line));
    y += step.text.length;
    canvas.path([[from + Math.sign(to - from), y], [to - Math.sign(to - from), y]], step.style);
    if (step.head) canvas.text(to + (to > from ? -1 : 1), y, mark(step.head, to > from));
    if (step.tail) canvas.text(from + (to > from ? 1 : -1), y, mark(step.tail, to < from));
    y++;
  }
  centers.forEach((center, at) => canvas.path([[center, people[at].length + 2], [center, y]], ''));
  for (const [row, text, style] of rules) { canvas.path([[0, row], [right, row]], style); canvas.text(2, row, ` ${text} `); }
  return [...(title ? wrap(title, 80) : []), ...canvas.lines(), ...legend];
};

const xyChart = (statements: string[], unicode: boolean, columns: number) => {
  const horizontal = /\bhorizontal\b/.test(statements[0]), series: { kind: string; name: string; values: number[] }[] = [];
  let title = '', xTitle = '', yTitle = '', categories: string[] = [], range: number[] | null = null, span: number[] | null = null;
  const list = (text: string) => text.match(/\x22[^\x22]*\x22|[^,\s][^,]*/g)?.map(item => decode(item)) ?? [];
  const number = (text: string) => { const value = Number(text.trim() || NaN); if (!Number.isFinite(value)) throw unreadable(text); return value; };
  for (const statement of statements.slice(1)) {
    let match: RegExpExecArray | null;
    if ((match = /^title\s+(.+)$/.exec(statement))) title = decode(match[1]);
    else if ((match = /^x-axis\s*(?:("[^"]*"|[^\s\["\d-][^\s\[]*)\s*)?(?:\[(.*)\]|(-?[\d.]+)\s*-->\s*(-?[\d.]+))?$/.exec(statement))) {
      xTitle = decode(match[1] ?? '');
      if (match[2] !== undefined) categories = list(match[2]); else if (match[3] !== undefined) span = [number(match[3]), number(match[4])];
    } else if ((match = /^y-axis\s*(?:("[^"]*"|[^\s"\d-][^\s]*)\s*)?(?:(-?[\d.]+)\s*-->\s*(-?[\d.]+))?$/.exec(statement))) {
      yTitle = decode(match[1] ?? '');
      if (match[2] !== undefined) range = [number(match[2]), number(match[3])];
    } else if ((match = /^(bar|line)\s*(?:("[^"]*"|[^\s\["]+)\s*)?\[(.*)\]$/.exec(statement))) series.push({ kind: match[1], name: decode(match[2] ?? match[1]), values: match[3].split(',').map(number) });
    else throw unreadable(statement);
  }
  const count = Math.max(categories.length, ...series.map(item => item.values.length));
  if (!series.length || count > 40 || series.length > 6) throw new Error(series.length ? 'it has more than 40 points or 6 series' : 'it has no bar or line data');
  categories = Array.from({ length: count }, (_, at) => categories[at] ?? (span ? String(+(span[0] + (span[1] - span[0]) * at / Math.max(1, count - 1)).toFixed(2)) : String(at + 1)));
  const values = series.flatMap(item => item.values);
  let [low, high] = range ?? [Math.min(0, ...values), Math.max(...values)];
  if (!(high > low)) high = low + 1;
  const scale = (value: number) => Math.min(1, Math.max(0, (value - low) / (high - low)));
  const tick = (value: number) => String(+value.toFixed(2));
  const bars = series.filter(item => item.kind === 'bar'), lines = series.filter(item => item.kind === 'line');
  const DOTS = unicode ? '●○◆×▲■' : '*o+x^#', BLOCK = unicode ? '█' : '#';
  const legend = series.length > 1 || lines.length ? [series.map(item => `${item.kind === 'bar' ? BLOCK.repeat(2) : DOTS[lines.indexOf(item)]} ${item.name}`).join('  ')] : [];
  const out: string[] = [...(title ? wrap(title, 80) : []), ...(yTitle && !horizontal ? [`${unicode ? '↑' : '^'} ${yTitle}`] : [])];
  if (horizontal) {
    const labelWidth = Math.min(20, Math.max(...categories.map(cells))), width = Math.max(10, Math.min(50, columns - labelWidth - 12));
    const PARTS = unicode ? ' ▏▎▍▌▋▊▉' : '        ';
    categories.forEach((name, at) => series.forEach((item, which) => {
      const value = item.values[at];
      if (value === undefined) return;
      const eighths = Math.round(scale(value) * width * 8), head = which ? '' : name;
      const bar = item.kind === 'bar' ? BLOCK.repeat(Math.floor(eighths / 8)) + PARTS[eighths % 8].trim() : `${' '.repeat(Math.round(scale(value) * (width - 1)))}${DOTS[lines.indexOf(item)]}`;
      wrap(head, labelWidth).forEach((line, row) => out.push(`${line}${' '.repeat(labelWidth - cells(line))} ${unicode ? '│' : '|'}${row ? '' : `${bar} ${tick(value)}`}`));
    }));
    out.push(`${' '.repeat(labelWidth)} ${unicode ? '└' : '+'}${(unicode ? '─' : '-').repeat(width)} ${tick(low)} to ${tick(high)}`);
  } else {
    const height = 10, labels = categories.map(name => wrap(name, 10)), slot = Math.max(3, bars.length + 1, ...labels.flat().map(cells));
    const axis = Math.max(...[low, (low + high) / 2, high].map(value => cells(tick(value)))) + 1, canvas = new Canvas(unicode), bar = Math.max(1, Math.floor((slot - 1) / Math.max(1, bars.length)));
    const PARTS = unicode ? ' ▁▂▃▄▅▆▇' : '    ####';
    for (let row = 0; row < height; row++) {
      const value = row === 0 ? high : row === height - 1 ? low : row === Math.floor(height / 2) ? (low + high) / 2 : null;
      if (value !== null) canvas.text(axis - 1 - cells(tick(value)), row, tick(value));
      canvas.text(axis, row, value !== null ? unicode ? '┤' : '+' : unicode ? '│' : '|');
    }
    canvas.text(axis, height, (unicode ? '└' : '+') + (unicode ? '─' : '-').repeat(count * (slot + 1) + 1));
    for (let at = 0; at < count; at++) {
      const left = axis + 2 + at * (slot + 1);
      bars.forEach((item, which) => {
        const value = item.values[at];
        if (value === undefined) return;
        const eighths = Math.round(scale(value) * height * 8);
        for (let row = 0; row < Math.ceil(eighths / 8); row++) canvas.text(left + which * bar, height - 1 - row, (row < Math.floor(eighths / 8) ? BLOCK : PARTS[eighths % 8]).repeat(bar));
      });
      lines.forEach((item, which) => { const value = item.values[at]; if (value !== undefined) canvas.text(left + Math.floor(slot / 2), height - 1 - Math.round(scale(value) * (height - 1)), DOTS[which]); });
      labels[at].forEach((line, row) => canvas.text(left + Math.floor((slot - cells(line)) / 2), height + 1 + row, line));
    }
    out.push(...canvas.lines());
    if (xTitle) out.push(`${' '.repeat(axis + 2)}${xTitle} ${unicode ? '→' : '->'}`);
  }
  return [...out, ...legend];
};

const statementsOf = (text: string) => text.replace(/%%\{[\s\S]*?\}%%/g, '').split('\n')
  .flatMap(line => line.replace(/^\s*%%.*$/, '').match(/(?:[^;"]|"[^"]*")+/g) ?? []).map(part => part.trim()).filter(Boolean);
const kindOf = (source: string) => statementsOf(source.replace(/^\s*---\n[\s\S]*?\n---\n/, ''))[0]?.split(/\s+/)[0] ?? 'empty';
const diagram = (source: string, unicode: boolean, columns: number) => {
  if (size(source) > SOURCE_BYTES) throw new Error(`its source is over ${SOURCE_BYTES / 1000} KB`);
  let text = source.replace(/\r\n?/g, '\n'), title = '';
  const front = /^\s*---\n([\s\S]*?)\n---\n/.exec(text);
  if (front) { title = decode(/^title:\s*(.+)$/m.exec(front[1])?.[1] ?? ''); text = text.slice(front[0].length); }
  const statements = statementsOf(text);
  if (statements.length > 300 || statements.some(line => line.length > 500)) throw new Error('it has more than 300 statements or one over 500 characters');
  const [head = ''] = statements, kind = head.split(/\s+/)[0], body = statements.slice(1);
  const graph = (built: Graph) => {
    if (built.nodes.size > MAX_NODES || built.edges.length > MAX_EDGES) throw new Error(`it has more than ${MAX_NODES} nodes or ${MAX_EDGES} edges`);
    const attempt = (direction: string) => {
      try {
        const lines = layered(built, direction, unicode), widest = Math.max(0, ...lines.map(cells));
        return widest <= columns ? [...lines, ...built.legend.flatMap(line => wrap(line, columns))] : `it needs ${widest} columns`;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return error.message;
      }
    };
    const first = attempt(built.direction), other = typeof first === 'string' ? attempt(TURNED[built.direction]) : first;
    if (typeof other === 'string') throw new Error(first as string);
    return { lines: other, turned: other !== first };
  };
  const drawn = kind === 'flowchart' || kind === 'graph' ? graph(flowchart(body, DIRECTIONS[head.split(/\s+/)[1]] ?? 'TD'))
    : kind === 'stateDiagram' || kind === 'stateDiagram-v2' ? graph(stateDiagram(body, unicode))
      : kind === 'classDiagram' || kind === 'classDiagram-v2' ? graph(classDiagram(body, unicode))
        : kind === 'erDiagram' ? graph(erDiagram(body))
          : kind === 'sequenceDiagram' ? { lines: sequenceDiagram(body, unicode), turned: false }
            : kind === 'xychart-beta' || kind === 'xychart' ? { lines: xyChart(statements, unicode, columns), turned: false }
              : null;
  if (!drawn) throw new Error(`${kind ? `"${fit(kind, 24)}" diagrams are` : 'an empty diagram is'} not supported`);
  const lines = [...(title ? wrap(title, columns) : []), ...drawn.lines];
  const widest = Math.max(0, ...lines.map(cells));
  if (widest > columns) throw new Error(`it needs ${widest} columns`);
  if (lines.length > MAX_ROWS) throw new Error(`it is taller than ${MAX_ROWS} rows`);
  return { kind: kind.replace(/-v2$|-beta$/, '').replace(/Diagram$/, '').toLowerCase(), lines, turned: drawn.turned };
};

type Part = { markdown: string } | { source: string; fence: string };
const fences = (text: string) => {
  const lines = text.split('\n'), parts: Part[] = [];
  let buffer: string[] = [];
  const flush = () => { if (buffer.length) parts.push({ markdown: buffer.join('\n') }); buffer = []; };
  for (let at = 0; at < lines.length; at++) {
    const open = /^ {0,3}(\x60{3,}|~{3,})\s*([^\x60\s]*)/.exec(lines[at]);
    if (!open) { buffer.push(lines[at]); continue; }
    const close = new RegExp(`^ {0,3}${open[1][0] === '~' ? '~' : '\\x60'}{${open[1].length},}\\s*$`);
    let end = at + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (end < lines.length && open[2].toLowerCase() === 'mermaid') { flush(); parts.push({ source: lines.slice(at + 1, end).join('\n'), fence: lines.slice(at, end + 1).join('\n') }); }
    else buffer.push(...lines.slice(at, end + 1));
    at = end;
  }
  flush();
  return parts;
};
const chunks = (lines: string[]) => lines.reduce<string[]>((out, line) => {
  if (out.length && size(out[out.length - 1]) + size(line) < 4_000) out[out.length - 1] += `\n${line}`; else out.push(line);
  return out;
}, []);
const presentation = (text: string, unicode: boolean, columns: number) => {
  const parts = fences(clean(text)), tree: TerminalComponent[] = [];
  let drawn = 0;
  for (const part of parts) {
    if ('markdown' in part) { if (part.markdown.trim()) tree.push({ type: 'markdown', id: `omd_preview_md_${tree.length}`, label: 'Response text', text: part.markdown }); continue; }
    let note: string;
    try {
      if (drawn >= MESSAGE_DIAGRAMS) throw new Error(`only ${MESSAGE_DIAGRAMS} diagrams per response are drawn`);
      const result = diagram(part.source, unicode, columns);
      if (size(result.lines.join('\n')) > DRAWN_BYTES) throw new Error(`the drawing is over ${DRAWN_BYTES / 1000} KB`);
      drawn++;
      for (const chunk of chunks(result.lines)) tree.push({ type: 'text', id: `omd_preview_diagram_${tree.length}`, label: `Mermaid ${result.kind} diagram`, text: chunk });
      note = `mermaid ${result.kind}${result.turned ? ', turned to fit' : ''} · /preview diagrams shows the source`;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      tree.push({ type: 'markdown', id: `omd_preview_md_${tree.length}`, label: 'Mermaid source', text: part.fence });
      note = `mermaid not drawn: ${error.message}; showing the source`;
    }
    tree.push({ type: 'text', id: `omd_preview_note_${tree.length}`, label: 'Diagram note', text: note, tone: 'muted' });
  }
  return parts.some(part => 'source' in part) ? tree : null;
};

export default function activate(api: ModAPI) {
  const thumbnails = api.settings.thumbnails !== false;
  const diagrams = ['ascii', 'off'].includes(String(api.settings.diagrams)) ? String(api.settings.diagrams) : 'unicode';
  const load = (): State => ({ inline: null, revision: 0, watch: [], hashes: {}, images: [], ...(api.state.get() as Partial<State> | null) });
  const save = (patch: Partial<State>) => api.state.set({ ...load(), ...patch } as unknown as Json);

  const render = (output: string, title: string, source?: string, markdown?: string): Rendered => {
    const watch = source !== undefined && load().watch.includes(source);
    const input = markdown === undefined ? '' : `const markdown = ${JSON.stringify(markdown)};\n`;
    const run = api.host.tryCall('exec.run', {
      program: 'node',
      argv: ['--input-type=module', '-', output, title, watch ? 'watch' : '', ...(source ? [source] : [])],
      stdin: input + api.assets.read('render.mjs').text,
      write: true,
      timeout_ms: 30_000,
    });
    if (!run.ok) return { error: run.error === 'exec_arguments_invalid' ? 'the text is too long to preview (about 48 KB at most)' : run.error };
    return run.value.exit_code === 0 ? { path: run.value.stdout } : { error: /Error: (.*)/.exec(run.value.stderr)?.[1] ?? 'render failed' };
  };

  const open = (rendered: Rendered, label: string): CommandResult => {
    if ('error' in rendered) return { display: `/preview: ${rendered.error}` };
    const opened = api.host.tryCall('terminal.open', { path: rendered.path });
    if (opened.ok && 'opened' in opened.value) return { display: `Opened ${label} in the browser` };
    return { display: `Wrote ${label} to ${rendered.path}${opened.ok ? '' : ` (${opened.error})`}` };
  };

  const show = (title: string, kind: string, text: string): CommandResult => {
    const limit = kind === 'diff' ? DIFF_BYTES : TEXT_BYTES;
    const shown = clamp(clean(text), limit);
    save({ inline: { title: clamp(clean(title), 120).text, kind, text: shown.text }, revision: load().revision + 1 });
    return shown.cut ? { display: `Showing the first ${limit / 1000} KB inline; /preview without --inline opens all of it in the browser` } : null;
  };

  const currentThread = () => {
    const before = api.host.call('store.get', { key: 'thread' });
    api.host.call('store.put', { key: 'thread', value: true, expected_revision: before?.revision ?? null });
    return api.host.call('store.get', { key: 'thread' })?.provenance.thread_id ?? null;
  };

  const responses = (limit: number): string[] => {
    const page = api.host.call('app.request', { method: 'thread/turns/list', params: { threadId: currentThread(), limit, itemsView: 'summary' } }) as { data?: Turn[] };
    return (page.data ?? []).flatMap(turn => (turn.items ?? []).filter(item => item.type === 'agentMessage').slice(-1).map(item => item.text ?? ''));
  };

  const viewImage = (picture: Picture) => picture.image
    ? save({ inline: { title: picture.label, kind: 'image', text: picture.id, image: picture.image }, revision: load().revision + 1 })
    : null;

  const preview = (words: string[]): CommandResult => {
    const inline = words.includes('--inline');
    const target = words.filter(word => !word.startsWith('--')).join(' ');
    if (words.some(word => word.startsWith('--') && word !== '--inline' && word !== '--watch')) return { display: USAGE };
    if (target === 'close') {
      save({ inline: null });
      return null;
    }
    if (target === 'unwatch') {
      save({ watch: [], hashes: {} });
      return { display: 'Stopped watching preview files' };
    }
    if (words[0] === 'server') {
      const listed = api.host.tryCall('sessions.ports', null);
      if (!listed.ok) return { display: `Server ports are unavailable here: ${listed.error}` };
      const { ports } = listed.value;
      const port = words[1] ? ports.find(item => String(item.port) === words[1]) : ports.length === 1 ? ports[0] : undefined;
      if (!port) return { display: ports.length ? `Listening: ${ports.map(item => item.port).join(', ')}; use /preview server PORT` : 'No server started by this session is listening' };
      const opened = api.host.tryCall('terminal.open', { url: `http://localhost:${port.port}` });
      return { display: opened.ok && 'opened' in opened.value ? `Opened http://localhost:${port.port}` : `Not opened${opened.ok ? '' : `: ${opened.error}`}` };
    }
    if (words[0] === 'image') {
      const draft = api.host.tryCall('composer.read', null);
      if (!draft.ok) return { display: `The draft is unavailable here: ${draft.error}` };
      const images = pictures(draft.value), picture = images[Number(words[1] ?? 1) - 1];
      save({ images });
      if (!picture) return { display: images.length ? `The draft has ${images.length} image${images.length === 1 ? '' : 's'}; use /preview image 1-${images.length}` : 'The draft has no images' };
      if (!picture.image) return { display: `${picture.label} has no preview: only PNG and JPEG images up to 8 MiB do` };
      viewImage(picture);
      return null;
    }
    if (words[0] === 'diagrams') {
      const found = responses(10).flatMap((text, index) => fences(clean(text)).flatMap(part => 'source' in part ? [{ response: index + 1, source: part.source }] : []));
      if (!words[1]) return { display: found.length ? `${found.map((item, index) => `${index + 1}. ${kindOf(item.source)} in response ${item.response}`).join('\n')}\nUse /preview diagrams N to inspect, expand or copy one` : 'No Mermaid diagrams in the last 10 responses' };
      const item = found[Number(words[1]) - 1];
      if (!item) return { display: `No diagram ${words[1]}; /preview diagrams lists them` };
      let drawn: string;
      try {
        drawn = diagram(item.source, diagrams !== 'ascii', 160).lines.join('\n');
        if (size(drawn) > DRAWN_BYTES) throw new Error(`the drawing is over ${DRAWN_BYTES / 1000} KB`);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        drawn = `Not drawn: ${error.message}${size(item.source) > SOURCE_BYTES ? '; source shown and copied up to 4 KB' : ''}`;
      }
      save({ inline: { title: `Diagram ${words[1]} (response ${item.response})`, kind: 'diagram', text: drawn, source: clamp(item.source, SOURCE_BYTES).text }, revision: load().revision + 1 });
      return null;
    }
    if (target === 'list') {
      const lines = responses(10).map((text, index) => `${index + 1}. ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
      return { display: lines.join('\n') || 'No responses in this session yet' };
    }
    if (!target || /^\d+$/.test(target)) {
      const index = Math.max(1, Number(target || 1));
      const text = responses(Math.min(index, 20))[index - 1];
      if (text === undefined) return { display: `No response ${index} in this session` };
      return inline ? show(`Response ${index}`, 'markdown', text) : open(render(`${DIR}/response.html`, `Response ${index}`, undefined, text), `response ${index}`);
    }
    const file = api.host.call('workspace.stat', { paths: [target] }).files[target];
    if (file?.kind !== 'file') return { display: `No file ${target} in the workspace` };
    if (inline) {
      if (file.size > 1_000_000) return { display: `${target} is too large to show inline; use /preview ${target}` };
      return show(target, inlineKind(target), api.host.call('workspace.read', { paths: [target] }).files[target]?.text ?? '');
    }
    if (words.includes('--watch')) {
      const watch = [...new Set([...load().watch, target])];
      if (watch.length > MAX_WATCHES) return { display: `At most ${MAX_WATCHES} files can be watched; use /preview unwatch` };
      save({ watch });
      api.host.tryCall('events.publish', { channel: 'watch', data: null });
    }
    return open(render(outputFor(target), target, target), target);
  };

  const poll = () => {
    const { watch, hashes } = load();
    if (!watch.length) return;
    const stat = api.host.tryCall('workspace.stat', { paths: watch, hash: true });
    if (stat.ok) {
      const next = Object.fromEntries(watch.map(path => [path, stat.value.files[path]?.sha256 ?? '']));
      for (const path of watch) if (hashes[path] !== undefined && next[path] && next[path] !== hashes[path]) render(outputFor(path), path, path);
      save({ hashes: next });
    }
    api.host.tryCall('events.schedule', { key: 'poll', delay_ms: POLL_MS });
  };

  const refresh = () => {
    const draft = api.host.tryCall('composer.read', null), images = draft.ok ? pictures(draft.value) : [], state = load();
    if (JSON.stringify(images) === JSON.stringify(state.images)) return;
    const stale = state.inline?.kind === 'image' && !images.some(picture => picture.id === state.inline!.text);
    save({ images, ...(stale ? { inline: null } : {}) });
  };

  api.command('preview', value => {
    try {
      return preview(String(value ?? '').trim().split(/\s+/).filter(Boolean));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { display: `/preview: ${error.message}` };
    }
  }, { description: 'Render a response or file as HTML (--inline shows it here), inspect Mermaid diagrams or preview draft images' });

  for (const event of ['channel', 'timer'] as const) api.on(event, poll);
  for (const event of ['start', 'resume'] as const) api.on(event, () => { poll(); if (thumbnails) refresh(); });
  if (thumbnails) {
    api.on('composer', event => { if (event.kind === 'change') refresh(); });
    api.on('component_event', event => {
      const index = /^omd_preview_thumb_(\d+)$/.exec(event.component)?.[1];
      const picture = index === undefined ? undefined : load().images[Number(index)];
      if (picture && event.kind === 'pointer' && event.pointer?.action === 'down' && event.pointer.button === 'left') viewImage(picture);
    });
  }
  if (diagrams !== 'off') {
    api.intercept('render', { match: { component: 'assistant_message', lifecycle: 'final', props: { text: [api.match.glob('*\x60\x60\x60mermaid*'), api.match.glob('*~~~mermaid*')] } } }, event => {
      const { viewport, props } = event as RenderEvent<'assistant_message'>;
      const tree = presentation(props.text, diagrams === 'unicode', Math.max(20, viewport.columns - 3));
      if (!tree || tree.length > 60) return { tree: [{ type: 'native' }] };
      if (size(props.text) >= 4_090) return { tree: [{ type: 'native' }, { type: 'box', id: 'omd_preview_diagrams', label: 'Drawn diagrams', title: 'Diagrams drawn from the start of this response', children: tree.filter(node => node.type !== 'markdown') }] };
      return { tree: [{ type: 'box', id: 'omd_preview_response', label: 'Response', children: [{ type: 'box', id: 'omd_preview_response_body', label: 'Response', children: tree }] }] };
    });
  }

  const dialog = (inline: Inline, revision: number): TerminalComponent[] => {
    const close: TerminalComponent = { type: 'button', id: 'omd_preview_close', label: 'Close preview', text: 'Close', action: { command: 'omd_preview:preview', args: 'close' } };
    if (inline.kind === 'image' && inline.image) return [
      { type: 'image', id: `omd_preview_image_${revision}`, label: `${inline.title} preview`, image: inline.image, alt: inline.title, height: 16 },
      { type: 'text', id: 'omd_preview_image_note', label: 'Image note', text: `${inline.title} stays in the draft; Esc or Close returns to it`, tone: 'muted' }, close];
    if (inline.kind === 'diagram') return [
      { type: 'pane', id: `omd_preview_pane_${revision}`, label: 'Diagram and source, scroll with arrows or the mouse wheel', children: [
        ...chunks(inline.text.split('\n')).map((text, index): TerminalComponent => ({ type: 'text', id: `omd_preview_drawn_${index}`, label: 'Drawn diagram', text })),
        { type: 'code', id: 'omd_preview_source', label: 'Mermaid source', text: inline.source ?? '', language: 'mermaid' }] },
      { type: 'button', id: 'omd_preview_copy', label: 'Copy the Mermaid source', text: 'Copy source', action: { copy: inline.source || ' ', label: 'Mermaid source' } }, close];
    const id = `omd_preview_body_${revision}`;
    const body: TerminalComponent = inline.kind === 'markdown' ? { type: 'markdown', id, label: inline.title, text: inline.text }
      : inline.kind === 'diff' ? { type: 'diff', id, label: inline.title, unified: inline.text }
        : { type: 'code', id, label: inline.title, text: inline.text, language: inline.kind };
    return [{ type: 'pane', id: `omd_preview_pane_${revision}`, label: 'Preview content, scroll with arrows or the mouse wheel', children: [body] }, close];
  };

  api.on('terminal', () => {
    const { inline, revision, images } = load();
    const sites: Partial<Record<'dialog' | 'above_composer', TerminalRenderSite>> = {};
    if (inline) sites.dialog = { mode: 'replace', components: [{ type: 'dialog', id: 'omd_preview_dialog', label: 'Preview', title: inline.title, children: dialog(inline, revision) }] };
    if (thumbnails && images.length) sites.above_composer = { mode: 'wrap', components: [{ type: 'slot' }, {
      type: 'box', id: 'omd_preview_images', label: 'Draft images', title: `Draft image${images.length === 1 ? '' : 's'} (${images.length})`, children: [
        ...images.slice(0, SHOWN_IMAGES).flatMap((picture, index): TerminalComponent[] => picture.image ? [
          { type: 'image', id: `omd_preview_thumb_${index}`, label: `${picture.label} thumbnail`, image: picture.image, alt: picture.label, height: 3, pointer: true },
          { type: 'button', id: `omd_preview_open_${index}`, label: `Preview ${picture.label}`, text: `Preview ${picture.label}`, action: { command: 'omd_preview:preview', args: `image ${index + 1}` } },
        ] : [{ type: 'text', id: `omd_preview_thumb_${index}`, label: picture.label, text: `${picture.label}: no preview (only PNG and JPEG images up to 8 MiB)`, tone: 'muted' }]),
        ...(images.length > SHOWN_IMAGES ? [{ type: 'text', id: 'omd_preview_more', label: 'More images', text: `+${images.length - SHOWN_IMAGES} more: /preview image ${SHOWN_IMAGES + 1} to ${images.length}`, tone: 'muted' } as TerminalComponent] : []),
      ] }] };
    return Object.keys(sites).length ? { sites } : null;
  });
}
