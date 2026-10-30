export type Rgb = number;
export type Sample = { label: string; width: number; height: number; rgb: string };
export type Palette = { tint: [Rgb, Rgb]; body: Rgb; eye: Rgb; accent: Rgb };
export type Scene = { id: string; name: string; detail: string; palette: Palette; paint(c: Canvas, t: number): void };
export type Rect = { x: number; y: number; width: number; height: number };

const TEXTURE = '$%St#&*+=@oS';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SPACE = 32;
const REVEAL_MS = 1200;
export const FRAME_SECONDS = 0.125;
export const STILL_SECONDS = 24;

const R = (c: Rgb) => c >>> 16 & 255;
const G = (c: Rgb) => c >>> 8 & 255;
const B = (c: Rgb) => c & 255;
const clamp = (value: number, low: number, high: number) => value < low ? low : value > high ? high : value;
const rgb = (r: number, g: number, b: number): Rgb => (Math.round(clamp(r, 0, 255)) << 16) | (Math.round(clamp(g, 0, 255)) << 8) | Math.round(clamp(b, 0, 255));
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = clamp(t, 0, 1);
  return rgb(R(a) + (R(b) - R(a)) * k, G(a) + (G(b) - G(a)) * k, B(a) + (B(b) - B(a)) * k);
};
const lift = (a: Rgb, b: Rgb, t: number): Rgb => rgb(R(a) + R(b) * t, G(a) + G(b) * t, B(a) + B(b) * t);
export const hex = (c: Rgb) => `#${c.toString(16).padStart(6, '0')}` as const;
const hash = (a: number, b: number, c = 0) => {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};
const rand = (a: number, b: number, c = 0) => hash(a, b, c) / 4294967296;
const wrap = (value: number, size: number) => ((value % size) + size) % size;
const step = (value: number, steps: number) => Math.round(value * steps) / steps;

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly density: number;
  readonly sample: Sample | null;
  readonly cols: number;
  readonly glyph: Uint32Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;

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
      for (let tx = Math.floor(cx - rx); tx <= Math.ceil(cx + rx); tx++) {
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

const FONT: Record<string, string[]> = {
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  D: ['#### ', '#   #', '#   #', '#   #', '#### '],
};

function mark(c: Canvas, t: number) {
  const scale = c.cols >= 44 && c.height >= 14 ? 2 : 1;
  if (c.cols < 18 || c.height < 6) return;
  const left = Math.floor((c.cols - 17 * scale) / 2);
  const top = Math.max(0, Math.floor((c.height - 5 * scale) / 2) - scale + 1);
  c.glow(c.cols / 2, top + 2.5 * scale, 9 * scale, 0xff7a2a, 0.24);
  ['O', 'M', 'D'].forEach((letter, index) => FONT[letter].forEach((row, dy) => [...row].forEach((pixel, dx) => {
    if (pixel !== '#') return;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const tx = left + (index * 6 + dx) * scale + sx;
        const y = top + dy * scale + sy;
        c.tile(tx, y, mix(0xffc46b, 0xff5a1f, (dy * scale + sy) / (5 * scale)), Math.sin(t * 1.3 + rand(tx, y, 5) * 6.28) > 0.85 ? 1 : 0.85);
      }
    }
  })));
}

const TURTLE = [
  ['......kk...', '..sdsdsd...', 'kssdsdsdskk', '..sdsdsd...', '......kk...'],
  ['....kk.....', '..sdsdsd...', 'kssdsdsdskk', '..sdsdsd...', '....kk.....'],
];

function hills(c: Canvas, base: number, waves: [number, number, number][], color: Rgb, alpha: number) {
  for (let tx = 0; tx < c.cols; tx++) {
    const top = c.height * (base + waves.reduce((sum, [amp, freq, phase]) => sum + amp * Math.sin(tx * freq + phase), 0));
    for (let y = Math.max(0, Math.ceil(top)); y < c.height; y++) {
      c.shade(y, tx * 2, color, alpha);
      c.shade(y, tx * 2 + 1, color, alpha);
    }
  }
}

