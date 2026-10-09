import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Row = { text: string; eol: string };
type Edit = { op: string; anchor?: string; end?: string; lines: string[] };
type Span = { lo: number; hi: number; lines: string[] };

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RADIUS = 16;
const MAX_BYTES = 96_000;
const MAX_OUTPUT = 60_000;
const OPS = ['replace', 'delete', 'insert_before', 'insert_after', 'append', 'prepend'];

// FNV-1a over line number and content, as in pi-hashline-edit: identical lines still get distinct anchors.
function hash(line: number, text: string): string {
  let value = 0x811c9dc5;
  const input = `${line}\n${text}`;
  for (let i = 0; i < input.length; i++) value = Math.imul(value ^ input.charCodeAt(i), 0x01000193);
  let out = '';
  for (let i = 0; i < 4; i++, value >>>= 5) out = ALPHABET[value & 31] + out;
  return out;
}

function split(text: string): Row[] {
  const rows: Row[] = [];
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start);
    if (end < 0) { rows.push({ text: text.slice(start), eol: '' }); break; }
    const cr = end > start && text[end - 1] === '\r';
    rows.push({ text: text.slice(start, cr ? end - 1 : end), eol: cr ? '\r\n' : '\n' });
    start = end + 1;
  }
  return rows;
}

const anchor = (rows: Row[], line: number) => `${line}#${hash(line, rows[line - 1].text)}`;
const render = (rows: Row[], line: number) => `${anchor(rows, line)}|${rows[line - 1].text}`;

function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object_required');
  return value;
}

function path(value: Json): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || /[:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('relative_path_required');
  return value;
}

function edits(value: Json, index: number): Edit[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`file ${index}: edits required`);
  return value.map((entry, at) => {
    const edit = object(entry);
    const where = `edit ${at}`;
    if (typeof edit.op !== 'string' || !OPS.includes(edit.op) || Object.keys(edit).some(key => !['op', 'anchor', 'end', 'lines'].includes(key))) throw new Error(`${where}: op must be one of ${OPS.join(', ')}`);
    const positional = !['append', 'prepend'].includes(edit.op);
    if (positional !== (typeof edit.anchor === 'string') || (edit.end !== undefined && !['replace', 'delete'].includes(edit.op)) || (edit.end !== undefined && typeof edit.end !== 'string')) throw new Error(`${where}: ${positional ? 'anchor required' : 'no anchor allowed'}; end only for replace or delete`);
    if ((edit.op === 'delete') !== (edit.lines === undefined) || (edit.lines !== undefined && (!Array.isArray(edit.lines) || !edit.lines.length || edit.lines.some(line => typeof line !== 'string')))) throw new Error(`${where}: ${edit.op === 'delete' ? 'delete takes no lines' : 'lines must be a non-empty string array'}`);
    return { op: edit.op, anchor: edit.anchor as string | undefined, end: edit.end as string | undefined, lines: ((edit.lines ?? []) as string[]).flatMap(line => line.split(/\r?\n/)) };
  });
}

function plan(rows: Row[], file: string, list: Edit[], failures: Json[]): Span[] {
  const spans: Span[] = [];
  const cite = (edit: number, raw: string): number => {
    const match = /^(\d+)#([0-9A-Z]{4})/.exec(raw);
    if (!match) throw new Error(`edit ${edit}: anchor must be LINE#HASH`);
    const line = Number(match[1]);
    if (line >= 1 && line <= rows.length && hash(line, rows[line - 1].text) === match[2]) return line;
    const moved = [];
    for (let n = Math.max(1, line - RADIUS); n <= Math.min(rows.length, line + RADIUS); n++) if (n !== line && hash(line, rows[n - 1].text) === match[2]) moved.push(n);
    failures.push(moved.length === 1 ? { path: file, edit, anchor: raw, moved_to: anchor(rows, moved[0]) }
      : moved.length ? { path: file, edit, anchor: raw, ambiguous: `${moved.length} identical lines nearby; read again` }
        : { path: file, edit, anchor: raw, stale: line >= 1 && line <= rows.length ? render(rows, line).slice(0, 200) : 'line out of range' });
    return 0;
  };
  list.forEach((edit, index) => {
    if (edit.op === 'append' || edit.op === 'prepend') {
      const at = edit.op === 'append' ? rows.length : 0;
      spans.push({ lo: at, hi: at, lines: edit.lines });
      return;
    }
    const start = cite(index, edit.anchor!);
    const end = edit.end === undefined ? start : cite(index, edit.end);
    if (!start || !end) return;
    if (edit.op.startsWith('insert')) {
      const at = edit.op === 'insert_before' ? start - 1 : start;
      spans.push({ lo: at, hi: at, lines: edit.lines });
    } else if (end < start) throw new Error(`edit ${index}: end precedes anchor`);
    else spans.push({ lo: start - 1, hi: end, lines: edit.lines });
  });
  spans.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  for (let k = 1; k < spans.length; k++) if (spans[k].lo <= Math.max(spans[k - 1].lo, spans[k - 1].hi - 1)) throw new Error(`overlapping edits near line ${spans[k].lo + 1}; use one edit per range`);
  return spans;
}

