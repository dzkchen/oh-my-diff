// Inline views reject control characters, so line endings, tabs and terminal escapes are normalized first.
export const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const utf8 = (char: string) => { const code = char.codePointAt(0) ?? 0; return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; };
export const clamp = (text: string, limit: number) => {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    bytes += utf8(char);
    if (bytes > limit) return { text: out, cut: true };
    out += char;
  }
  return { text: out, cut: false };
};
export const size = (text: string) => { let total = 0; for (const char of text) total += utf8(char); return total; };
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
// One terminal cell group: a flag, an emoji ZWJ sequence, or a character with its marks, variation selector and skin tone.
const GLYPH = /\p{RI}{2}|(?:\p{ExtPict}[\p{EMod}\uFE0F]*\u200D)*[^][\p{M}\p{Cf}\p{EMod}]*/gsu;
export const glyphs = (text: string) => text.match(GLYPH) ?? [];
export const charCells = (char: string) => /^[\p{M}\p{Cf}]/u.test(char) ? 0 : WIDE.test(char) || char.includes('\uFE0F') ? 2 : 1;
export const cells = (text: string) => { let total = 0; for (const char of glyphs(text)) total += charCells(char); return total; };
export const fit = (text: string, max: number) => { let out = '', used = 0; for (const char of glyphs(text)) { const width = charCells(char); if (out && used + width > max) break; out += char; used += width; } return out; };
export const wrap = (text: string, max: number) => text.split('\n').flatMap(raw => {
  const lines: string[] = [];
  let line = '';
  for (let word of raw.split(/\s+/).filter(Boolean)) {
    while (cells(word) > max) { if (line) lines.push(line); line = ''; const head = fit(word, max); lines.push(head); word = word.slice(head.length); }
    if (!word) continue;
    if (line && cells(line) + 1 + cells(word) > max) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  return line || !lines.length ? [...lines, line] : lines;
});
export const pick = (table: Record<string, string>, key = '') => Object.hasOwn(table, key) ? table[key] : undefined;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (raw: string) => fit(raw.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^\x60([\s\S]*)\x60$/, '$1').replace(/<br\s*\/?>/gi, '\n')
  .replace(/[&#]#?(\w{1,8});/g, (all, name: string) => /^\d+$/.test(name) ? Number(name) <= 0x10ffff ? String.fromCodePoint(Number(name)) : all : pick(ENTITIES, name) ?? all)
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ''), 240);
export const label = (raw: string) => wrap(decode(raw), 28);
