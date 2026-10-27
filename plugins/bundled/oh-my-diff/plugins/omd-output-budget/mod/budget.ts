export type Terms = Record<string, number>;
export type Indexed = { id: string; terms: Terms; length: number };

const encoder = new TextEncoder();
const LINE_BYTES = 400;
const EVIDENCE_LINES = 40;
const STRONG = /\b(?:error|errors|failed|failure|failing|fatal|panic|panicked|exception|traceback|assertion|denied|cannot|unable|undefined|segmentation fault|timed out|aborted)\b|\w(?:error|exception)\b|\bFAIL(?:ED)?\b|ERR!|✗|✘|^\s*-->|^\s*at \S.*:\d+/i;
const WEAK = /\b(?:warning|warn|deprecated|skipped)\b/i;
const WORD = /[\p{L}\p{N}_]{2,40}/gu;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'you', 'but', 'have', 'has', 'all', 'any', 'can', 'its', 'into', 'out', 'use']);

export const size = (text: string) => encoder.encode(text).length;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(text: string): string {
  const bytes = encoder.encode(text);
  const out: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out.push(BASE64[(value >> 18) & 63], BASE64[(value >> 12) & 63],
      index + 1 < bytes.length ? BASE64[(value >> 6) & 63] : '=', index + 2 < bytes.length ? BASE64[value & 63] : '=');
  }
  return out.join('');
}

export function clip(text: string, bytes: number): string {
  if (size(text) <= bytes) return text;
  return text.slice(0, encoder.encodeInto(text, new Uint8Array(Math.max(0, bytes))).read);
}

export function split(output: string): { header: string; body: string } {
  const marker = output.indexOf('\nOutput:\n');
  if (marker >= 0 && marker < 600 && /^(?:Chunk ID|Wall time|Process |Exit code|Command)/.test(output)) {
    return { header: output.slice(0, marker + 9), body: output.slice(marker + 9) };
  }
  return { header: '', body: output };
}

const line = (text: string, focus: number = text.search(STRONG)) => {
  const bytes = size(text);
  if (bytes <= LINE_BYTES) return text;
  const head = clip(text, LINE_BYTES / 2);
  if (focus <= head.length) return `${clip(text, LINE_BYTES)}…[+${bytes - size(clip(text, LINE_BYTES))} bytes]`;
  const start = Math.max(head.length, focus - 80);
  const window = clip(text.slice(start), LINE_BYTES / 2);
  const after = bytes - size(text.slice(0, start)) - size(window);
  return `${head}…[${size(text.slice(head.length, start))} bytes]…${window}${after > 0 ? `…[+${after} bytes]` : ''}`;
};

export function fallback(output: string, keep: number, reason: string): string {
  if (size(output) <= keep) return output;
  const half = Math.floor(keep / 2);
  const head = clip(output, half);
  let low = 0;
  let high = output.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (size(output.slice(middle)) <= half) high = middle;
    else low = middle + 1;
  }
  if (/[\udc00-\udfff]/.test(output[low] ?? '')) low += 1;
  const tail = output.slice(low);
  return `${head}\n[omd_output_budget: ${size(output) - size(head) - size(tail)} bytes omitted; the full output could not be kept (${reason})]\n${tail}`;
}

export function lineCount(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1;
  return text.endsWith('\n') ? count - 1 : count;
}

export function limitFor(delivered: number, budget: { result_bytes: number; turn_bytes: number; floor_bytes: number }): number {
  const left = budget.turn_bytes - delivered;
  return left <= budget.floor_bytes ? budget.floor_bytes : Math.min(budget.result_bytes, left);
}

