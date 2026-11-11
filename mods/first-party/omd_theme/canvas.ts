export type Rgb = number;
export type Sample = { label: string; width: number; height: number; rgb: string };
export type Palette = { tint: [Rgb, Rgb]; accent: Rgb };
export type Scene = { id: string; name: string; detail: string; palette?: Palette; paint(c: Canvas, t: number): void };
export type Rect = { x: number; y: number; width: number; height: number };

export const TEXTURE = '$%St#&*+=@oS';
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SPACE = 32;
export const REVEAL_MS = 350;
export const PANE_SHADE = 0.5;
export const GLYPH_SHADE = 0.6;
export const FRAME_SECONDS = 0.125;
export const STILL_SECONDS = 24;

export const R = (c: Rgb) => c >>> 16 & 255;
export const G = (c: Rgb) => c >>> 8 & 255;
export const B = (c: Rgb) => c & 255;
export const clamp = (value: number, low: number, high: number) => value < low ? low : value > high ? high : value;
export const rgb = (r: number, g: number, b: number): Rgb => (Math.round(clamp(r, 0, 255)) << 16) | (Math.round(clamp(g, 0, 255)) << 8) | Math.round(clamp(b, 0, 255));
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = clamp(t, 0, 1);
  return rgb(R(a) + (R(b) - R(a)) * k, G(a) + (G(b) - G(a)) * k, B(a) + (B(b) - B(a)) * k);
};
export const lift = (a: Rgb, b: Rgb, t: number): Rgb => rgb(R(a) + R(b) * t, G(a) + G(b) * t, B(a) + B(b) * t);
export const hex = (c: Rgb) => `#${c.toString(16).padStart(6, '0')}` as const;
export const hash = (a: number, b: number, c = 0) => {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};
export const rand = (a: number, b: number, c = 0) => hash(a, b, c) / 4294967296;
export const wrap = (value: number, size: number) => ((value % size) + size) % size;
export const step = (value: number, steps: number) => Math.round(value * steps) / steps;

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly density: number;
  readonly sample: Sample | null;
  readonly cols: number;
  readonly glyph: Uint32Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  energy = 0;

  constructor(width: number, height: number, density: number, sample: Sample | null) {
    this.width = width;
    this.height = height;
    this.density = density;
    this.sample = sample;
    this.cols = Math.ceil(width / 2);
    this.glyph = new Uint32Array(width * height).fill(SPACE);
    this.fg = new Uint32Array(width * height);
    this.bg = new Uint32Array(width * height);
  }

  sky(stops: Rgb[]) {
    for (let y = 0; y < this.height; y++) {
      const v = this.height > 1 ? y / (this.height - 1) * (stops.length - 1) : 0;
      const i = Math.min(stops.length - 2, Math.floor(v));
      const color = mix(stops[i], stops[i + 1], v - i);
      this.bg.fill(color, y * this.width, (y + 1) * this.width);
      this.fg.fill(color, y * this.width, (y + 1) * this.width);
    }
  }

  shade(y: number, x: number, color: Rgb, alpha: number) {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    const at = y * this.width + x;
    this.bg[at] = mix(this.bg[at], color, alpha);
  }

  light(at: number, color: Rgb, strength: number) {
    this.bg[at] = lift(this.bg[at], color, strength);
  }

  shaft(x: number, slope: number, width: number, color: Rgb, strength: number) {
    const x0 = step(x, 2);
    for (let y = 0; y < this.height; y++) {
      const center = x0 + slope * y;
      const fade = strength * (1 - 0.6 * y / this.height);
      const from = Math.max(0, Math.floor((center - width * 2.5) * 2));
      const to = Math.min(this.width - 1, Math.ceil((center + width * 2.5) * 2));
      for (let x = from; x <= to; x++) {
        const d = (x / 2 - center) / width;
        this.light(y * this.width + x, color, fade * Math.exp(-d * d));
      }
    }
  }

  glow(x: number, y0: number, radius: number, color: Rgb, power: number) {
    const cx = step(x, 2);
    const cy = Math.round(y0);
    const strength = step(power, 25);
    if (radius <= 0 || strength <= 0) return;
    const top = Math.max(0, Math.floor(cy - radius));
    const bottom = Math.min(this.height - 1, Math.ceil(cy + radius));
    const left = Math.max(0, Math.floor((cx - radius) * 2));
    const right = Math.min(this.width - 1, Math.ceil((cx + radius) * 2));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const d = Math.hypot(x / 2 - cx, y - cy) / radius;
        if (d < 1) this.light(y * this.width + x, color, strength * (1 - d) * (1 - d));
      }
    }
  }

  tile(tx: number, y: number, color: Rgb, alpha: number) {
    if (y < 0 || y >= this.height || alpha <= 0) return;
    for (let x = tx * 2; x < tx * 2 + 2; x++) {
      if (x < 0 || x >= this.width) continue;
      const at = y * this.width + x;
      const bg = mix(this.bg[at], color, alpha * 0.55);
      this.bg[at] = bg;
      this.fg[at] = mix(bg, lift(color, 0xffffff, 0.12), 0.55 + 0.4 * alpha);
      this.glyph[at] = TEXTURE.charCodeAt(hash(x, y, 7) % TEXTURE.length);
    }
  }

  dot(x: number, y: number, glyph: string, color: Rgb, alpha: number) {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width || alpha <= 0) return;
    const at = y * this.width + x;
    this.glyph[at] = glyph.charCodeAt(0);
    this.fg[at] = mix(this.bg[at], color, alpha);
  }

  grid(color: Rgb, alpha: number) {
    for (let y = 1; y < this.height; y += 2) {
      for (let x = (y >> 1) % 2 * 2; x < this.width; x += 4) this.dot(x, y, '·', color, alpha);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, paint: (tx: number, y: number, d: number) => void) {
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(this.height - 1, Math.ceil(cy + ry)); y++) {
      for (let tx = Math.max(0, Math.floor(cx - rx)); tx <= Math.min(this.cols - 1, Math.ceil(cx + rx)); tx++) {
        const d = Math.hypot((tx - cx) / rx, (y - cy) / ry);
        if (d < 1) paint(tx, y, d);
      }
    }
  }

  blob(cx: number, cy: number, rx: number, ry: number, color: Rgb, alpha: number) {
    this.ellipse(Math.round(cx), cy, rx, ry, (tx, y, d) => this.tile(tx, y, color, alpha * (1 - d ** 4)));
  }

  sprite(art: string[], tx: number, ty: number, colors: Record<string, Rgb>, alpha: number) {
    art.forEach((row, dy) => [...row].forEach((key, dx) => { if (key in colors) this.tile(tx + dx, ty + dy, colors[key], alpha); }));
  }

  particles(count: number, seed: number, t: number, vx: number, vy: number, glyphs: string, colors: Rgb[], alpha: number, sway = 0) {
    for (let i = 0; i < Math.round(count * this.density); i++) {
      const speed = 0.6 + 0.8 * rand(i, seed, 3);
      const x = wrap(rand(i, seed, 1) * this.width + vx * 2 * t * speed + sway * 2 * Math.sin(t * 1.3 + i), this.width);
      const y = wrap(rand(i, seed, 2) * this.height + vy * t * speed, this.height);
      const twinkle = 0.6 + 0.2 * Math.round(2 * Math.sin(t * 1.7 + i * 2.3));
      const fade = vy < 0 ? Math.min(1, 0.2 + y / this.height) : 1;
      this.dot(Math.floor(x), Math.floor(y), glyphs[i % glyphs.length], colors[i % colors.length], alpha * twinkle * fade);
    }
  }
}