export const SCENES: Scene[] = [
  {
    id: 'ember', name: 'Ember mark', detail: 'The OMD mark glowing over a banked fire; embers rise and drift on the draft.',
    palette: { tint: [0x2a140c, 0x14090a], body: 0xff8a3d, eye: 0x1a0d0f, accent: 0xffd27a },
    paint(c, t) {
      c.sky([0x0b0910, 0x1a0d0f, 0x34140a]);
      c.glow(c.cols / 2, c.height + 1, c.height * 0.9, 0xff6a1a, 0.38);
      c.grid(0x6b3a26, 0.35);
      mark(c, t);
      c.particles(22, 7, t, 0.15, -1.4, '·•*', [0xffd27a, 0xff8a2a, 0xff4d1a], 0.95, 0.8);
    },
  },
  {
    id: 'drift', name: 'Cloud drift', detail: 'Dusk clouds sliding past at different heights and speeds over a low sun.',
    palette: { tint: [0x2b2550, 0x3b2c4f], body: 0xf3c6d4, eye: 0x2b2550, accent: 0xffe0b0 },
    paint(c, t) {
      c.sky([0x172347, 0x5a4a86, 0xe39a7f]);
      c.glow(c.cols * 0.72, c.height * 1.05, c.height * 0.75, 0xffc78a, 0.45);
      c.grid(0xc9b6e6, 0.12);
      for (let i = 0; i < 4; i++) {
        const rx = 6 + 4 * rand(i, 2) + i;
        const ry = 1.4 + 0.4 * i;
        const x = wrap(rand(i, 1) * c.cols + (0.35 + 0.25 * i) * t, c.cols + 4 * rx) - 2 * rx;
        const y = c.height * (0.12 + 0.2 * i);
        const color = mix(0xf8dfe8, 0x6b5a96, 0.35 - 0.08 * i);
        c.blob(x, y, rx, ry, color, 0.45 + 0.12 * i);
        c.blob(x - rx * 0.45, y + 0.4, rx * 0.6, ry * 0.75, color, 0.45 + 0.12 * i);
        c.blob(x + rx * 0.5, y + 0.45, rx * 0.55, ry * 0.7, color, 0.45 + 0.12 * i);
      }
      c.particles(3, 4, t, 0.9, 0.05, 'vV', [0x2a2340], 0.8, 0.3);
      c.particles(12, 9, t, 0.3, 0, '·', [0xfff1d6], 0.5);
    },
  },
  {
    id: 'lagoon', name: 'Lagoon', detail: 'Light shafts swaying through shallow water while a sea turtle paddles past; bubbles rise.',
    palette: { tint: [0x0d4a57, 0x062733], body: 0x7fd9b0, eye: 0x062433, accent: 0xc8fff5 },
    paint(c, t) {
      c.sky([0x2a9d9a, 0x0d5466, 0x062433, 0x04131c]);
      for (let i = 0; i < 3; i++) c.shaft(c.cols * (0.18 + 0.32 * i) + 2 * Math.sin(t * 0.25 + i * 2), -0.35, 2.2, 0xbff7ee, 0.2);
      for (let x = 0; x < c.width; x++) if (Math.sin(x * 0.5 - Math.floor(t * 4) * 0.25) > 0.3) c.dot(x, 0, '~', 0xc8fff5, 0.7);
      for (let y = c.height - 2; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          c.shade(y, x, 0x4a4632, 0.55);
          if (rand(x, y, 3) > 0.8) c.dot(x, y, rand(x, y, 4) > 0.5 ? '.' : ',', 0x8a8460, 0.8);
        }
      }
      const x = wrap(0.8 * t, c.cols + 24) - 12;
      c.sprite(TURTLE[Math.floor(t * 1.5) % 2], Math.round(x), Math.round(c.height * 0.4 + 1.2 * Math.sin(t * 0.6)), { s: 0x3f8f5a, d: 0x2b6a43, k: 0x9bd28a }, 0.9);
      c.particles(10, 5, t, 0, -1.1, 'o°.', [0xd8fffb], 0.8, 0.6);
    },
  },
  {
    id: 'jelly', name: 'Jellyfish', detail: 'Three glowing jellyfish pulse and rise through deep water, trailing their tentacles.',
    palette: { tint: [0x231446, 0x0f0a2b], body: 0xff9fdc, eye: 0x1b0f3d, accent: 0x9fd9ff },
    paint(c, t) {
      c.sky([0x1b0f3d, 0x0d0a29, 0x05061a]);
      c.shaft(c.cols * 0.6, 0.25, 3, 0x6c5bd6, 0.12);
      c.particles(26, 3, t, 0.15, -0.25, '·.', [0xa9b7ff, 0xffb3e6], 0.6);
      [0xff8fd6, 0x8fd8ff, 0xc39bff].forEach((color, i) => {
        const x = Math.round(c.cols * (0.22 + 0.28 * i) + 3 * Math.sin(t * 0.18 + i * 1.7));
        const y = Math.round(wrap(c.height * (0.3 + 0.25 * i) - 0.45 * t * (0.8 + 0.2 * i), c.height + 10) - 3);
        const pulse = step(0.5 + 0.5 * Math.sin(t * 1.6 + i * 2), 2);
        const rx = 4.5 + 0.8 * pulse;
        const ry = 2.6 - 0.4 * pulse;
        c.glow(x, y, rx * 2.2, color, 0.22);
        c.ellipse(x, y, rx, ry, (tx, row, d) => { if (row <= y) c.tile(tx, row, color, d > 0.7 ? 0.95 : 0.45); });
        for (let tx = Math.round(x - rx); tx <= Math.round(x + rx); tx += 2) c.tile(tx, Math.round(y) + 1, color, 0.5);
        for (let k = 0; k < 4; k++) {
          const from = x - rx * 0.6 + k * rx * 0.4;
          const length = 6 + Math.floor(3 * rand(i, k, 6));
          for (let r = 1; r <= length; r++) {
            c.dot(Math.round((from + 0.8 * Math.sin(t * 2 + r * 0.55 + k)) * 2), Math.round(y) + 1 + r, r % 2 ? '¦' : ':', color, 0.9 - r * 0.08);
          }
        }
      });
    },
  },
  {
    id: 'fireflies', name: 'Fireflies', detail: 'A dark treeline under a night sky; fireflies wander and blink with soft halos.',
    palette: { tint: [0x10261b, 0x0a1a12], body: 0xc9f06b, eye: 0x0b1830, accent: 0xf6ffc2 },
    paint(c, t) {
      c.sky([0x0b1830, 0x0a1a24, 0x07140e]);
      for (let i = 0; i < Math.round(30 * c.density); i++) c.dot(Math.floor(rand(i, 1, 8) * c.width), Math.floor(rand(i, 2, 8) * c.height * 0.4), '.', 0x9fb0d0, 0.5);
      hills(c, 0.58, [[0.08, 0.31, 0], [0.05, 0.87, 1.3]], 0x04100a, 0.75);
      for (let x = 0; x < c.width; x++) if (rand(x, 9) > 0.55) c.dot(x, c.height - 1, '"\',|'[hash(x, 10) % 4], 0x1f4a2a, 0.9);
      for (let i = 0; i < Math.round(12 * c.density); i++) {
        const phase = rand(i, 3, 2) * 6.28;
        const x = step(rand(i, 1, 2) * c.cols + 4 * Math.sin(t * 0.37 * (1 + rand(i, 4, 2)) + phase), 2);
        const y = Math.round(c.height * (0.35 + 0.55 * rand(i, 2, 2)) + 1.6 * Math.sin(t * 0.53 + phase * 1.7));
        const blink = step(Math.max(0, Math.sin(t * (0.9 + rand(i, 5, 2)) + phase)) ** 3, 4);
        if (blink < 0.02) continue;
        c.glow(x, y, 3.2, 0xd6ff5c, 0.42 * blink);
        c.dot(Math.round(x * 2), Math.round(y), '•', 0xf6ffc2, 0.4 + 0.6 * blink);
      }
    },
  },
  {
    id: 'moonlit', name: 'Moonlit night', detail: 'Stars twinkle over rolling hills while a wisp of cloud crosses the moon; now and then a meteor.',
    palette: { tint: [0x151f45, 0x0c1230], body: 0xdfe6ff, eye: 0x111a3a, accent: 0xffcf7a },
    paint(c, t) {
      c.sky([0x050816, 0x111a3a, 0x24305c]);
      for (let i = 0; i < Math.round(70 * c.density); i++) {
        const twinkle = Math.sin(t * (0.8 + 1.5 * rand(i, 3, 9)) + rand(i, 4, 9) * 6.28);
        c.dot(Math.floor(rand(i, 1, 9) * c.width), Math.floor(rand(i, 2, 9) * c.height * 0.7), twinkle > 0.7 ? '+' : twinkle > 0 ? '·' : '.', 0xe6ecff, 0.5 + 0.4 * twinkle);
      }
      const mx = c.cols * 0.74;
      const my = c.height * 0.28;
      const radius = Math.max(2.2, c.height * 0.11);
      c.glow(mx, my, radius * 4.5, 0x8fa4ff, 0.33);
      c.ellipse(mx, my, radius, radius, (tx, y) => c.tile(tx, y, rand(tx, y, 11) > 0.85 ? 0xd9d2b8 : 0xf4efd8, 0.95));
      c.blob(wrap(0.25 * t, c.cols + 30) - 15, my + 0.6, 9, 0.9, 0x3a4675, 0.5);
      const meteor = t % 23;
      if (meteor < 1.4) {
        for (let k = 0; k < 7; k++) {
          const p = meteor - k * 0.05;
          c.dot(Math.round((c.cols * 0.15 + p * c.cols * 0.35) * 2), Math.round(c.height * 0.1 + p * c.height * 0.18), k ? '-' : '*', 0xffffff, 1 - k * 0.13);
        }
      }
      hills(c, 0.7, [[0.08, 0.11, 0.5], [0.04, 0.37, 0]], 0x141a3a, 0.85);
      hills(c, 0.82, [[0.06, 0.2, 2], [0.03, 0.53, 0]], 0x0a0e22, 0.9);
      for (let i = 0; i < Math.round(5 * c.density); i++) {
        const x = Math.floor(rand(i, 1, 12) * c.width);
        if (Math.sin(t * 0.3 + i * 4) > -0.6) c.dot(x, c.height - 1 - (hash(i, 13) % 2), '.', 0xffcf7a, 0.9);
      }
    },
  },
  {
    id: 'image', name: 'Your image', detail: 'Your picture drawn as glyph tiles, with a slow light sweep and drifting motes.',
    palette: { tint: [0x1a1a1a, 0x101010], body: 0xd0d0d0, eye: 0x101010, accent: 0xffffff },
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
  },
];

