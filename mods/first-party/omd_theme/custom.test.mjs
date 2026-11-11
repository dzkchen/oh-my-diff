import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScene, customScene } from './custom.ts';
import { Canvas } from './canvas.ts';

const example = () => JSON.parse(readFileSync(new URL('./examples/lanterns.omd-scene.json', import.meta.url), 'utf8'));
test('shared animation adapts to screen size and freezes at a fixed time', () => {
  const scene = customScene(parseScene(example()));
  for (const [width, height] of [[60,18], [120,44], [200,60]]) {
    const draw = t => { const c = new Canvas(width,height,1,null); scene.paint(c,t); return c; };
    assert.deepEqual(draw(24), draw(24));
    assert.notDeepEqual(draw(24), draw(25));
    assert(draw(24).glyph.some(value => value !== 32));
  }
});
test('scene validation bounds rendering work and rejects unsupported fields and values', () => {
  for (const change of [
    s => s.layers.push({kind:'particles',count:1000000,glyphs:'*',colors:['#ffffff']}),
    s => s.layers[0].radius = {base:1,period:0},
    s => s.layers[0].radius = Infinity,
    s => s.layers[0].color = 'white',
    s => s.layers = Array(25).fill(s.layers[0]),
    s => s.layers[0].code = 'arbitrary code',
    s => s.palette.tint = [],
    s => s.name = '\u001b[31m',
    s => s.id = '../outside',
    s => s.layers[2].rows = Array(49).fill('a'),
  ]) { const s=example(); change(s); assert.throws(()=>parseScene(s)); }
});

test('particle glyphs cannot introduce code points refused by packed rasters', () => {
  for (const glyphs of ['界', '\u0301', '😀', '\ud800', '\u0085']) {
    const file = example();
    file.layers[1].glyphs = glyphs;
    assert.throws(() => parseScene(file), /glyph/i, JSON.stringify(glyphs));
  }
});

test('large custom blobs visit only visible tiles', () => {
  const file = example();
  file.layers = [{ kind: 'blob', width: { base: 4, amplitude: 4, period: 1 }, height: 4, color: '#ffffff' }];
  const c = new Canvas(60, 18, 1, null);
  let visits = 0;
  const tile = c.tile.bind(c);
  c.tile = (x, ...args) => { visits++; assert(x >= 0 && x < c.cols); tile(x, ...args); };
  customScene(parseScene(file)).paint(c, 24.25);
  assert(visits > 0 && visits <= c.cols * c.height);
});
