import type { Json } from '@oh-my-diff/mod-api';
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

const rows = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

export function excerpt(output: string, limit: number, id: string, total: number, { note = '', failed = true, end }: { note?: string; failed?: boolean; end?: string } = {}): string {
  const { header, body } = split(output);
  const lines = rows(body);
  const ending = end === undefined ? null : rows(end.slice(end.indexOf('\n') + 1));
  const base = lineCount(header);
  const footer = `\n[omd_output_budget: showed part of ${total} bytes${total > size(output) ? '' : ` (${lines.length} lines)`}; full output ${id}.${note ? ` ${note}.` : ''} `
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
  for (const raw of lines) {
    const text = line(raw);
    if (!take(text, room * 0.25)) break;
    head.push(text);
  }
  const source = ending ?? lines;
  const floor = ending ? 0 : head.length;
  const tail: string[] = [];
  const extend = (cap: number) => {
    for (let index = source.length - tail.length - 1; index >= floor; index -= 1) {
      const text = line(source[index]);
      if (!take(text, cap)) break;
      tail.unshift(text);
    }
  };
  extend(room * 0.7);
  const middle = ending ? lines.length : lines.length - tail.length;
  const evidence = new Map<number, string>();
  for (const pattern of failed ? [STRONG, WEAK] : []) {
    for (let index = head.length; index < middle && evidence.size < EVIDENCE_LINES; index += 1) {
      if (evidence.has(index) || !pattern.test(lines[index])) continue;
      const entry = `L${index + 1 + base}: ${line(lines[index])}`;
      if (!take(entry, room)) break;
      evidence.set(index, entry);
    }
  }
  if (!evidence.size) extend(room);
  const from = head.length + 1 + base;
  const to = lines.length - tail.length + base;
  const found = [...evidence].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  const omitted = ending ? `lines from ${from} up to the last ${tail.length} omitted` : `lines ${from}-${to} omitted`;
  const gap = ending || to >= from
    ? [`[omd_output_budget: ${omitted}${found.length ? `; ${found.length} matching error/warning lines follow` : ''}]`, ...found, ...(found.length ? ['[omd_output_budget: end of matching lines]'] : [])]
    : [];
  return `${header}${clip([...head, ...gap, ...tail].join('\n'), Math.max(limit - size(header) - size(footer), room + 240))}${footer}`;
}

export function terms(text: string, bytes: number): { terms: Terms; length: number } {
  const counts = new Map<string, number>();
  let length = 0;
  for (const match of text.toLowerCase().matchAll(WORD)) {
    if (STOP.has(match[0]) || /^\d+$/.test(match[0])) continue;
    length += 1;
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  let used = 2;
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).filter(([word, count]) => (used += size(word) + String(count).length + 4) <= bytes);
  return { terms: Object.fromEntries(top), length };
}

export function query(text: string): string[] {
  return [...new Set([...text.toLowerCase().matchAll(WORD)].map(match => match[0]).filter(word => !STOP.has(word)))].slice(0, 16);
}

export const count = (terms: Terms, word: string) => Object.hasOwn(terms, word) ? terms[word] : 0;

