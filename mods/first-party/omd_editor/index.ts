import type { Json, KeyAction, KeyName, ModAPI, TerminalComponent, TerminalInputEvent, TerminalRenderSite, TerminalSelectOption, TerminalSpan, TerminalTone } from '../../api.d.ts';

type Point = [number, number];
type Edit = { id: number; at: number; before: string[]; after: string[]; from: Point; to: Point };
type Buffer = {
  path: string; lines: string[]; eol: '\n' | '\r\n'; final: boolean; sha: string | null; row: number; col: number; mark: Point | null;
  undo: Edit[]; redo: Edit[]; clean: number; next: number; base?: string | null; conflict: string | null;
  parked?: { chunks: number; bytes: number } | null; stash?: number[];
};
type Root = { buffers: Buffer[]; active: number; head: string | null; find: string; finding: boolean; closing: boolean;
  review: { sha: string | null; diff: string } | null; pane: boolean; open: boolean; notice: string | null; watch: string | null; want: { sync?: boolean; save?: string } };

const BUDGET = 100_000;
const READS = 110_000;
const BUFFERS = 8;
const UNDO = 200;
const CHUNK = 100;
const VIEW_LINES = 200;
const VIEW_CHARS = 40_000;
const LINE_CHARS = 400;
const LIMIT_D = 400;
const STASH = 60_000;
const COMMENT: Record<string, string[]> = {
  '#': ['py', 'pyi', 'sh', 'bash', 'zsh', 'rb', 'toml', 'yaml', 'yml', 'pl', 'r'],
  '//': ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'go', 'swift', 'kt', 'scala', 'cs', 'php', 'dart'],
  '--': ['sql', 'lua', 'hs'],
};
const BLOCKS: Record<string, string[]> = { '//': ['/*', '`'], '#': ['"""', "'''"], '--': [] };
const KEYWORDS = new Set(['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default', 'elif', 'else', 'enum', 'export', 'extends', 'false', 'fn', 'for', 'from',
  'func', 'function', 'if', 'impl', 'import', 'in', 'interface', 'let', 'loop', 'match', 'mod', 'mut', 'new', 'nil', 'None', 'null', 'of', 'pass', 'pub', 'raise', 'return', 'self', 'static', 'struct',
  'switch', 'this', 'throw', 'trait', 'True', 'False', 'true', 'try', 'type', 'use', 'var', 'where', 'while', 'with', 'yield']);
const SYNTAX: TerminalSpan[] = [{ text: '' }, { text: '', tone: 'muted', italic: true }, { text: '', tone: 'success' }, { text: '', tone: 'attention' }, { text: '', tone: 'accent', bold: true }];
const OVERLAY: TerminalSpan[] = [{ text: '' }, { text: '', underline: true, bold: true }, { text: '', bg: 239, underline: true }, { text: '', fg: 0, bg: 7, bold: true, underline: true }];
const MARK_TONE: Record<string, TerminalTone> = { '+': 'success', '~': 'attention', '-': 'failure' };

const size = (text: string) => {
  let total = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xdc00 ? (index++, 4) : 3;
  }
  return total;
};
const fit = (text: string, bytes: number) => {
  if (size(text) <= bytes) return text;
  let out = '';
  for (const char of text) {
    if (size(out + char) > bytes - 3) break;
    out += char;
  }
  return `${out}…`;
};
const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return (value >>> 0).toString(36).padStart(7, '0');
};
const high = (code: number) => code >= 0xd800 && code < 0xdc00;
const low = (code: number) => code >= 0xdc00 && code < 0xe000;
const clean = (path: string) => /^\/|(^|\/)\.\.?(\/|$)|(^|\/)\.git(\/|$)/.test(path.trim()) ? null : path.trim().split('/').filter(Boolean).join('/') || null;
const split = (text: string): Pick<Buffer, 'lines' | 'eol' | 'final'> | string => {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (/\r(?!\n)/.test(text) || crlf && crlf !== lf) return 'mixed line endings';
  const eol = crlf ? '\r\n' : '\n';
  const final = text.endsWith(eol);
  return { lines: (final ? text.slice(0, -eol.length) : text).split(eol), eol, final };
};
const join = (buffer: Buffer) => buffer.lines.join(buffer.eol) + (buffer.final ? buffer.eol : '');
const dirty = (buffer: Buffer) => (buffer.undo.at(-1)?.id ?? 0) !== buffer.clean;
const cost = (buffer: Buffer) => !buffer.parked && dirty(buffer) ? size(buffer.lines.join('\n')) : 0;
const drop = (buffer: Buffer) => {
  const edit = buffer.undo.shift();
  if (edit) buffer.clean = buffer.clean === 0 ? -1 : buffer.clean === edit.id ? 0 : buffer.clean;
};
// Line-count changes from the saved file to the buffer, [row, saved lines, buffer lines] per edit since the save; null when the save point was dropped.
const trail = (buffer: Buffer): [number, number, number][] | null => {
  if (!dirty(buffer)) return [];
  const undone = buffer.undo.findIndex(edit => edit.id === buffer.clean);
  const redone = buffer.redo.findIndex(edit => edit.id === buffer.clean);
  return buffer.clean === 0 || undone >= 0 ? buffer.undo.slice(undone + 1).map(edit => [edit.at, edit.before.length, edit.after.length])
    : redone >= 0 ? buffer.redo.slice(redone).map(edit => [edit.at, edit.after.length, edit.before.length]) : null;
};
const across = (steps: [number, number, number][], row: number, toBuffer: boolean): number | null => {
  for (const [at, from, to] of toBuffer ? steps : steps.slice().reverse().map(([at, from, to]) => [at, to, from])) {
    if (row >= at + from) row += to - from;
    else if (row >= at) return null;
  }
  return row;
};
const stashKey = (path: string, index: number) => /^[!-[\]-~]{1,240}$/.test(path) ? `${index}:${path}` : `${index}#${hash(path)}${hash(`${path}\u0000`)}`;
const pieces = (text: string) => {
  const out: string[] = [];
  for (let start = 0; start < text.length || !out.length;) {
    let end = start;
    for (let bytes = 0; end < text.length && bytes < STASH; end++) {
      const code = text.charCodeAt(end);
      bytes += code < 0x20 || code === 0x22 || code === 0x5c ? 6 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (end < text.length && high(text.charCodeAt(end - 1))) end--;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
};
const opener = (token: string, blocks: string[]) => token.startsWith('/*') && blocks.includes('/*') ? token.length > 3 && token.endsWith('*/') ? null : '*/'
  : blocks.includes(token.slice(0, 3)) ? token.length > 5 && token.endsWith(token.slice(0, 3)) ? null : token.slice(0, 3)
    : token.startsWith('`') && blocks.includes('`') && !/^`(?:[^`\\]|\\.)*`$/.test(token) ? '`' : null;

