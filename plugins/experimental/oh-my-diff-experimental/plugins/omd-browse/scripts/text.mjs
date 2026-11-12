export function pattern(text) {
  try {
    return new RegExp(text, 'i');
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

export const clip = (text, max) => text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;

export const slug = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 32);

export function fit(lines, maxChars, hint = 'pipe through grep, head or tail, or read one section') {
  let size = 0;
  for (let index = 0; index < lines.length; index++) {
    size += lines[index].length + 1;
    if (size > maxChars) return `${lines.slice(0, index).join('\n')}\n… ${lines.length - index} more lines; ${hint}`;
  }
  return lines.join('\n');
}

export function diff(before, after) {
  const n = before.length;
  const m = after.length;
  if (n * m > 4_000_000) return null;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = before[i] === after[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let gap = false;
  const mark = () => {
    if (gap) out.push('  …');
    gap = false;
  };
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      gap = true;
      i++;
      j++;
    } else if (i < n && (j === m || table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1])) {
      mark();
      out.push(`- ${before[i++]}`);
    } else {
      mark();
      out.push(`+ ${after[j++]}`);
    }
  }
  return out;
}

export function parseLine(line) {
  const commands = [];
  let words = [];
  let pipeline = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) pipeline.push(words);
    words = [];
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && (line[index + 1] === '"' || line[index + 1] === '\\')) word += line[++index];
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (char === '\\' && index + 1 < line.length) {
      word = (word ?? '') + line[++index];
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === '|') {
      endCommand();
    } else if (char === ';' || char === '\n') {
      endCommand();
      if (pipeline.length) commands.push(pipeline);
      pipeline = [];
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quote) throw new Error('Unclosed quote');
  endCommand();
  if (pipeline.length) commands.push(pipeline);
  return commands;
}

export function flags(words) {
  const positional = [];
  const named = {};
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === '--') {
      positional.push(...words.slice(index + 1));
      break;
    }
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(word);
    if (!match) {
      positional.push(word);
      continue;
    }
    const [, key, inline] = match;
    if (inline !== undefined) named[key] = inline;
    else if (key.startsWith('no-')) named[key.slice(3)] = false;
    else if (index + 1 < words.length && !words[index + 1].startsWith('--')) named[key] = words[++index];
    else named[key] = true;
  }
  return { positional, named };
}

export function jsonPath(value, path) {
  const parts = path.replace(/^\./, '').match(/\[\]|\[\d+\]|[^.[\]]+/g) ?? [];
  const step = (current, rest) => {
    if (!rest.length || current === undefined || current === null) return current;
    const [part, ...tail] = rest;
    if (part === '[]') return Array.isArray(current) ? current.map(item => step(item, tail)) : undefined;
    const key = part.startsWith('[') ? Number(part.slice(1, -1)) : part;
    return step(current[key], tail);
  };
  return step(value, parts);
}