function apply(text: string, rows: Row[], spans: Span[]): { text: string; diff: string[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const final = text === '' || text.endsWith('\n');
  const next = [...rows];
  for (const span of [...spans].reverse()) {
    const removed = next.slice(span.lo, span.hi);
    const last = removed.at(-1)?.eol ?? '';
    next.splice(span.lo, span.hi - span.lo, ...span.lines.map((line, i) => ({ text: line, eol: i === span.lines.length - 1 && removed.length ? last : removed[i]?.eol ?? '' })));
  }
  const result = next.map((row, i) => row.text + (i < next.length - 1 || final ? row.eol || eol : '')).join('');
  const diff: string[] = [];
  let delta = 0;
  for (const span of spans) {
    const at = span.lo + delta;
    diff.push(`@@ ${at + 1}`, ...rows.slice(span.lo, span.hi).map(row => `-${row.text}`), ...span.lines.map((_, i) => `+${render(next, at + i + 1)}`));
    if (!span.lines.length && at < next.length) diff.push(` ${render(next, at + 1)}`);
    delta += span.lines.length - (span.hi - span.lo);
  }
  return { text: result, diff };
}

function bounded(lines: string[], note: (shown: number) => string): string {
  let size = 0;
  const shown = lines.findIndex(line => (size += line.length + 1) > MAX_OUTPUT);
  return shown < 0 ? lines.join('\n') : [...lines.slice(0, shown), note(shown)].join('\n');
}

export default function activate(api: ModAPI) {
  const guard = (run: () => Json): Json => {
    try { return run(); } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { status: 'rejected', reason: error.message, writes_attempted: false };
    }
  };
  const load = (paths: string[]) => {
    const stat = api.host.tryCall('workspace.stat', { paths });
    if (!stat.ok) return stat;
    const total = paths.reduce((sum, name) => sum + (stat.value.files[name]?.size ?? 0), 0);
    if (total > MAX_BYTES) throw new Error(`files_too_large: ${total} bytes exceeds ${MAX_BYTES}; use the ordinary patch tool`);
    return api.host.tryCall('workspace.read', { paths });
  };

  api.tool({ name: 'read', description: 'Read files as LINE#HASH|content lines. Cite these anchors in the edit tool.', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['paths'], additionalProperties: false } }, value => guard(() => {
    const input = object(value);
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 8) throw new Error('one_to_eight_paths_required');
    const paths = [...new Set(input.paths.map(path))];
    const offset = Math.max(1, Math.floor(Number(input.offset ?? 1)) || 1);
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(input.limit ?? 2000)) || 2000));
    const current = load(paths);
    if (!current.ok) return { status: 'denied', reason: current.error };
    const lines = paths.flatMap(name => {
      const file = current.value.files[name];
      if (!file) return [`${name}: missing`, ''];
      const rows = split(file.text);
      const last = Math.min(rows.length, offset + limit - 1);
      const more = rows.length > last ? [`… ${rows.length - last} more lines; read with offset ${last + 1}`] : [];
      return [`${name} (${rows.length} lines)`, ...rows.slice(offset - 1, last).map((_, i) => render(rows, offset + i)), ...more, ''];
    });
    return bounded(lines, shown => `… output truncated; read again with offset near the last line shown (${shown} lines listed)`);
  }));

  api.tool({ name: 'search', description: 'Search the repository with ripgrep and return matching lines as LINE#HASH|content anchors for the edit tool.', parameters: { type: 'object', properties: { pattern: { type: 'string', minLength: 1, maxLength: 1000 }, path: { type: 'string' }, glob: { type: 'string', maxLength: 256 }, literal: { type: 'boolean' }, ignore_case: { type: 'boolean' }, context: { type: 'integer', minimum: 0, maximum: 5 } }, required: ['pattern'], additionalProperties: false } }, value => guard(() => {
    const input = object(value);
    if (typeof input.pattern !== 'string' || !input.pattern || input.pattern.length > 1000) throw new Error('pattern_required');
    const argv = ['--json', '--max-count', '20', '--max-filesize', '1M', '-C', String(Math.min(5, Math.max(0, Number(input.context ?? 0))))];
    if (input.literal === true) argv.push('-F');
    if (input.ignore_case === true) argv.push('-i');
    if (typeof input.glob === 'string') argv.push('--glob', input.glob);
    argv.push('-e', input.pattern, '--', ...(input.path === undefined ? [] : [path(input.path)]));
    const run = api.host.tryCall('exec.run', { program: 'rg', argv, timeout_ms: 20_000, max_output_bytes: 1 << 20 });
    if (!run.ok) return { status: 'denied', reason: run.error };
    if (run.value.exit_code === 1) return 'no matches';
    if (run.value.exit_code !== 0) return { status: 'failed', reason: run.value.stderr.slice(0, 500) };
    const lines: string[] = [];
    let previous = '';
    let next = 0;
    for (const raw of run.value.stdout.split('\n')) {
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try { event = JSON.parse(raw); } catch { continue; }
      const file = event.data?.path?.text?.replace(/^\.\//, '');
      const text = event.data?.lines?.text?.replace(/\r?\n$/, '');
      const line = event.data?.line_number;
      if ((event.type !== 'match' && event.type !== 'context') || !file || text === undefined || !line || text.length > 1000) continue;
      if (file !== previous) lines.push(`${file}`);
      else if (line !== next) lines.push('--');
      lines.push(`${line}#${hash(line, text)}|${text}`);
      previous = file;
      next = line + 1;
    }
    if (run.value.stdout_preview_truncated) lines.push('… output truncated; narrow the pattern, path or glob');
    return bounded(lines, () => '… output truncated; narrow the pattern, path or glob');
  }));

  api.tool({ name: 'edit', description: 'Apply hashline edits atomically. Each op cites LINE#HASH anchors from read, search or a previous edit; only cited lines are verified. Returns fresh anchors and a compact diff.', parameters: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', minItems: 1, items: { type: 'object', properties: { op: { type: 'string', enum: OPS }, anchor: { type: 'string', description: 'LINE#HASH of the first line, or the insertion point' }, end: { type: 'string', description: 'LINE#HASH of the last line for a multi-line replace or delete' }, lines: { type: 'array', items: { type: 'string' }, description: 'New lines; omit for delete' } }, required: ['op'], additionalProperties: false } } }, required: ['path', 'edits'], additionalProperties: false } } }, required: ['files'], additionalProperties: false } }, value => guard((): Json => {
    const input = object(value);
    if (Object.keys(input).some(key => key !== 'files') || !Array.isArray(input.files) || !input.files.length || input.files.length > 8) throw new Error('one_to_eight_files_required');
    const files = input.files.map((entry, index) => {
      const file = object(entry);
      return { path: path(file.path), edits: edits(file.edits, index) };
    });
    if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('duplicate_file');
    if (files.reduce((count, file) => count + file.edits.length, 0) > 32) throw new Error('at_most_32_edits');
    const current = load(files.map(file => file.path));
    if (!current.ok) return { status: 'denied', reason: current.error, writes_attempted: false };
    const failures: Json[] = [];
    const expected: Record<string, string> = Object.create(null);
    const writes: Record<string, string> = Object.create(null);
    const diff: string[] = [];
    for (const file of files) {
      const actual = current.value.files[file.path];
      try {
        if (!actual) throw new Error('file missing; create files with the ordinary patch tool');
        if (/(@generated|code generated|do not edit|automatically generated)/i.test(actual.text.slice(0, 2048))) throw new Error('generated file; use the ordinary patch tool');
        const rows = split(actual.text);
        const count = failures.length;
        const spans = plan(rows, file.path, file.edits, failures);
        if (failures.length > count) continue;
        const result = apply(actual.text, rows, spans);
        if (result.text === actual.text) throw new Error('edit produces no change; read the file again');
        expected[file.path] = actual.sha256;
        writes[file.path] = result.text;
        diff.push(file.path, ...result.diff);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push({ path: file.path, error: error.message });
      }
    }
    if (failures.length) return { status: 'rejected', writes_attempted: false, failures };
    const result = api.host.tryCall('workspace.transaction', { expected, writes });
    if (!result.ok) return { status: 'transaction_failed', reason: result.error, review: 'Inspect current files before any retry: rollback can conflict with another writer.' };
    return { status: 'applied', diff: bounded(diff, () => '… diff truncated; read the files for further anchors') };
  }));
}