export const scene = (id: string | null | undefined) => SCENES.find(item => item.id === id) ?? null;

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
  const body = mix(average(0, sample.height), 0xffffff, 0.45);
  return { tint: [top, bottom], body, eye: bottom, accent: mix(body, 0xffffff, 0.5) };
}

export function compose(id: string, previous: string | null, progress: number, width: number, height: number, density: number, sample: Sample | null, t: number): Canvas {
  const draw = (which: string) => {
    const canvas = new Canvas(width, height, density, sample);
    (scene(which) ?? SCENES[0]).paint(canvas, t);
    return canvas;
  };
  const next = draw(id);
  if (!previous || previous === id || progress >= 1) return next;
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
    canvas.fg[at] = mix(canvas.fg[at], 0x000000, amount * 0.6);
  }
  return canvas;
}

/** The scene drawn in the chat column of a screen-sized canvas; elsewhere (panes, sidebars) each row gets the scene row's edge colour, darkened. */
export function place(chat: Canvas, width: number, height: number, x: number, y: number): Canvas {
  const out = new Canvas(width, height, chat.density, chat.sample);
  for (let row = 0; row < height; row++) {
    const from = Math.min(chat.height - 1, Math.max(0, row - y)) * chat.width;
    out.bg.fill(mix(mix(chat.bg[from], chat.bg[from + chat.width - 1], 0.5), 0x000000, 0.5), row * width, (row + 1) * width);
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

export function changed(previous: Canvas | null, next: Canvas): Rect | null {
  if (!previous) return { x: 0, y: 0, width: next.width, height: next.height };
  let left = next.width, right = -1, top = next.height, bottom = -1;
  for (let y = 0; y < next.height; y++) {
    for (let x = 0; x < next.width; x++) {
      const at = y * next.width + x;
      if (previous.glyph[at] === next.glyph[at] && previous.fg[at] === next.fg[at] && previous.bg[at] === next.bg[at]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
