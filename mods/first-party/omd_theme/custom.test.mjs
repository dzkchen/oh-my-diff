import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseScene, customScene, loadCollection } from './custom.ts';
import { compose, pack } from './scenes.ts';
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

test('effect files reject unknown effects, bad palettes, unsupported fields and unbounded artwork', () => {
  const file = JSON.parse(readFileSync(new URL('./collection/ember.omd-scene.json', import.meta.url), 'utf8'));
  for (const change of [
    s => s.layers[0].effect = 'constructor',
    s => s.layers[0].effect = 'execute',
    s => s.layers[0].colors.pop(),
    s => s.layers[0].colors[0] = 'red',
    s => s.layers[0].art = [],
    s => s.layers[0].art[0] = [],
    s => s.layers[0].art[0] = Array(49).fill('#'),
    s => s.layers[0].art[0][0] = '#'.repeat(97),
    s => s.layers[0].code = 'anything',
    s => s.layers[0].alpha = 0,
  ]) {
    const invalid = structuredClone(file);
    change(invalid);
    assert.throws(() => parseScene(invalid));
  }
});

test('standalone bundled files preserve the original rendered frames and can be used as imported scenes', () => {
  const files = loadCollection(name => readFileSync(new URL(name, import.meta.url), 'utf8'));
  const signatures = {
    ember: 'd059e4c57df3d70b874c73b3c124dd62629f2a45681444b353b2ee732bf6c024',
    drift: 'e213de54b64129179357fb4c4627cc3ae5ebaf3fae7a3179dc14e9486c9a2050',
    lagoon: '90562755660ff7f0f261d0bf32bf39e996ea04ae4142e480193fcab8b5f07662',
    jelly: '72292880c943d1796d868de13268c74750f151e493a15dd6ad9196d1f0604cd3',
    fireflies: '06e1696029325823b17ae14dc3c2461758e0da6f2e1ed63714458f4f9749f1b0',
    moonlit: '07337ae9a5aad8cb15114ad06f294f738bdada022929a9e50e298163e8f127a3',
    aurora: 'aada82d4e80c980068d680547f9d69583b04cd93e6c1dbbc85a87b847cf3289e',
    koi: '23a0151ba413b569649d3d364c3c1c68058b9977dbedd627d16dbcd7f5f628b8',
    prism: 'a7325861199bab179e4c6f2b5a081697e3076f86d5248c7fb8c3def7bce9e152',
    horizon: '5d58c0560bb50a94fad6d071fafd08f1cffea81163ae17673ed68301d4a97f4b',
  };
  for (const file of files) {
    const canvas = compose(file.id, null, 1, 120, 44, 1, null, 30, 0, [], files);
    assert.equal(createHash('sha256').update(pack(canvas, { x: 0, y: 0, width: 120, height: 44 })).digest('hex'), signatures[file.id], file.id);
    const imported = new Canvas(120, 44, 1, null);
    customScene(parseScene(structuredClone(file))).paint(imported, 30);
    assert.deepEqual(imported, canvas);
  }
});

test('scene collections reject duplicates, reserved IDs and invalid file lists', () => {
  const file = example();
  for (const [paths, scene] of [[{}, file], [[1], file], [['a', 'b'], file], [['a'], { ...file, id: 'off' }], [['a'], { ...file, id: 'image' }]]) {
    assert.throws(() => loadCollection(name => JSON.stringify(name === 'collection.json' ? paths : scene)));
  }
});
