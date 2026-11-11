import { Canvas, mix, hash, rand, wrap, step } from './canvas.ts';
import type { Rgb } from './canvas.ts';

export const EFFECTS = {
  emblem: { colors: 8, art: 1 },
  clouds: { colors: 6, art: 0 },
  reef: { colors: 8, art: 2 },
  jellyfish: { colors: 6, art: 0 },
  fireflies: { colors: 5, art: 0 },
  moon: { colors: 9, art: 0 },
  curtains: { colors: 10, art: 0 },
  fish: { colors: 6, art: 0 },
  ribbons: { colors: 5, art: 0 },
  orbit: { colors: 2, art: 0 },
} as const;
export type Effect = keyof typeof EFFECTS;

function mark(c: Canvas, t: number, colors: number[], rows: string[]) {
  const scale = c.cols >= 44 && c.height >= 14 ? 2 : 1;
  if (c.cols < 18 || c.height < 6) return;
  const left = Math.floor((c.cols - rows[0].length * scale) / 2);
  const top = Math.max(0, Math.floor((c.height - rows.length * scale) / 2) - scale + 1);
  c.glow(c.cols / 2, top + rows.length / 2 * scale, 9 * scale, colors[0], 0.24);
  rows.forEach((row, dy) => [...row].forEach((pixel, dx) => {
    if (pixel !== '#') return;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const tx = left + dx * scale + sx;
        const y = top + dy * scale + sy;
        c.tile(tx, y, mix(colors[1], colors[2], (dy * scale + sy) / (rows.length * scale)), Math.sin(t * 1.3 + rand(tx, y, 5) * 6.28) > 0.85 ? 1 : 0.85);
      }
    }
  }));
}

function aurora(c: Canvas, t: number, colors: number[]) {
  const bands = [
    { color: colors[0], crest: colors[1], base: 0.24, length: 0.15, power: 0.85, phase: 0 },
    { color: colors[2], crest: colors[3], base: 0.36, length: 0.11, power: 0.6, phase: 2.4 },
    { color: colors[4], crest: colors[5], base: 0.14, length: 0.1, power: 0.5, phase: 4.1 },
  ];
  const stir = c.energy;
  const bright = 1 + 0.9 * stir;
  for (const [i, band] of bands.entries()) {
    const length = Math.max(1.2, c.height * band.length * (1 + 0.4 * stir));
    for (let x = 0; x < c.width; x++) {
      const u = x / 2;
      const reach = (0.5 + 0.5 * Math.sin(u * 0.045 + t * 0.06 + band.phase)) ** 2;
      if (reach < 0.02) continue;
      const top = c.height * (band.base + 0.12 * Math.sin(u * 0.055 + t * 0.18 + band.phase) + 0.05 * Math.sin(u * 0.17 - t * 0.31 + i) + 0.03 * stir * Math.sin(u * 0.5 + t * 3 + i));
      const ray = 0.25 + 0.75 * Math.sin(u * 0.8 + t * 0.9 + 3 * Math.sin(u * 0.04 + band.phase) + 1.5 * stir * Math.sin(t * 4 + u * 0.3)) ** 4;
      for (let y = Math.max(0, Math.floor(top - 2)); y < Math.min(c.height, Math.ceil(top + 3 * length)); y++) {
        const d = y - top;
        const strength = band.power * bright * reach * ray * (d < 0 ? Math.exp(-2 * d * d) : Math.exp(-d / length));
        if (strength < 0.015) continue;
        const color = mix(band.color, band.crest, 1 - d / 1.5);
        c.light(y * c.width + x, color, strength);
        if (strength > 0.3 && rand(x, y, 20 + i) < 0.35) c.dot(x, y, d < 1 ? "'" : rand(x, Math.floor(t * 3), 30) < 0.5 ? '¦' : ':', color, Math.min(1, strength * 2));
      }
    }
  }
}

function hills(c: Canvas, base: number, waves: [number, number, number][], color: Rgb, alpha: number) {
  for (let tx = 0; tx < c.cols; tx++) {
    const top = c.height * (base + waves.reduce((sum, [amp, freq, phase]) => sum + amp * Math.sin(tx * freq + phase), 0));
    for (let y = Math.max(0, Math.ceil(top)); y < c.height; y++) {
      c.shade(y, tx * 2, color, alpha);
      c.shade(y, tx * 2 + 1, color, alpha);
    }
  }
}

