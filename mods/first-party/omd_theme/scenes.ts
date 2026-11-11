import { customScene } from './custom.ts';
import type { SceneFile } from './custom.ts';
import { Canvas, TEXTURE, hash, wrap, ALPHABET, R, G, B, rgb, mix, clamp, REVEAL_MS, PANE_SHADE, GLYPH_SHADE } from './canvas.ts';
import type { Sample, Palette, Rect } from './canvas.ts';
import type { Scene } from './canvas.ts';
export * from './canvas.ts';
const imageScene: Scene = {
  id: 'image', name: 'Your image', detail: 'Your picture drawn as glyph tiles, with a slow light sweep and drifting motes.',
  paint(c, t) {
    const sample = c.sample;
    if (!sample) return c.sky([0x101010, 0x202020]);
    for (let y = 0; y < c.height; y++) {
      const sy = Math.min(sample.height - 1, Math.floor(y / c.height * sample.height));
      for (let tx = 0; tx < c.cols; tx++) {
        const sx = Math.min(sample.width - 1, Math.floor(tx / c.cols * sample.width));
        const at = (sy * sample.width + sx) * 6;
        const color = parseInt(sample.rgb.slice(at, at + 6), 16);
        for (let x = tx * 2; x < Math.min(c.width, tx * 2 + 2); x++) {
          c.bg[y * c.width + x] = mix(color, 0x000000, 0.35);
          c.fg[y * c.width + x] = mix(color, 0xffffff, 0.15);
          c.glyph[y * c.width + x] = TEXTURE.charCodeAt(hash(x, y, 7) % TEXTURE.length);
        }
      }
    }
    c.shaft(wrap(t * 1.5, c.cols + 20) - 10, 0.5, 3, 0xffffff, 0.12);
    c.particles(16, 11, t, 0.3, -0.2, '·', [0xffffff], 0.5);
  },
};
export const catalog = (files: SceneFile[] = [], bundled: SceneFile[] = []) => [...bundled.map(file => customScene(file, file.id)), ...files.map(file => customScene(file)), imageScene];
export const scene = (id: string | null | undefined, files: SceneFile[] = [], bundled: SceneFile[] = []) => catalog(files, bundled).find(item => item.id === id) ?? null;

export function samplePalette(sample: Sample): Palette {
  const average = (from: number, to: number) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = from; y < to; y++) {
      for (let x = 0; x < sample.width; x++) {
        const color = parseInt(sample.rgb.slice((y * sample.width + x) * 6, (y * sample.width + x) * 6 + 6), 16);
        r += R(color); g += G(color); b += B(color); n++;
      }
    }
    return n ? rgb(r / n, g / n, b / n) : 0x202020;
  };
  const top = mix(average(Math.floor(sample.height * 0.5), Math.floor(sample.height * 0.75)), 0x000000, 0.6);
  const bottom = mix(average(Math.floor(sample.height * 0.75), sample.height), 0x000000, 0.65);
  return { tint: [top, bottom], accent: mix(mix(average(0, sample.height), 0xffffff, 0.45), 0xffffff, 0.5) };
}

export function compose(id: string, previous: string | null, progress: number, width: number, height: number, density: number, sample: Sample | null, t: number, energy = 0, files: SceneFile[] = [], bundled: SceneFile[] = []): Canvas {
  const draw = (which: string) => {
    const canvas = new Canvas(width, height, density, sample);
    canvas.energy = clamp(energy, 0, 1);
    scene(which, files, bundled)?.paint(canvas, t);
    return canvas;
  };
  const next = draw(id);
  if (!previous || previous === 'off' || previous === id || progress >= 1) return next;
  const old = draw(previous);
  const cx = next.cols / 2;
  const cy = height / 2;
  const reach = progress * Math.hypot(cx, cy) * 1.05;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x / 2 - cx, y - cy);
      const at = y * width + x;
      if (d > reach + 0.8) {
        next.glyph[at] = old.glyph[at];
        next.fg[at] = old.fg[at];
        next.bg[at] = old.bg[at];
      } else if (d > reach - 0.8) {
        next.glyph[at] = '·'.charCodeAt(0);
        next.fg[at] = 0xffffff;
        next.bg[at] = mix(next.bg[at], 0xffffff, 0.25);
      }
    }
  }
  return next;
}

export const revealProgress = (elapsedMs: number) => elapsedMs / REVEAL_MS;

export function shade(canvas: Canvas, amount: number, cap: number): Canvas {
  for (let at = 0; at < canvas.bg.length; at++) {
    const bg = mix(canvas.bg[at], 0x000000, amount);
    const peak = Math.max(R(bg), G(bg), B(bg));
    canvas.bg[at] = peak > cap ? mix(bg, 0x000000, 1 - cap / peak) : bg;
    canvas.fg[at] = mix(canvas.fg[at], 0x000000, amount * GLYPH_SHADE);
  }
  return canvas;
}

/** The scene drawn in the chat column of a screen-sized canvas; elsewhere (panes, sidebars) each row gets the scene row's edge colour, darkened. */
export function place(chat: Canvas, width: number, height: number, x: number, y: number): Canvas {
  const out = new Canvas(width, height, chat.density, chat.sample);
  for (let row = 0; row < height; row++) {
    const from = Math.min(chat.height - 1, Math.max(0, row - y)) * chat.width;
    out.bg.fill(mix(mix(chat.bg[from], chat.bg[from + chat.width - 1], 0.5), 0x000000, PANE_SHADE), row * width, (row + 1) * width);
    if (row < y || row >= y + chat.height) continue;
    const span = Math.min(chat.width, width - x);
    out.glyph.set(chat.glyph.subarray(from, from + span), row * width + x);
    out.fg.set(chat.fg.subarray(from, from + span), row * width + x);
    out.bg.set(chat.bg.subarray(from, from + span), row * width + x);
  }
  return out;
}

const base64 = (bytes: Uint8Array) => {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out.push(ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '='));
  }
  return out.join('');
};

export function pack(frame: Canvas, rect: Rect): string {
  const view = new DataView(new ArrayBuffer(rect.width * rect.height * 12));
  let at = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const cell = y * frame.width + x;
      view.setUint32(at, frame.glyph[cell], true);
      view.setUint32(at + 4, frame.fg[cell], true);
      view.setUint32(at + 8, frame.bg[cell], true);
      at += 12;
    }
  }
  return base64(new Uint8Array(view.buffer));
}

/** Changed cells as bands of adjacent rows up to `limit` cells; the host drops the unchanged cells a band repeats. */
export function changed(previous: Canvas, next: Canvas, limit = Infinity): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < next.height; y++) {
    let left = -1, right = -1;
    for (let x = 0; x < next.width; x++) {
      const at = y * next.width + x;
      if (previous.glyph[at] === next.glyph[at] && previous.fg[at] === next.fg[at] && previous.bg[at] === next.bg[at]) continue;
      if (left < 0) left = x;
      right = x;
    }
    if (left < 0) continue;
    const last = out.at(-1);
    if (last && last.y + last.height === y) {
      const x = Math.min(last.x, left), end = Math.max(last.x + last.width, right + 1);
      if ((end - x) * (last.height + 1) <= limit) {
        Object.assign(last, { x, width: end - x, height: last.height + 1 });
        continue;
      }
    }
    out.push({ x: left, y, width: right - left + 1, height: 1 });
  }
  return out;
}
