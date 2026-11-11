import { EFFECTS, paintEffect } from './effects.ts';
import type { Effect } from './effects.ts';
import { Canvas } from './canvas.ts';
import type { Scene } from './canvas.ts';

type Motion = number | { base: number; amplitude?: number; period?: number; phase?: number; drift?: number };
type Layer = { kind: 'glow' | 'blob' | 'particles' | 'sprite' | 'effect'; effect?: Effect; art?: string[][]; x?: Motion; y?: Motion; radius?: Motion; width?: Motion; height?: Motion; alpha?: Motion; color?: string; colors?: string[]; count?: number; seed?: number; vx?: number; vy?: number; sway?: number; glyphs?: string; rows?: string[]; ink?: Record<string, string> };
export type SceneFile = { format: 'omd-scene'; version: 1; id: string; name: string; detail: string; sky: string[]; palette: { tint: [string, string]; accent: string }; layers: Layer[] };
const color = (value: string) => parseInt(value.slice(1), 16);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown scene field');
};
const number = (value: unknown, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Expected a number between ${min} and ${max}`);
};
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid scene text');
};
const paintColor = (value: unknown) => {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Colors must be #rrggbb');
};
const motion = (value: unknown) => {
  if (typeof value === 'number') return number(value, -4, 4);
  const m = object(value);
  keys(m, ['base', 'amplitude', 'period', 'phase', 'drift']);
  number(m.base, -4, 4);
  if (m.amplitude !== undefined) number(m.amplitude, 0, 4);
  if (m.period !== undefined) number(m.period, 0.25, 3600);
  if (m.phase !== undefined) number(m.phase, -100, 100);
  if (m.drift !== undefined) number(m.drift, -1, 1);
};
export function parseScene(value: unknown): SceneFile {
  const s = object(value);
  keys(s, ['format', 'version', 'id', 'name', 'detail', 'sky', 'palette', 'layers']);
  if (s.format !== 'omd-scene' || s.version !== 1) throw new Error('Expected an omd-scene file, version 1');
  if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(s.id)) throw new Error('Scene id must use lowercase letters, digits and hyphens');
  text(s.name, 64); text(s.detail, 240);
  if (!Array.isArray(s.sky) || s.sky.length < 2 || s.sky.length > 8) throw new Error('Use 2–8 sky colors');
  s.sky.forEach(paintColor);
  const p = object(s.palette); keys(p, ['tint', 'accent']);
  if (!Array.isArray(p.tint) || p.tint.length !== 2) throw new Error('Use two palette tint colors');
  p.tint.forEach(paintColor); paintColor(p.accent);
  if (!Array.isArray(s.layers) || s.layers.length > 24) throw new Error('Use at most 24 layers');
  for (const value of s.layers) {
    const l = object(value);
    const common = l.kind === 'effect' ? ['kind'] : ['kind', 'alpha'];
    const fields = l.kind === 'effect' ? ['effect', 'colors', 'art'] : l.kind === 'particles' ? ['count', 'seed', 'vx', 'vy', 'sway', 'glyphs', 'colors'] : l.kind === 'sprite' ? ['x', 'y', 'rows', 'ink'] : l.kind === 'glow' ? ['x', 'y', 'radius', 'color'] : l.kind === 'blob' ? ['x', 'y', 'width', 'height', 'color'] : null;
    if (!fields) throw new Error('Unknown layer kind');
    keys(l, [...common, ...fields]);
    for (const field of ['x', 'y', 'radius', 'width', 'height', 'alpha']) if (l[field] !== undefined) motion(l[field]);
    if (l.kind === 'effect') {
      if (typeof l.effect !== 'string' || !Object.hasOwn(EFFECTS, l.effect)) throw new Error('Unknown drawing effect');
      const spec = EFFECTS[l.effect as Effect];
      if (!Array.isArray(l.colors) || l.colors.length !== spec.colors) throw new Error(`Use ${spec.colors} effect colors`);
      l.colors.forEach(paintColor);
      if (spec.art || l.art !== undefined) {
        if (!Array.isArray(l.art) || l.art.length !== spec.art) throw new Error(`Use ${spec.art} effect art frames`);
        for (const rows of l.art) {
          if (!Array.isArray(rows) || !rows.length || rows.length > 48) throw new Error('Use 1–48 art rows');
          rows.forEach(row => text(row, 96));
        }
      }
    } else if (l.kind === 'particles') {
      number(l.count, 0, 100); number(l.seed ?? 1, 0, 65535);
      for (const field of ['vx', 'vy', 'sway']) number(l[field] ?? 0, -10, 10);
      text(l.glyphs, 16);
      if (!/^[\x20-\x7e]+$/.test(l.glyphs as string)) throw new Error('Particle glyphs must be printable ASCII');
      if (!Array.isArray(l.colors) || !l.colors.length || l.colors.length > 8) throw new Error('Use 1–8 particle colors');
      l.colors.forEach(paintColor);
    } else if (l.kind === 'sprite') {
      if (!Array.isArray(l.rows) || !l.rows.length || l.rows.length > 48) throw new Error('Use 1–48 sprite rows');
      l.rows.forEach(row => text(row, 96));
      const ink = object(l.ink);
      if (Object.keys(ink).length > 32 || Object.keys(ink).some(key => key.length !== 1)) throw new Error('Use at most 32 single-character ink keys');
      Object.values(ink).forEach(paintColor);
    } else {
      paintColor(l.color);
      for (const field of l.kind === 'glow' ? ['radius'] : ['width', 'height']) if (l[field] === undefined) throw new Error(`Missing ${field}`);
    }
  }
  if (JSON.stringify(s).length > 16384) throw new Error('Scene exceeds 16 KiB');
  return s as unknown as SceneFile;
}
const animate = (value: Motion | undefined, t: number, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const base = value.base + (value.drift ?? 0) * t;
  return (value.drift ? ((base % 1) + 1) % 1 : base) + (value.amplitude ?? 0) * Math.sin(t * Math.PI * 2 / (value.period ?? 8) + (value.phase ?? 0));
};
export function customScene(file: SceneFile, id = `custom:${file.id}`): Scene {
  return { id, name: file.name, detail: file.detail,
    palette: { tint: [color(file.palette.tint[0]), color(file.palette.tint[1])], accent: color(file.palette.accent) },
    paint(c: Canvas, t: number) {
      c.sky(file.sky.map(color));
      for (const l of file.layers) {
        if (l.kind === 'effect') {
          paintEffect(l.effect!, c, t, l.colors!.map(color), l.art);
          continue;
        }
        const x = animate(l.x, t, 0.5) * c.cols, y = animate(l.y, t, 0.5) * c.height;
        const alpha = Math.max(0, Math.min(1, animate(l.alpha, t, 1)));
        if (l.kind === 'glow') c.glow(x, y, Math.max(0, animate(l.radius, t, 0.2)) * Math.min(c.cols, c.height), color(l.color!), alpha);
        if (l.kind === 'blob') c.blob(x, y, Math.max(0.01, animate(l.width, t, 0.2)) * c.cols, Math.max(0.01, animate(l.height, t, 0.2)) * c.height, color(l.color!), alpha);
        if (l.kind === 'particles') c.particles(l.count!, l.seed ?? 1, t, l.vx ?? 0, l.vy ?? 0, l.glyphs!, l.colors!.map(color), alpha, l.sway ?? 0);
        if (l.kind === 'sprite') c.sprite(l.rows!, Math.round(x), Math.round(y), Object.fromEntries(Object.entries(l.ink!).map(([key, value]) => [key, color(value)])), alpha);
      }
    },
  };
}

export function loadCollection(read: (name: string) => string): SceneFile[] {
  const paths: unknown = JSON.parse(read('collection.json'));
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('Invalid scene collection');
  const files = paths.map(path => parseScene(JSON.parse(read(path))));
  if (new Set(files.map(file => file.id)).size !== files.length || files.some(file => ['off', 'image'].includes(file.id))) throw new Error('Duplicate or reserved scene id');
  return files;
}