export function rank(words: string[], documents: Indexed[]): { id: string; score: number }[] {
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length) || 1;
  const idf = (word: string) => {
    const df = documents.filter(doc => count(doc.terms, word)).length;
    return Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
  };
  const weights = new Map(words.map(word => [word, idf(word)]));
  return documents.map(doc => ({
    id: doc.id,
    score: words.reduce((sum, word) => {
      const tf = count(doc.terms, word);
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
  const code: string[] = [];
  const text = html
    .replaceAll('\0', '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, block: string) => `\n\0${code.push(block.replace(/<[^>]+>/g, '').replace(ENTITY, decode).replace(/\r/g, '').replace(/^\n+|\s+$/g, '')) - 1}\0\n`)
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/li>\s*<li\b[^>]*>/gi, '\n- ').replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(ENTITY, decode)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\0(\d+)\0/g, (_, index: string) => `\`\`\`\n${code[Number(index)]}\n\`\`\``)
    .trim();
  return { title, text };
}

export function outline(text: string): string[] {
  let fenced = false;
  const headings: string[] = [];
  for (const row of text.split('\n')) {
    if (row.startsWith('```')) fenced = !fenced;
    else if (!fenced && /^#{1,3} /.test(row)) headings.push(clip(row, 120));
    if (headings.length === 20) break;
  }
  return headings;
}

const MODIFIERS = '(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|async|override|readonly|get|set)\\s+)';
const DEFINITIONS: Record<string, RegExp> = {
  py: /^\s*(?:async\s+def|def|class)\s+\w/,
  js: new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?(?:function\\*?\\s*\\w|(?:abstract\\s+)?class\\s+\\w|interface\\s+\\w|type\\s+\\w+.*=|enum\\s+\\w|(?:const|let|var)\\s+\\w+\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|\\w+\\s*=>))|^\\s+${MODIFIERS}*(?!(?:if|for|while|switch|catch|return|function|new|await|typeof)\\b)[\\w$]+\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$`),
  go: /^(?:func\s|type\s+\w+\s+(?:struct|interface)\b)/,
  rs: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern\s+"[^"]*")\s+)*(?:fn|struct|enum|trait|impl|mod|union|macro_rules!)[\s<!]/,
  java: new RegExp(`^\\s*${MODIFIERS}*(?:class|interface|enum|record|@interface)\\s+\\w|^\\s*${MODIFIERS}+[\\w<>\\[\\],.?\\s]+\\s+\\w+\\s*\\([^;]*$`),
  rb: /^\s*(?:def|class|module)\s+\S/,
};
const LANGUAGES: Record<string, string> = { py: 'py', pyi: 'py', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', go: 'go', rs: 'rs', java: 'java', rb: 'rb' };
const READER = /^\s*(?:cd\s+[^;&|]+&&\s*)?(cat|head|sed|nl)\s+([^|;&<>]*)$/;
const CODE_PATH = /^['"]?([^\s'"]+\.([A-Za-z]+))['"]?$/;

export function codeRead(tool: string, args: Record<string, Json> | null): { lang: string; path: string; first: number } | null {
  if (!args) return null;
  const known = (path: unknown, first: number) => {
    const lang = typeof path === 'string' ? LANGUAGES[/\.([A-Za-z]+)$/.exec(path)?.[1] ?? ''] : undefined;
    return lang ? { lang, path: path as string, first } : null;
  };
  const command = typeof args.cmd === 'string' ? args.cmd : Array.isArray(args.command) ? args.command.at(-1) : null;
  if (typeof command === 'string') {
    const match = READER.exec(command);
    if (!match) return null;
    const words = match[2].trim().split(/\s+/);
    const paths = words.filter(word => CODE_PATH.test(word) && LANGUAGES[CODE_PATH.exec(word)![2]]);
    if (paths.length !== 1) return null;
    const range = match[1] === 'sed' ? /^['"]?(\d+)(?:,\d+)?p['"]?$/.exec(words.find(word => /\dp['"]?$/.test(word)) ?? '') : null;
    if (match[1] === 'sed' && !range) return null;
    return known(CODE_PATH.exec(paths[0])![1], range ? Number(range[1]) : 1);
  }
  const path = args.path ?? args.file_path ?? args.filePath;
  const offset = args.offset ?? args.start_line ?? args.line;
  return /(?:^|_)(?:read|view|open)(?:_file)?$/i.test(tool) ? known(path, typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 1) : null;
}

export function codeExcerpt(output: string, limit: number, id: string, total: number, file: { lang: string; path: string; first: number }): string {
  const { header, body } = split(output);
  const lines = rows(body);
  const numbered = /^\s*\d+(?:\t|: | {2})/.test(lines[0] ?? '') && /^\s*\d+(?:\t|: | {2})/.test(lines[1] ?? lines[0]);
  const at = (index: number) => Number((numbered && /^\s*(\d+)/.exec(lines[index])?.[1]) || file.first + index);
  const pattern = DEFINITIONS[file.lang];
  const footer = `\n[omd_output_budget: ${total} bytes (${lines.length} lines) of ${file.path}; showed an outline of its definitions and lines ${at(0)}-{last}; full output ${id}. `
    + `Read ranges by line, e.g. sed -n 'START,ENDp' ${file.path}, or mod_omd_output_budget_read {"id":"${id}","line":N}]`;
  const room = Math.max(512, limit - size(header) - size(footer) - 120);
  let used = 0;
  const shown: string[] = [];
  for (const raw of lines) {
    const text = line(raw);
    if (used + size(text) + 1 > room * 0.5) break;
    shown.push(text);
    used += size(text) + 1;
  }
  const outline: string[] = [];
  let skipped = 0;
  lines.slice(shown.length).forEach((raw, offset) => {
    const text = numbered ? raw.replace(/^\s*\d+(?:\t|: | {2})/, '') : raw;
    if (!pattern.test(text)) return;
    const entry = `${at(shown.length + offset)}: ${clip(text.replace(/\s+$/, '').replace(/^(\s{0,12})\s*/, '$1'), 160)}`;
    if (used + size(entry) + 1 > room) skipped += 1;
    else { outline.push(entry); used += size(entry) + 1; }
  });
  const last = shown.length ? at(shown.length - 1) : at(0) - 1;
  return `${header}${shown.join('\n')}\n[omd_output_budget: outline of definitions after line ${last}${skipped ? ` (${skipped} more omitted)` : ''}]\n${outline.join('\n')}${footer.replace('{last}', String(last))}`;
}