export function excerpt(output: string, limit: number, id: string, total: number, note = ''): string {
  const { header, body } = split(output);
  const lines = body.endsWith('\n') ? body.slice(0, -1).split('\n') : body.split('\n');
  const partial = total > size(output);
  const base = lineCount(header);
  const footer = `\n[omd_output_budget: showed part of ${total} bytes${partial ? '' : ` (${lines.length} lines)`}; full output ${id}.${note ? ` ${note}.` : ''} `
    + `Page it with mod_omd_output_budget_read {"id":"${id}","line":N}; find lines with mod_omd_output_budget_search {"query":"…","id":"${id}"}]`;
  const room = Math.max(512, limit - size(header) - size(footer) - 240);
  let used = 0;
  const take = (text: string, cap: number) => {
    const bytes = size(text) + 1;
    if (used + bytes > cap) return false;
    used += bytes;
    return true;
  };
  const head: string[] = [];
  for (const text of lines) {
    if (!take(line(text), room * 0.25)) break;
    head.push(line(text));
  }
  const tail: string[] = [];
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    if (!take(line(lines[index]), room * 0.7)) break;
    tail.unshift(line(lines[index]));
  }
  const first = head.length;
  const last = lines.length - tail.length;
  const evidence: string[] = [];
  for (const pattern of [STRONG, WEAK]) {
    for (let index = first; index < last && evidence.length < EVIDENCE_LINES; index += 1) {
      if (!pattern.test(lines[index]) || evidence.some(entry => entry.startsWith(`L${index + 1 + base}:`))) continue;
      const entry = `L${index + 1 + base}: ${line(lines[index])}`;
      if (!take(entry, room)) break;
      evidence.push(entry);
    }
  }
  evidence.sort((a, b) => Number(a.slice(1, a.indexOf(':'))) - Number(b.slice(1, b.indexOf(':'))));
  for (let index = last - 1; index >= first && evidence.length === 0; index -= 1) {
    if (!take(line(lines[index]), room)) break;
    tail.unshift(line(lines[index]));
  }
  const gapStart = head.length + 1 + base;
  const gapEnd = lines.length - tail.length + base;
  const gap = gapEnd >= gapStart
    ? [`[omd_output_budget: lines ${gapStart}-${gapEnd} omitted${evidence.length ? `; ${evidence.length} matching error/warning lines follow` : ''}]`, ...evidence, ...(evidence.length ? ['[omd_output_budget: end of matching lines]'] : [])]
    : [];
  return clip(`${header}${[...head, ...gap, ...tail].join('\n')}${footer}`, Math.max(limit, size(header) + size(footer) + 512));
}

export function terms(text: string, keep: number): { terms: Terms; length: number } {
  const counts = new Map<string, number>();
  let length = 0;
  for (const match of text.toLowerCase().matchAll(WORD)) {
    if (STOP.has(match[0]) || /^\d+$/.test(match[0])) continue;
    length += 1;
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, keep);
  return { terms: Object.fromEntries(top), length };
}

export function query(text: string): string[] {
  return [...new Set([...text.toLowerCase().matchAll(WORD)].map(match => match[0]).filter(word => !STOP.has(word)))].slice(0, 16);
}

export function rank(words: string[], documents: Indexed[]): { id: string; score: number }[] {
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length) || 1;
  const idf = (word: string) => {
    const df = documents.filter(doc => doc.terms[word]).length;
    return Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
  };
  const weights = new Map(words.map(word => [word, idf(word)]));
  return documents.map(doc => ({
    id: doc.id,
    score: words.reduce((sum, word) => {
      const tf = doc.terms[word] ?? 0;
      return sum + (weights.get(word) ?? 0) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / average));
    }, 0),
  })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

export function matches(text: string, words: string[], firstLine: number, limit: number): { line: number; text: string; score: number }[] {
  const phrase = words.join(' ');
  const hits: { line: number; text: string; score: number }[] = [];
  text.split('\n').forEach((raw, index) => {
    const lower = raw.toLowerCase();
    const found = words.filter(word => lower.includes(word)).length;
    if (!found) return;
    hits.push({ line: firstLine + index, text: line(raw.trim(), raw.trim().toLowerCase().indexOf(words.find(word => lower.includes(word)) ?? '')), score: found + (words.length > 1 && lower.includes(phrase) ? words.length : 0) });
  });
  return hits.sort((a, b) => b.score - a.score || a.line - b.line).slice(0, limit);
}

const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(_: string, entity: string): string {
  const named = NAMED[entity.toLowerCase()];
  if (named) return named;
  const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
}

export function htmlText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(ENTITY, decode).trim();
  const text = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/li>\s*<li\b[^>]*>/gi, '\n- ').replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(ENTITY, decode)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