const painters: Record<Effect, (c: Canvas, t: number, colors: number[], art?: string[][]) => void> = {
  emblem(c, t, colors, art) {
    c.glow(c.cols / 2, c.height + 1, c.height * 0.9, colors[3], 0.38);
    c.grid(colors[4], 0.35);
    mark(c, t, colors, art![0]);
    c.particles(22, 7, t, 0.15, -1.4, '·•*', [colors[5], colors[6], colors[7]], 0.95, 0.8);
  },
  clouds(c, t, colors) {
    c.glow(c.cols * 0.72, c.height * 1.05, c.height * 0.75, colors[0], 0.45);
    c.grid(colors[1], 0.12);
    for (let i = 0; i < 4; i++) {
      const rx = 6 + 4 * rand(i, 2) + i;
      const ry = 1.4 + 0.4 * i;
      const x = wrap(rand(i, 1) * c.cols + (0.35 + 0.25 * i) * t, c.cols + 4 * rx) - 2 * rx;
      const y = c.height * (0.12 + 0.2 * i);
      const color = mix(colors[2], colors[3], 0.35 - 0.08 * i);
      c.blob(x, y, rx, ry, color, 0.45 + 0.12 * i);
      c.blob(x - rx * 0.45, y + 0.4, rx * 0.6, ry * 0.75, color, 0.45 + 0.12 * i);
      c.blob(x + rx * 0.5, y + 0.45, rx * 0.55, ry * 0.7, color, 0.45 + 0.12 * i);
    }
    c.particles(3, 4, t, 0.9, 0.05, 'vV', [colors[4]], 0.8, 0.3);
    c.particles(12, 9, t, 0.3, 0, '·', [colors[5]], 0.5);
  },
  reef(c, t, colors, art) {
    for (let i = 0; i < 3; i++) c.shaft(c.cols * (0.18 + 0.32 * i) + 2 * Math.sin(t * 0.25 + i * 2), -0.35, 2.2, colors[0], 0.2);
    for (let x = 0; x < c.width; x++) if (Math.sin(x * 0.5 - Math.floor(t * 4) * 0.25) > 0.3) c.dot(x, 0, '~', colors[1], 0.7);
    for (let y = c.height - 2; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        c.shade(y, x, colors[2], 0.55);
        if (rand(x, y, 3) > 0.8) c.dot(x, y, rand(x, y, 4) > 0.5 ? '.' : ',', colors[3], 0.8);
      }
    }
    const x = wrap(0.8 * t, c.cols + 24) - 12;
    c.sprite(art![Math.floor(t * 1.5) % 2], Math.round(x), Math.round(c.height * 0.4 + 1.2 * Math.sin(t * 0.6)), { s: colors[4], d: colors[5], k: colors[6] }, 0.9);
    c.particles(10, 5, t, 0, -1.1, 'o°.', [colors[7]], 0.8, 0.6);
  },
  jellyfish(c, t, colors) {
    c.shaft(c.cols * 0.6, 0.25, 3, colors[0], 0.12);
    c.particles(26, 3, t, 0.15, -0.25, '·.', [colors[1], colors[2]], 0.6);
    [colors[3], colors[4], colors[5]].forEach((color, i) => {
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
  fireflies(c, t, colors) {
    for (let i = 0; i < Math.round(30 * c.density); i++) c.dot(Math.floor(rand(i, 1, 8) * c.width), Math.floor(rand(i, 2, 8) * c.height * 0.4), '.', colors[0], 0.5);
    hills(c, 0.58, [[0.08, 0.31, 0], [0.05, 0.87, 1.3]], colors[1], 0.75);
    for (let x = 0; x < c.width; x++) if (rand(x, 9) > 0.55) c.dot(x, c.height - 1, '"\',|'[hash(x, 10) % 4], colors[2], 0.9);
    for (let i = 0; i < Math.round(12 * c.density); i++) {
      const phase = rand(i, 3, 2) * 6.28;
      const x = step(rand(i, 1, 2) * c.cols + 4 * Math.sin(t * 0.37 * (1 + rand(i, 4, 2)) + phase), 2);
      const y = Math.round(c.height * (0.35 + 0.55 * rand(i, 2, 2)) + 1.6 * Math.sin(t * 0.53 + phase * 1.7));
      const blink = step(Math.max(0, Math.sin(t * (0.9 + rand(i, 5, 2)) + phase)) ** 3, 4);
      if (blink < 0.02) continue;
      c.glow(x, y, 3.2, colors[3], 0.42 * blink);
      c.dot(Math.round(x * 2), Math.round(y), '•', colors[4], 0.4 + 0.6 * blink);
    }
  },
  moon(c, t, colors) {
    for (let i = 0; i < Math.round(70 * c.density); i++) {
      const twinkle = Math.sin(t * (0.8 + 1.5 * rand(i, 3, 9)) + rand(i, 4, 9) * 6.28);
      c.dot(Math.floor(rand(i, 1, 9) * c.width), Math.floor(rand(i, 2, 9) * c.height * 0.7), twinkle > 0.7 ? '+' : twinkle > 0 ? '·' : '.', colors[0], 0.5 + 0.4 * twinkle);
    }
    const mx = c.cols * 0.74;
    const my = c.height * 0.28;
    const radius = Math.max(2.2, c.height * 0.11);
    c.glow(mx, my, radius * 4.5, colors[1], 0.33);
    c.ellipse(mx, my, radius, radius, (tx, y) => c.tile(tx, y, rand(tx, y, 11) > 0.85 ? colors[2] : colors[3], 0.95));
    c.blob(wrap(0.25 * t, c.cols + 30) - 15, my + 0.6, 9, 0.9, colors[4], 0.5);
    const meteor = t % 23;
    if (meteor < 1.4) {
      for (let k = 0; k < 7; k++) {
        const p = meteor - k * 0.05;
        c.dot(Math.round((c.cols * 0.15 + p * c.cols * 0.35) * 2), Math.round(c.height * 0.1 + p * c.height * 0.18), k ? '-' : '*', colors[5], 1 - k * 0.13);
      }
    }
    hills(c, 0.7, [[0.08, 0.11, 0.5], [0.04, 0.37, 0]], colors[6], 0.85);
    hills(c, 0.82, [[0.06, 0.2, 2], [0.03, 0.53, 0]], colors[7], 0.9);
    for (let i = 0; i < Math.round(5 * c.density); i++) {
      const x = Math.floor(rand(i, 1, 12) * c.width);
      if (Math.sin(t * 0.3 + i * 4) > -0.6) c.dot(x, c.height - 1 - (hash(i, 13) % 2), '.', colors[8], 0.9);
    }
  },
  curtains(c, t, colors) {
    for (let i = 0; i < Math.round(55 * c.density); i++) {
      const twinkle = Math.sin(t * (0.6 + rand(i, 3, 21)) + rand(i, 4, 21) * 6.28);
      c.dot(Math.floor(rand(i, 1, 21) * c.width), Math.floor(rand(i, 2, 21) * c.height * 0.75), twinkle > 0.75 ? '+' : '·', colors[6], 0.35 + 0.35 * twinkle);
    }
    aurora(c, t, colors);
    const peaks: [number, number, number][] = [[0.09, 0.11, 0.8], [0.05, 0.29, 2], [0.025, 0.83, 0.4]];
    hills(c, 0.72, peaks, colors[7], 0.9);
    for (let tx = 0; tx < c.cols; tx++) {
      const ridge = Math.ceil(c.height * (0.72 + peaks.reduce((sum, [amp, freq, phase]) => sum + amp * Math.sin(tx * freq + phase), 0)));
      if (ridge >= 0 && ridge < c.height && rand(tx, 22) > 0.35) c.dot(tx * 2 + (hash(tx, 23) % 2), ridge, rand(tx, 24) > 0.5 ? '^' : '.', colors[8], 0.55);
    }
    hills(c, 0.86, [[0.05, 0.27, 1.4], [0.025, 0.9, 0]], colors[9], 0.92);
  },
  fish(c, t, colors) {
    const size = Math.min(c.cols * 0.43, c.height * 0.46);
    const cx = c.cols * 0.49 + Math.sin(t * 0.22) * size * 0.04;
    const cy = c.height * 0.52 + Math.sin(t * 0.31) * size * 0.03;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.cols; x++) {
      const u = (x - cx) / size;
      const v = (y - cy) / size;
      const w = v - Math.sin(t * 1.1 - u * 4) * 0.06 * Math.max(0, u + 0.4);
      const body = ((u + 0.38) / 0.59) ** 2 + ((w + 0.02) / 0.26) ** 2;
      const dorsal = u > -0.69 && u < -0.15 && w < -0.15 && w > -0.95 + (u + 0.55) * 1.6 && w > -1.05 - (u + 0.55) * 4;
      const tail = u > 0.03 && u < 0.95 && Math.abs(w + 0.05) < 0.78 * Math.sin((u - 0.03) * 2.1) && Math.abs(w) > Math.max(0, (u - 0.55) * 1.1);
      const curl = Math.hypot((u - 0.06) / 0.58, (w - 0.27) / 0.59);
      const veil = w > 0.2 && u > -0.52 && u < 0.65 && curl < 1 && curl > 0.76;
      if (body > 1 && !dorsal && !tail && !veil) continue;
      const rays = 0.5 + 0.5 * Math.sin(Math.atan2(w, u + 0.15) * 29 + u * 11 - t * 0.65);
      const patch = w < -0.01 + 0.07 * Math.sin(u * 10) && u < -0.05;
      let color = body <= 1 ? (patch ? colors[0] : colors[1]) : mix(colors[2], colors[3], rays);
      if (tail && Math.sin(u * 8 + w * 5) > 0.75) color = mix(color, colors[4], 0.35);
      if ((u + 0.77) ** 2 + (w + 0.08) ** 2 < 0.0035) color = colors[5];
      c.tile(x, y, color, body <= 1 ? 1 : 0.68 + rays * 0.25);
    }
  },
  ribbons(c, t, colors) {
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.cols; x++) {
      const u = x / c.cols, v = y / c.height;
      const along = (u + 1 - v) / 2;
      let strength = 0, color = 0;
      for (let k = 0; k < 7; k++) {
        const end = 0.63 + 0.055 * k;
        const taper = Math.max(0, 1 - along / end);
        const bend = Math.sin(along * 12 + k * 0.83 - t * 0.24) * 0.035 * Math.sin(along * Math.PI);
        const center = 0.98 + (k - 3) * 0.074 + bend;
        const width = 0.008 + taper * 0.075;
        const distance = (u + v - center) / width;
        const value = Math.exp(-distance * distance * 2) * Math.min(1, taper * 9);
        if (value <= strength) continue;
        strength = value;
        const phase = wrap(distance * 0.8 + k * 0.65 + along * 3 - t * 0.14, colors.length);
        color = mix(colors[Math.floor(phase)], colors[(Math.floor(phase) + 1) % colors.length], phase % 1);
      }
      const grain = rand(x, y - Math.floor(t * 2), 73);
      if (strength < 0.08 || grain > Math.min(1, strength * 2.4 * c.density)) continue;
      c.tile(x, y, color, strength * (0.65 + grain * 0.35));
    }
  },
  orbit(c, t, colors) {
    const radius = Math.min(c.cols * 0.24, c.height * 0.34);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.cols; x++) {
      const u = (x - c.cols * 0.5) / radius;
      const v = (y - c.height * 0.5) / radius;
      const r = Math.hypot(u, v);
      const angle = Math.atan2(v, u);
      const disk = Math.hypot(u / 2.1, (v + 0.02) / 0.13);
      const ring = r > 0.78 && r < (v < 0 ? 1.28 : 1.16);
      const band = disk < 1 && (v > -0.035 || Math.abs(u) > 0.9);
      if (!ring && !band) continue;
      const orbit = 0.5 + 0.5 * Math.sin(angle * 7 - t * 1.4 + r * 9);
      const lanes = 0.5 + 0.5 * Math.cos((band ? disk : r) * 72);
      const grain = rand(Math.floor(angle * 40 - t * 4), Math.floor(r * 60), 86);
      const intensity = band ? 0.7 + orbit * 0.3 : 0.35 + lanes * 0.4 + orbit * 0.25;
      const color = mix(colors[0], colors[1], intensity * (0.6 + grain * 0.4));
      c.tile(x, y, color, intensity);
    }
  },
};

export const paintEffect = (effect: Effect, c: Canvas, t: number, colors: number[], art?: string[][]) => painters[effect](c, t, colors, art);