// Myers shortest edit script after trimming the common prefix and suffix: 'e' keeps, 'd' deletes from a, 'i' inserts from b.
const script = (a: string[], b: string[]) => {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const offset = x.length + y.length + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let middle = 'd'.repeat(x.length) + 'i'.repeat(y.length);
  search: for (let d = 0; d <= Math.min(x.length + y.length, LIMIT_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let j = i - k;
      while (i < x.length && j < y.length && x[i] === y[j]) i++, j++;
      v[offset + k] = i;
      if (i < x.length || j < y.length) continue;
      const out: string[] = [];
      for (let step = d; step > 0; step--) {
        const previous = trace[step];
        const diagonal = i - j;
        const from = diagonal === -step || diagonal !== step && previous[offset + diagonal - 1] < previous[offset + diagonal + 1] ? diagonal + 1 : diagonal - 1;
        const pi = previous[offset + from];
        const pj = pi - from;
        while (i > pi && j > pj) out.push('e'), i--, j--;
        out.push(i === pi ? 'i' : 'd');
        i = pi;
        j = pj;
      }
      while (i > 0 && j > 0) out.push('e'), i--, j--;
      middle = out.reverse().join('');
      break search;
    }
  }
  return 'e'.repeat(head) + middle + 'e'.repeat(tail);
};
const marks = (buffer: Buffer) => {
  if (buffer.base == null) return '';
  const now = buffer.lines.map(line => hash(line).slice(-4));
  const out = now.map(() => ' ');
  let row = 0;
  let removed = 0;
  let added: number[] = [];
  const flush = () => {
    added.forEach((line, index) => out[line] = index < removed ? '~' : '+');
    if (!added.length && removed) out[Math.min(row, out.length - 1)] = '-';
    removed = 0;
    added = [];
  };
  for (const op of script(buffer.base.match(/.{4}/g) ?? [], now)) {
    if (op === 'e') flush(), row++;
    else if (op === 'd') removed++;
    else added.push(row++);
  }
  flush();
  return out.join('');
};
const unified = (path: string, a: string[], b: string[]) => {
  const ops = script(a, b);
  const rows: { op: string; text: string; i: number; j: number }[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) rows.push({ op, text: op === 'i' ? b[j] : a[i], i, j }), op !== 'i' && i++, op !== 'd' && j++;
  const out = [`--- disk/${path}`, `+++ buffer/${path}`];
  for (let index = 0; index < rows.length;) {
    if (rows[index].op === 'e') {
      index++;
      continue;
    }
    const start = Math.max(0, index - 3);
    let end = index;
    while (end < rows.length && (rows[end].op !== 'e' || rows.slice(end, end + 7).some(row => row.op !== 'e'))) end++;
    end = Math.min(rows.length, end + 3);
    const hunk = rows.slice(start, end);
    out.push(`@@ -${hunk[0].i + 1},${hunk.filter(row => row.op !== 'i').length} +${hunk[0].j + 1},${hunk.filter(row => row.op !== 'd').length} @@`,
      ...hunk.map(row => `${row.op === 'e' ? ' ' : row.op === 'd' ? '-' : '+'}${row.text}`));
    index = end;
  }
  const text = out.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '·');
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… diff truncated` : text;
};

export default function activate(api: ModAPI) {
  const fresh = (): Root => ({ buffers: [], active: 0, head: null, find: '', finding: false, closing: false, review: null, pane: false, open: false, notice: null, watch: null, want: {} });
  const load = (): Root => ({ ...fresh(), ...(api.state.get() as Partial<Root> | null) });
  const save = (root: Root) => {
    while (size(JSON.stringify(root)) > BUDGET) {
      const largest = root.buffers.filter(buffer => buffer.undo.length > 1).sort((a, b) => b.undo.length - a.undo.length)[0];
      if (!largest) break;
      drop(largest);
    }
    if (size(JSON.stringify(root)) > BUDGET) return false;
    api.state.set(root as unknown as Json);
    return true;
  };
  // A hop can arrive before the terminal-side callback that sent it saves, or lose a state race to typing; requests live in the state and a timer retries them.
  const hop = (root: Root, want: Root['want']) => {
    Object.assign(root.want, want);
    api.host.tryCall('events.publish', { channel: 'hop', data: null });
  };
  const git = (argv: string[]) => api.host.tryCall('exec.run', { program: 'git', argv: ['--no-pager', '-c', 'core.quotepath=false', ...argv], timeout_ms: 10_000 });
  const head = () => {
    const run = git(['rev-parse', '-q', '--verify', 'HEAD']);
    return run.ok && run.value.exit_code === 0 ? run.value.stdout.trim() : null;
  };
  const bases = (root: Root, used = 0) => {
    for (const buffer of root.buffers) {
      if (buffer.base !== undefined || buffer.parked) continue;
      const estimate = size(buffer.lines.join('\n'));
      if (used && used + estimate > READS) return false;
      const run = git(['show', `HEAD:./${buffer.path}`]);
      used += run.ok ? run.value.stdout_bytes + run.value.stderr.length : 0;
      const parsed = run.ok && run.value.exit_code === 0 && !run.value.stdout_preview_truncated ? split(run.value.stdout) : null;
      buffer.base = !run.ok || run.value.stdout_preview_truncated ? null
        : run.value.exit_code !== 0 ? /exists on disk, but not in|does not exist in/.test(run.value.stderr) ? '' : null
          : typeof parsed === 'string' || !parsed ? null : parsed.lines.map(line => hash(line).slice(-4)).join('');
    }
    return true;
  };
  const rebase = (root: Root, force: boolean) => {
    const current = head();
    if (force || current !== root.head) for (const buffer of root.buffers) delete buffer.base;
    root.head = current;
    if (!bases(root)) hop(root, { sync: true });
  };
  const check = (path: string) => {
    const stat = api.host.tryCall('workspace.stat', { paths: [path] });
    if (!stat.ok) return stat.error;
    const file = stat.value.files[path];
    if (file?.kind !== 'file') return `No file ${path} in the workspace`;
    return file.size > BUDGET ? `${path} is ${Math.ceil(file.size / 1024)} KB; the editor opens files up to ${BUDGET / 1000} KB, so open it in your editor` : file.size;
  };
  const read = (path: string): { text: string; sha: string } | string => {
    const checked = check(path);
    if (typeof checked === 'string') return checked;
    const result = api.host.tryCall('workspace.read', { paths: [path] });
    if (!result.ok) return /not_utf8/.test(result.error) ? `${path} is a binary file` : result.error;
    const entry = result.value.files[path];
    if (!entry) return `No file ${path} in the workspace`;
    if (entry.text.includes('\u0000')) return `${path} is a binary file`;
    return { text: entry.text, sha: entry.sha256 };
  };
  const load_into = (buffer: Buffer, text: string, sha: string | null) => {
    const parsed = split(text);
    if (typeof parsed === 'string') return parsed;
    Object.assign(buffer, parsed, { sha, mark: null, undo: [], redo: [], clean: 0, conflict: null, parked: null });
    buffer.row = Math.min(buffer.row, buffer.lines.length - 1);
    buffer.col = Math.min(buffer.col, buffer.lines[buffer.row].length);
    return null;
  };
  const reconcile = (root: Root, only?: string[]) => {
    const buffers = root.buffers.filter(buffer => !only || only.includes(buffer.path));
    if (!buffers.length) return;
    const stat = api.host.tryCall('workspace.stat', { paths: buffers.map(buffer => buffer.path), hash: true });
    if (!stat.ok) return;
    for (const buffer of buffers) {
      const current = stat.value.files[buffer.path]?.sha256 ?? null;
      if (current === buffer.sha) continue;
      if (!dirty(buffer) && current) {
        if (buffer.parked) continue;
        const loaded = read(buffer.path);
        const failed = typeof loaded === 'string' ? loaded : load_into(buffer, loaded.text, loaded.sha);
        if (!failed) {
          root.notice = `Reloaded ${buffer.path}: it changed on disk`;
          continue;
        }
      }
      buffer.conflict = current ? `${buffer.path} changed on disk after you opened it` : `${buffer.path} was deleted on disk`;
    }
  };

  const active = (root: Root) => root.buffers[root.active] as Buffer | undefined;
  const park = (buffer: Buffer) => {
    if (buffer.parked) return 0;
    const spent = cost(buffer);
    const chunks = spent ? pieces(buffer.lines.join('\n')) : [];
    for (const [index, value] of chunks.entries()) {
      const key = stashKey(buffer.path, index);
      let put = api.host.tryCall('store.put', { key, value, expected_revision: buffer.stash?.[index] ?? null, scope: 'thread' });
      const current = put.ok ? null : /store_revision_conflict: current (\d+|absent)/.exec(put.error);
      if (current) put = api.host.tryCall('store.put', { key, value, expected_revision: current[1] === 'absent' ? null : Number(current[1]), scope: 'thread' });
      if (!put.ok) return spent;
      (buffer.stash ??= [])[index] = put.value.revision;
    }
    Object.assign(buffer, { parked: { chunks: chunks.length, bytes: size(buffer.lines.join('\n')) }, lines: [] });
    return spent;
  };
  const unpark = (root: Root, buffer: Buffer): string | null => {
    const parked = buffer.parked!;
    if (parked.chunks) {
      let text = '';
      for (let index = 0; index < parked.chunks; index++) {
        const got = api.host.tryCall('store.get', { key: stashKey(buffer.path, index), scope: 'thread' });
        const chunk = got.ok ? got.value?.value : null;
        if (typeof chunk !== 'string') return `${buffer.path}: its unsaved changes could not be restored; /edit close discard drops the buffer`;
        text += chunk;
      }
      Object.assign(buffer, { lines: text.split('\n'), parked: null });
      return null;
    }
    const loaded = read(buffer.path);
    if (typeof loaded === 'string') return loaded;
    if (loaded.sha === buffer.sha) {
      Object.assign(buffer, split(loaded.text), { parked: null });
      return null;
    }
    const fresh = buffer.sha === null;
    const failed = load_into(buffer, loaded.text, loaded.sha);
    if (failed) return `${buffer.path}: ${failed}; open it in your editor`;
    if (!fresh) root.notice = `Reloaded ${buffer.path}: it changed on disk`;
    return null;
  };
  const settle = (root: Root, spent = 0) => {
    for (let buffer = active(root); buffer?.parked; buffer = active(root)) {
      if (spent && spent + buffer.parked.bytes > READS) {
        hop(root, { sync: true });
        break;
      }
      spent += buffer.parked.bytes;
      const failed = unpark(root, buffer);
      if (!failed) break;
      root.notice = failed;
      if (buffer.sha !== null) break;
      root.buffers.splice(root.active, 1);
      root.active = Math.max(0, Math.min(root.active, root.buffers.length - 1));
      root.open &&= root.buffers.length > 0;
    }
    return spent;
  };
  const open = (root: Root, target: string): string | null => {
    const match = /^(.*?)(?::(\d+))?$/.exec(target.trim());
    const file = clean(match?.[1] ?? '');
    if (!file) return 'usage: /edit PATH[:LINE]';
    const line = match?.[2] ? Number(match[2]) - 1 : null;
    let index = root.buffers.findIndex(buffer => buffer.path === file);
    const previous = active(root);
    let spent = 0;
    if (index < 0) {
      if (root.buffers.length >= BUFFERS) return `${BUFFERS} buffers are open; close one first`;
      const bytes = check(file);
      if (typeof bytes === 'string') return bytes;
      const buffer = { path: file, lines: [], eol: '\n', final: true, sha: null, row: line ?? 0, col: 0, mark: null, undo: [], redo: [], clean: 0, next: 1, conflict: null, parked: { chunks: 0, bytes } } as Buffer;
      const waiting = previous ? cost(previous) : 0;
      if (!waiting || waiting + bytes <= READS) {
        const failed = unpark(root, buffer);
        if (failed) return failed;
        spent = bytes;
      }
      index = root.buffers.push(buffer) - 1;
    } else if (line !== null) {
      const buffer = root.buffers[index];
      const steps = trail(buffer);
      let row = steps ? 0 : line;
      for (let from = line; steps && from >= 0; from--) {
        const mapped = across(steps, from, true);
        if (mapped === null) continue;
        row = mapped + (from < line ? 1 : 0);
        break;
      }
      buffer.row = buffer.parked ? row : Math.max(0, Math.min(row, buffer.lines.length - 1));
      buffer.col = 0;
    }
    spent += previous && previous !== root.buffers[index] ? park(previous) : 0;
    Object.assign(root, { active: index, open: true, closing: false, review: null, notice: null });
    settle(root, spent);
    hop(root, { sync: true });
    return null;
  };
  const write = (root: Root, buffer: Buffer, expected: string | null) => {
    if (buffer.parked) {
      root.notice = `${buffer.path} is not loaded; nothing was saved`;
      return false;
    }
    const written = api.host.tryCall('workspace.transaction', { expected: { [buffer.path]: expected }, writes: { [buffer.path]: join(buffer) } });
    if (!written.ok) {
      if (/stale/.test(written.error)) buffer.conflict = `${buffer.path} changed on disk; your save was refused`;
      root.notice = /stale/.test(written.error) ? 'Not saved: reload, keep your buffer or review the difference' : `Not saved: ${written.error}`;
      return false;
    }
    Object.assign(buffer, { sha: written.value.files[buffer.path] ?? null, clean: buffer.undo.at(-1)?.id ?? 0, conflict: null });
    root.review = null;
    root.notice = `Saved ${buffer.path}`;
    return true;
  };
  const selection = (buffer: Buffer): [Point, Point] | null => {
    if (!buffer.mark || buffer.mark[0] === buffer.row && buffer.mark[1] === buffer.col) return null;
    const cursor: Point = [buffer.row, buffer.col];
    return buffer.mark[0] < buffer.row || buffer.mark[0] === buffer.row && buffer.mark[1] < buffer.col ? [buffer.mark, cursor] : [cursor, buffer.mark];
  };
  const quote = (buffer: Buffer) => {
    const range = selection(buffer);
    const [start, end] = range ? [range[0][0], range[1][0] - (range[1][1] === 0 && range[1][0] > range[0][0] ? 1 : 0)] : [buffer.row, buffer.row];
    const text = buffer.lines.slice(start, end + 1).join('\n').slice(0, 8_000);
    api.host.tryCall('composer.write', { insert: `${buffer.path}:${start + 1}${end > start ? `-${end + 1}` : ''}\n\`\`\`\n${text}\n\`\`\`\n` });
  };
  const next = (root: Root, buffer: Buffer) => {
    if (!root.find) return;
    const sensitive = root.find !== root.find.toLowerCase();
    const query = sensitive ? root.find : root.find.toLowerCase();
    for (let step = 0; step <= buffer.lines.length; step++) {
      const row = (buffer.row + step) % buffer.lines.length;
      const line = sensitive ? buffer.lines[row] : buffer.lines[row].toLowerCase();
      const found = line.indexOf(query, step === 0 ? buffer.col + 1 : 0);
      if (found >= 0) {
        Object.assign(buffer, { row, col: found, mark: null });
        return;
      }
    }
    root.notice = `No match for ${root.find}`;
  };

  const change = (buffer: Buffer, mutate: () => void) => {
    const before = buffer.lines.slice();
    const from: Point = [buffer.row, buffer.col];
    mutate();
    let at = 0;
    while (at < before.length && at < buffer.lines.length && before[at] === buffer.lines[at]) at++;
    let tail = 0;
    while (tail < before.length - at && tail < buffer.lines.length - at && before[before.length - 1 - tail] === buffer.lines[buffer.lines.length - 1 - tail]) tail++;
    if (at === before.length && at === buffer.lines.length) return;
    if (buffer.redo.some(edit => edit.id === buffer.clean)) buffer.clean = -1;
    buffer.redo = [];
    const edit: Edit = { id: 0, at, before: before.slice(at, before.length - tail), after: buffer.lines.slice(at, buffer.lines.length - tail), from, to: [buffer.row, buffer.col] };
    const last = buffer.undo.at(-1);
    if (last && last.id !== buffer.clean && last.at === at && last.after.length === 1 && edit.before.length === 1 && edit.after.length === 1 && last.after[0] === edit.before[0]) {
      Object.assign(last, { after: edit.after, to: edit.to });
      return;
    }
    edit.id = buffer.next++;
    buffer.undo.push(edit);
    if (buffer.undo.length > UNDO) drop(buffer);
  };
  const remove = (buffer: Buffer) => {
    const range = selection(buffer);
    buffer.mark = null;
    if (!range) return false;
    const [[r1, c1], [r2, c2]] = range;
    buffer.lines.splice(r1, r2 - r1 + 1, buffer.lines[r1].slice(0, c1) + buffer.lines[r2].slice(c2));
    [buffer.row, buffer.col] = [r1, c1];
    return true;
  };
  const insert = (buffer: Buffer, text: string) => {
    remove(buffer);
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    const line = buffer.lines[buffer.row];
    const last = parts.length - 1;
    buffer.lines.splice(buffer.row, 1, ...parts.map((part, index) => (index === 0 ? line.slice(0, buffer.col) : '') + part + (index === last ? line.slice(buffer.col) : '')));
    buffer.col = (last ? 0 : buffer.col) + parts[last].length;
    buffer.row += last;
  };
  const step = (line: string, col: number, forward: boolean) => forward
    ? col + (high(line.charCodeAt(col)) && low(line.charCodeAt(col + 1)) ? 2 : 1)
    : col - (low(line.charCodeAt(col - 1)) && high(line.charCodeAt(col - 2)) ? 2 : 1);
  const move = (buffer: Buffer, key: string) => {
    const line = buffer.lines[buffer.row];
    const last = buffer.lines.length - 1;
    const vertical = (rows: number) => {
      buffer.row = Math.max(0, Math.min(last, buffer.row + rows));
      const target = buffer.lines[buffer.row];
      buffer.col = Math.min(buffer.col, target.length);
      if (low(target.charCodeAt(buffer.col)) && high(target.charCodeAt(buffer.col - 1))) buffer.col--;
    };
    if (key === 'Left') buffer.col > 0 ? buffer.col = step(line, buffer.col, false) : buffer.row > 0 && (buffer.row--, buffer.col = buffer.lines[buffer.row].length);
    else if (key === 'Right') buffer.col < line.length ? buffer.col = step(line, buffer.col, true) : buffer.row < last && (buffer.row++, buffer.col = 0);
    else if (key === 'Up' || key === 'Down') vertical(key === 'Up' ? -1 : 1);
    else if (key === 'PageUp' || key === 'PageDown') vertical(key === 'PageUp' ? -20 : 20);
    else if (key === 'Home') buffer.col = 0;
    else if (key === 'End') buffer.col = line.length;
    else if (key === 'Ctrl+Home') [buffer.row, buffer.col] = [0, 0];
    else if (key === 'Ctrl+End') [buffer.row, buffer.col] = [last, buffer.lines[last].length];
    else return false;
    return true;
  };
  const indent = (buffer: Buffer) => {
    if (buffer.lines.some(line => line.startsWith('\t'))) return '\t';
    const widths = buffer.lines.slice(0, 400).map(line => /^ +/.exec(line)?.[0].length ?? 0).filter(width => width > 1);
    return ' '.repeat(widths.length ? Math.min(...widths) : 2);
  };
  const type = (root: Root, events: TerminalInputEvent[]) => {
    const buffer = active(root);
    if (!buffer || buffer.parked) return;
    for (const input of events) {
      const key = 'key' in input ? input.key : null;
      const text = 'paste' in input ? input.paste : input.text;
      if (root.finding) {
        if (text !== null) {
          root.find = (root.find + text.split('\n')[0]).slice(0, 200);
          continue;
        }
        if (key === 'Backspace' || key === 'Enter' || key === 'Esc') {
          if (key === 'Backspace') root.find = root.find.slice(0, -1);
          else if (key === 'Enter') next(root, buffer);
          else root.finding = false;
          continue;
        }
        root.finding = false;
      }
      if (text !== null && (!key || !/^(Ctrl|Alt)\+/.test(key))) {
        change(buffer, () => insert(buffer, text));
        continue;
      }
      const shifted = key?.startsWith('Shift+') ? key.slice(6) : null;
      if (shifted && ['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown'].includes(shifted)) {
        buffer.mark ??= [buffer.row, buffer.col];
        move(buffer, shifted);
        continue;
      }
      if (key && move(buffer, key)) {
        buffer.mark = null;
        continue;
      }
      const line = buffer.lines[buffer.row];
      switch (key) {
        case 'Enter':
          change(buffer, () => insert(buffer, `\n${/^[ \t]*/.exec(line.slice(0, buffer.col))?.[0] ?? ''}`));
          break;
        case 'Tab':
          change(buffer, () => insert(buffer, indent(buffer)));
          break;
        case 'Backspace':
        case 'Delete':
          change(buffer, () => {
            if (remove(buffer)) return;
            const forward = key === 'Delete';
            if (forward ? buffer.col < line.length : buffer.col > 0) {
              const other = step(line, buffer.col, forward);
              buffer.lines[buffer.row] = line.slice(0, Math.min(other, buffer.col)) + line.slice(Math.max(other, buffer.col));
              buffer.col = Math.min(other, buffer.col);
            } else if (forward ? buffer.row < buffer.lines.length - 1 : buffer.row > 0) {
              const top = forward ? buffer.row : buffer.row - 1;
              buffer.col = buffer.lines[top].length;
              buffer.lines.splice(top, 2, buffer.lines[top] + buffer.lines[top + 1]);
              buffer.row = top;
            }
          });
          break;
        case 'Esc':
          buffer.mark = null;
          break;
        case 'Ctrl+a':
          buffer.mark = [0, 0];
          [buffer.row, buffer.col] = [buffer.lines.length - 1, buffer.lines.at(-1)!.length];
          break;
        case 'Ctrl+u':
        case 'Ctrl+y': {
          const edit = (key === 'Ctrl+u' ? buffer.undo : buffer.redo).pop();
          if (!edit) break;
          if (key === 'Ctrl+u') buffer.lines.splice(edit.at, edit.after.length, ...edit.before);
          else buffer.lines.splice(edit.at, edit.before.length, ...edit.after);
          [buffer.row, buffer.col] = key === 'Ctrl+u' ? edit.from : edit.to;
          (key === 'Ctrl+u' ? buffer.redo : buffer.undo).push(edit);
          buffer.mark = null;
          break;
        }
        case 'Ctrl+f':
          Object.assign(root, { finding: true, find: '' });
          break;
        case 'Ctrl+g':
          next(root, buffer);
          break;
        case 'Ctrl+e':
          quote(buffer);
          break;
        case 'Ctrl+s':
          if (!buffer.conflict) hop(root, { save: buffer.path });
          else root.notice = 'Resolve the conflict first: reload, keep your buffer or review';
          break;
      }
    }
    if (save(root)) return;
    const restored = load();
    restored.notice = 'Edit refused: the buffer and its undo history would exceed the editor limit; save it or close other buffers';
    api.state.set(restored as unknown as Json);
  };

  const USAGE = 'usage: /edit PATH[:LINE] | save | close [save|discard|cancel] | reload | keep | review | overwrite | undo | redo | find TEXT | next | line N | insert | buffer N | refresh | pane | hide';
  api.command('edit', value => {
    const text = String(value ?? '').trim();
    const [op = '', ...rest] = text.split(' ');
    const argument = rest.join(' ');
    const root = load();
    const buffer = active(root);
    const done = (message: string | null = null) => {
      if (message !== null) root.notice = message;
      return save(root) ? null : { display: 'editor: open buffers exceed the editor limit; close a buffer' };
    };
    const commands = ['save', 'close', 'reload', 'keep', 'review', 'overwrite', 'undo', 'redo', 'find', 'next', 'line', 'insert', 'buffer', 'refresh', 'pane', 'hide'];
    if (!op) {
      root.open = !root.open || !root.buffers.length;
      return done(root.buffers.length ? null : 'No buffer is open; /edit PATH opens one');
    }
    if (!commands.includes(op)) {
      const failed = open(root, text);
      return failed ? { display: failed } : done();
    }
    if (op === 'pane' || op === 'hide') {
      Object.assign(root, op === 'pane' ? { pane: !root.pane, open: true } : { pane: false, open: false });
      return done();
    }
    if (!buffer) return { display: 'No buffer is open; /edit PATH opens one' };
    if (buffer.parked && !['close', 'reload', 'buffer', 'refresh'].includes(op)) return done(`${buffer.path} is still loading`);
    switch (op) {
      case 'save':
        if (buffer.conflict) return done('Resolve the conflict first: reload, keep your buffer or review');
        write(root, buffer, buffer.sha);
        return done();
      case 'close': {
        const choice = argument || (dirty(buffer) ? '' : 'discard');
        if (!choice) {
          root.closing = true;
          return done(`${buffer.path} has unsaved changes`);
        }
        root.closing = false;
        if (choice === 'cancel') return done(null);
        if (choice === 'save' && (buffer.conflict || !write(root, buffer, buffer.sha))) return done();
        root.buffers.splice(root.active, 1);
        root.active = Math.max(0, Math.min(root.active, root.buffers.length - 1));
        if (!root.buffers.length) root.open = false;
        settle(root, choice === 'save' ? size(buffer.lines.join('\n')) : 0);
        hop(root, { sync: true });
        return done(`Closed ${buffer.path}`);
      }
      case 'reload': {
        if (dirty(buffer) && !argument && !buffer.conflict) {
          const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Reload from disk', message: `Discard your unsaved changes to ${buffer.path}?` });
          if (!answer.ok || answer.value.status !== 'accepted') return null;
        }
        const loaded = read(buffer.path);
        if (typeof loaded === 'string') return done(loaded);
        const failed = load_into(buffer, loaded.text, loaded.sha);
        root.review = null;
        return done(failed ? `${buffer.path}: ${failed}` : `Reloaded ${buffer.path}`);
      }
      case 'keep':
        buffer.conflict = null;
        root.review = null;
        return done('Kept your buffer; saving it needs a reviewed overwrite while the file differs');
      case 'review': {
        const stat = api.host.tryCall('workspace.stat', { paths: [buffer.path], hash: true });
        if (!stat.ok) return done(stat.error);
        const sha = stat.value.files[buffer.path]?.sha256 ?? null;
        const disk = sha ? read(buffer.path) : { text: '', sha: null };
        if (typeof disk === 'string') return done(disk);
        const parsed = split(disk.text);
        root.review = { sha: disk.sha, diff: unified(buffer.path, typeof parsed === 'string' || !sha ? [] : parsed.lines, buffer.lines) };
        return done(sha === buffer.sha ? 'The file on disk matches what you opened' : 'Review the difference between the file on disk and your buffer');
      }
      case 'overwrite': {
        if (!root.review) return done('Review the difference first');
        const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title: 'Overwrite after review', message: `Replace ${buffer.path} on disk with your buffer? Changes made on disk since your review are refused.` });
        if (!answer.ok || answer.value.status !== 'accepted') return null;
        write(root, buffer, root.review.sha);
        return done();
      }
      case 'undo':
      case 'redo':
        type(root, [{ key: op === 'undo' ? 'Ctrl+u' : 'Ctrl+y', text: null }]);
        return null;
      case 'find':
        root.find = argument.slice(0, 200);
        root.finding = false;
        next(root, buffer);
        return done();
      case 'next':
        next(root, buffer);
        return done();
      case 'line':
        buffer.row = Math.max(0, Math.min(Number(argument) - 1 || 0, buffer.lines.length - 1));
        buffer.col = 0;
        buffer.mark = null;
        return done();
      case 'insert':
        quote(buffer);
        return null;
      case 'buffer': {
        const index = Number(argument);
        if (!root.buffers[index]) return { display: USAGE };
        const spent = index === root.active ? 0 : park(buffer);
        Object.assign(root, { active: index, closing: false, review: null });
        settle(root, spent);
        hop(root, { sync: true });
        return done();
      }
      case 'refresh':
        for (const item of root.buffers) delete item.base;
        reconcile(root);
        hop(root, { sync: true });
        return done('Refreshed Git markers and disk state');
    }
    return { display: USAGE };
  }, { description: 'Edit workspace files in buffers with Git markers, find, undo and checked saves: /edit PATH[:LINE] | save | close | find TEXT | pane' });

  api.on('component_event', event => {
    if (event.kind !== 'input' || !event.events || event.component !== 'omd_editor_doc') return;
    const root = load();
    if (!active(root)) return;
    root.notice = event.dropped ? `${event.dropped} keystrokes were dropped while the editor was busy` : null;
    type(root, event.events);
  });
  const serve = () => {
    const root = load();
    const want = root.want;
    if (!want.sync && !want.save) return false;
    root.want = {};
    const current = active(root);
    if (want.save && current?.path === want.save && !current.conflict) write(root, current, current.sha);
    if (want.sync && (root.buffers.length || root.watch)) {
      let spent = settle(root);
      for (const buffer of root.buffers) {
        if (buffer !== active(root) && !(spent && spent + cost(buffer) > READS)) spent += park(buffer);
      }
      if (root.watch) api.host.tryCall('workspace.unwatch', { watch_id: root.watch });
      const watched = root.buffers.length ? api.host.tryCall('workspace.watch', { paths: root.buffers.map(buffer => buffer.path), recursive: false, debounce_ms: 300 }) : null;
      root.watch = watched?.ok ? watched.value.watch_id : null;
      if (root.head === null) root.head = head();
      if (!bases(root, spent)) hop(root, { sync: true });
    }
    save(root);
    return true;
  };
  const retry = () => api.host.tryCall('events.schedule', { key: 'hop', delay_ms: 1_000 });
  api.on('channel', event => {
    if (!event.channel.endsWith('/hop')) return;
    retry();
    serve();
  });
  api.on('timer', ({ key }) => {
    const want = key === 'hop' ? load().want : {};
    if (!want.sync && !want.save) return;
    retry();
    serve();
  });
  api.on('workspace_change', event => {
    const root = load();
    if (!root.buffers.length) return;
    const paths = event.status === 'observed' ? event.changes.map(change => change.path).filter(path => root.buffers.some(buffer => buffer.path === path)) : undefined;
    if (paths && !paths.length) return;
    reconcile(root, paths);
    save(root);
  });
  const recover = () => {
    const root = load();
    if (!root.buffers.length) return;
    reconcile(root);
    for (const buffer of root.buffers) delete buffer.base;
    root.watch = null;
    if (root.buffers.some(dirty)) root.notice = `Recovered unsaved buffers: ${root.buffers.filter(dirty).map(buffer => buffer.path).join(', ')}`;
    hop(root, { sync: true });
    save(root);
  };
  api.on('start', recover);
  api.on('resume', recover);
  api.on('turn_end', () => {
    const root = load();
    if (!root.buffers.length) return;
    rebase(root, false);
    save(root);
  });

  const view = (root: Root, buffer: Buffer, id: string, height: number | undefined): TerminalComponent[] => {
    const gutter = marks(buffer);
    const range = selection(buffer);
    const sensitive = root.find !== root.find.toLowerCase();
    const query = sensitive ? root.find : root.find.toLowerCase();
    const pattern = buffer.path.slice(buffer.path.lastIndexOf('.') + 1).toLowerCase();
    const comment = Object.keys(COMMENT).find(mark => COMMENT[mark].includes(pattern));
    const blocks = comment ? BLOCKS[comment] : [];
    const tokens = comment ? new RegExp(`(${comment.replace(/[/]/g, '\\/')}.*$${blocks.includes('/*') ? '|\\/\\*.*?(?:\\*\\/|$)' : ''})|(${blocks.filter(block => block.length === 3).map(quote => `${quote}.*?(?:${quote}|$)|`).join('')}"(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)|(\\b\\d[\\w.]*)|([A-Za-z_$][\\w$]*)`, 'g') : null;
    const paint = (line: string, carry: string | null) => {
      const tags = new Uint8Array(line.length + 1);
      if (!tokens) return { tags, carry };
      let from = 0;
      if (carry) {
        const found = carry === '`' ? /^(?:[^`\\]|\\.)*`/.exec(line)?.[0].length : (index => index < 0 ? undefined : index + carry.length)(line.indexOf(carry));
        from = found ?? line.length;
        tags.fill(carry === '*/' ? 1 : 2, 0, from);
        if (found !== undefined) carry = null;
      }
      tokens.lastIndex = from;
      for (const match of line.matchAll(tokens)) {
        tags.fill(match[1] ? 1 : match[2] ? 2 : match[3] ? 3 : KEYWORDS.has(match[4]) ? 4 : 0, match.index, match.index + match[0].length);
        carry = opener(match[0], blocks);
      }
      return { tags, carry };
    };
    let start = Math.max(0, Math.floor(buffer.row / CHUNK) * CHUNK - CHUNK / 2);
    for (let row = buffer.row, cost = 0; row >= start; row--) {
      const line = buffer.lines[row];
      cost += Math.min(line.length + 3 * (line.match(/\t/g)?.length ?? 0), 4 * LINE_CHARS) + 8;
      if (cost > VIEW_CHARS / 2) start = row + 1;
    }
    start = Math.min(start, buffer.row);
    const end = Math.min(buffer.lines.length, start + VIEW_LINES);
    const width = String(end).length;
    const counts = { '+': 0, '~': 0, '-': 0 } as Record<string, number>;
    for (const mark of gutter) if (mark in counts) counts[mark]++;
    let budget = VIEW_CHARS;
    let carry: string | null = null;
    for (let row = 0; row < start; row++) carry = paint(buffer.lines[row], carry).carry;
    const lines: TerminalSpan[][] = [];
    for (let row = start; row < end && budget > 0; row++) {
      const line = buffer.lines[row];
      const painted = paint(line, carry);
      const tags = painted.tags;
      carry = painted.carry;
      const over = new Uint8Array(line.length + 1);
      if (query) {
        const haystack = sensitive ? line : line.toLowerCase();
        for (let found = haystack.indexOf(query); found >= 0; found = haystack.indexOf(query, found + query.length)) over.fill(1, found, found + query.length);
      }
      if (range && row >= range[0][0] && row <= range[1][0]) over.fill(2, row === range[0][0] ? range[0][1] : 0, row === range[1][0] ? range[1][1] : line.length);
      if (row === buffer.row) over[buffer.col] = 3;
      const cells: { text: string; tag: number; over: number }[] = [];
      let column = 0;
      for (let index = 0; index <= line.length;) {
        const code = line.codePointAt(index);
        const unit = code === undefined ? 1 : code > 0xffff ? 2 : 1;
        const char = code === undefined ? ' ' : code === 9 ? ' '.repeat(4 - column % 4) : code < 32 || code >= 0x7f && code < 0xa0 ? '·' : high(line.charCodeAt(index)) && unit === 1 || low(line.charCodeAt(index)) ? '�' : String.fromCodePoint(code);
        if (code !== undefined || over[index] === 3) cells.push({ text: char, tag: tags[index], over: over[index] });
        column += char.length;
        index += unit;
      }
      const cursor = row === buffer.row ? cells.findIndex(cell => cell.over === 3) : -1;
      const from = cursor > LINE_CHARS - 20 ? cursor - (LINE_CHARS - 100) : 0;
      const shown = cells.slice(from, from + LINE_CHARS);
      const group = (strip: number) => {
        const spans: TerminalSpan[] = [];
        let key = '';
        for (const cell of shown) {
          const tag = strip > 0 ? 0 : cell.tag;
          const layer = strip > 2 ? cell.over === 3 ? 3 : 0 : strip > 1 && cell.over === 1 ? 0 : cell.over;
          const next = `${tag}.${layer}`;
          if (next === key && spans.at(-1)!.text.length < 250) spans.at(-1)!.text += cell.text;
          else spans.push({ ...SYNTAX[tag], ...OVERLAY[layer], text: cell.text });
          key = next;
        }
        return spans;
      };
      let spans = group(0);
      if (spans.length > 8) spans = group(1);
      if (spans.length > 8) spans = group(2);
      if (spans.length > 8) spans = group(3);
      const mark = gutter[row] ?? ' ';
      lines.push([{ text: `${String(row + 1).padStart(width)}`, tone: 'muted' }, { text: mark === ' ' ? '  ' : `${mark} `, tone: MARK_TONE[mark] ?? 'muted' },
        ...(from ? [{ text: '…', tone: 'muted' as const }] : []), ...spans, ...(from + LINE_CHARS < cells.length ? [{ text: '…', tone: 'muted' as const }] : [])]);
      budget -= shown.reduce((sum, cell) => sum + cell.text.length, width + 4);
    }
    const total = query ? buffer.lines.reduce((sum, line) => sum + (sensitive ? line : line.toLowerCase()).split(query).length - 1, 0) : 0;
    const changed = dirty(buffer);
    const status = `${changed ? '● ' : ''}${buffer.path} · ${buffer.row + 1}:${buffer.col + 1} · ${buffer.eol === '\r\n' ? 'CRLF' : 'LF'}${buffer.final ? '' : ' · no final newline'}${buffer.base == null ? '' : ` · Git +${counts['+']} ~${counts['~']} -${counts['-']}`}`;
    const word = [...buffer.lines[buffer.row].matchAll(/[A-Za-z_$][\w$]*/g)].find(match => match.index <= buffer.col && buffer.col <= match.index + match[0].length);
    const steps = trail(buffer);
    const saved = steps && across(steps, buffer.row, false);
    const where = saved === null ? null : `${buffer.path}:${saved + 1}`;
    const choices = (values: [string, string][]) => values.filter(([value]) => size(value) <= 128).map(([value, label]) => ({ value, label: fit(label, 128) }));
    const git = choices(['stage', 'unstage'].map(action => [`${action} ${buffer.path}`, `${action} ${buffer.path}`]));
    const lsp = choices([...(word && where ? ['definition', 'references', 'hover'].map(action => [`${action} ${where}:${word.index + 1}`, `${action} ${word[0]}`] as [string, string]) : []),
      ...(changed ? [] : [[`actions ${where}`, 'code actions'] as [string, string]]),
      ...(changed ? ['symbols', 'diagnostics'] : ['symbols', 'diagnostics', 'format']).map(action => [`${action} ${buffer.path}`, action] as [string, string])]);
    const actions: TerminalSelectOption[] = [
      { value: 'save', label: changed ? 'save (Ctrl+s)' : 'save' }, { value: 'insert', label: 'insert selection into the composer (Ctrl+e)' },
      { value: 'undo', label: 'undo (Ctrl+u)' }, { value: 'redo', label: 'redo (Ctrl+y)' }, { value: 'close', label: 'close buffer' }, { value: 'reload', label: 'reload from disk' },
      { value: 'refresh', label: 'refresh Git markers' }, { value: 'pane', label: root.pane ? 'show as a popup' : 'show in the omd_editor/editor pane' }, { value: 'hide', label: 'hide editor' },
    ];
    return [
      { type: 'text', id: `${id}_status`, label: 'Buffer status', text: status, tone: buffer.conflict ? 'failure' : changed ? 'attention' : 'normal' },
      ...(buffer.conflict || root.notice ? [{ type: 'text' as const, id: `${id}_notice`, label: 'Editor notice', text: buffer.conflict ?? root.notice ?? '', tone: buffer.conflict ? 'failure' as const : 'muted' as const }] : []),
      ...(root.closing ? [{ type: 'select' as const, id: `${id}_close`, label: fit(`${buffer.path} has unsaved changes`, 128), value: 'save', action: { command: 'omd_editor:edit', args: 'close' },
        options: [{ value: 'save', label: 'save and close' }, { value: 'discard', label: 'discard changes and close' }, { value: 'cancel', label: 'keep editing' }] }] : []),
      ...(buffer.conflict ? [{ type: 'select' as const, id: `${id}_conflict`, label: 'Resolve the conflict', value: 'review', action: { command: 'omd_editor:edit' },
        options: [{ value: 'review', label: 'review disk against buffer' }, { value: 'reload', label: 'reload from disk (discard buffer)' }, { value: 'keep', label: 'keep my buffer' }] }] : []),
      ...(root.review ? [
        { type: 'diff' as const, id: `${id}_review`, label: 'Disk against buffer', unified: root.review.diff, height: 12 },
        { type: 'button' as const, id: `${id}_overwrite`, label: 'Overwrite the file with the reviewed buffer', text: 'Overwrite after review', action: { command: 'omd_editor:edit', args: 'overwrite' } },
      ] : []),
      { type: 'select' as const, id: `${id}_actions`, label: 'Editor actions', value: changed ? 'save' : 'insert', options: actions, action: { command: 'omd_editor:edit' } },
      { type: 'document', id: 'omd_editor_doc', label: fit(buffer.path, 128), keys: true, lines,
        selected: { start: buffer.row - start, end: buffer.row - start }, ...(height ? { height } : {}) },
      ...(root.finding || root.find ? [{ type: 'text' as const, id: `${id}_find`, label: 'Find', text: `Find: ${root.find}${root.finding ? '▏' : ''} · ${total} matches · ${root.finding ? 'Enter next, Esc done' : 'Ctrl+g next, Ctrl+f new search'}`, tone: 'muted' as const }] : []),
      ...(root.buffers.length > 1 ? [{ type: 'select' as const, id: `${id}_buffers`, label: 'Buffers', value: String(root.active), action: { command: 'omd_editor:edit', args: 'buffer' },
        options: root.buffers.map((item, index) => ({ value: String(index), label: fit(`${dirty(item) ? '● ' : ''}${item.path}`, 128) })) }] : []),
      ...(api.settings.git === true && buffer.base != null && git.length ? [{ type: 'select' as const, id: `${id}_git`, label: 'Git', value: git[0].value, action: { command: 'omd_git:act' }, options: git }] : []),
      ...(api.settings.lsp === true && lsp.length ? [{ type: 'select' as const, id: `${id}_lsp`, label: 'Code intelligence', value: lsp[0].value, action: { command: 'omd_lsp_view:lsp' }, options: lsp }] : []),
      ...(api.settings.lsp === true && changed ? [{ type: 'text' as const, id: `${id}_lsp_hint`, label: 'Code intelligence',
        text: `Answers use the saved file${where ? '' : ', where this line differs'}; save to format or apply code actions`, tone: 'muted' as const }] : []),
    ];
  };
  api.on('terminal', () => {
    const root = load();
    const unsaved = root.buffers.filter(dirty).length;
    if (!root.open && !root.pane) return unsaved ? { status: [`edit: ${unsaved} unsaved`] } : null;
    const buffer = active(root);
    const id = 'omd_editor';
    const components: TerminalComponent[] = buffer && !buffer.parked ? view(root, buffer, id, root.pane ? undefined : 18)
      : [{ type: 'text', id: `${id}_empty`, label: 'Editor', text: root.notice ?? (buffer ? `Opening ${buffer.path}…` : 'No buffer is open; /edit PATH opens one'), tone: 'muted' }];
    const sites: Partial<Record<string, TerminalRenderSite>> = root.pane ? { 'omd_editor/editor': { mode: 'replace', components } }
      : root.open ? { dialog: { mode: 'wrap', components: [{ type: 'dialog', id: 'omd_editor_dialog', label: 'Editor', title: buffer ? fit(`Edit ${buffer.path}`, 128) : 'Editor', children: components }, { type: 'slot' }] } } : {};
    const keybindings: Partial<Record<KeyName, KeyAction>> = buffer && !buffer.parked ? { 'Alt+u': { focus: 'omd_editor_doc' } } : {};
    return { sites, keybindings, ...(unsaved ? { status: [`edit: ${unsaved} unsaved`] } : {}) };
  });
}
