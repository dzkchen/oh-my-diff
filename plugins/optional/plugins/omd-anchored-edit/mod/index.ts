import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Change = { before: string; after: string };
type FileEdit = { path: string; sha256: string; start_line: number; end_line: number; edits: Change[] };

function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object_required');
  return value;
}

function path(value: Json): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || /[:\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('relative_path_required');
  return value;
}

function files(value: Json): FileEdit[] {
  const input = object(value);
  if (Object.keys(input).some(key => key !== 'files') || !Array.isArray(input.files) || !input.files.length || input.files.length > 8) throw new Error('one_to_eight_files_required');
  let count = 0;
  const result = input.files.map(value => {
    const file = object(value);
    if (Object.keys(file).some(key => !['path', 'sha256', 'start_line', 'end_line', 'edits'].includes(key)) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('malformed_anchor');
    if (!Number.isInteger(file.start_line) || !Number.isInteger(file.end_line) || Number(file.start_line) < 1 || Number(file.end_line) < Number(file.start_line)) throw new Error('invalid_line_scope');
    if (!Array.isArray(file.edits) || !file.edits.length || (count += file.edits.length) > 32) throw new Error('edit_limit');
    const edits = file.edits.map(value => {
      const edit = object(value);
      if (Object.keys(edit).some(key => !['before', 'after'].includes(key)) || typeof edit.before !== 'string' || typeof edit.after !== 'string' || !edit.before || edit.before === edit.after || edit.before.length + edit.after.length > 16384 || /\0/.test(edit.before + edit.after)) throw new Error('exact_nonempty_anchor_required');
      return { before: edit.before, after: edit.after };
    });
    return { path: path(file.path), sha256: file.sha256, start_line: Number(file.start_line), end_line: Number(file.end_line), edits };
  });
  if (new Set(result.map(file => file.path)).size !== result.length) throw new Error('duplicate_file_scope');
  return result;
}

function replace(text: string, file: FileEdit): string {
  if (/(@generated|code generated|do not edit|automatically generated)/i.test(text.slice(0, 2048))) throw new Error('generated_file_requires_ordinary_patch_review');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n' && i + 1 < text.length) starts.push(i + 1);
  if (file.end_line > starts.length) throw new Error('line_scope_out_of_bounds');
  const start = starts[file.start_line - 1];
  const end = starts[file.end_line] ?? text.length;
  const scope = text.slice(start, end);
  const edits = file.edits.map(edit => {
    const offset = scope.indexOf(edit.before);
    if (offset < 0) throw new Error('anchor_changed_or_outside_scope');
    if (scope.indexOf(edit.before, offset + 1) !== -1) throw new Error('ambiguous_anchor');
    return { start: start + offset, end: start + offset + edit.before.length, after: edit.after };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) throw new Error('overlapping_anchors');
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.after + text.slice(edit.end);
  return text;
}

export default function activate(api: ModAPI) {
  api.tool({ name: 'read', description: 'Read exact UTF-8 bytes and their whole-file SHA-256 before a scoped anchored edit.', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } }, required: ['paths'], additionalProperties: false } }, value => {
    const input = object(value);
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 8) throw new Error('one_to_eight_paths_required');
    return api.host.call('workspace.read', { paths: [...new Set(input.paths.map(path))] });
  });
  api.tool({ name: 'edit', description: 'Resolve exact unique text anchors within declared line ranges and whole-file hashes, then submit one host-authorized transaction. Review the ordinary diff afterward.', parameters: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 }, edits: { type: 'array', items: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'], additionalProperties: false } } }, required: ['path', 'sha256', 'start_line', 'end_line', 'edits'], additionalProperties: false } } }, required: ['files'], additionalProperties: false } }, (value): Json => {
    let proposed: FileEdit[];
    try { proposed = files(value); } catch (error) { return { status: 'fallback', reason: String(error), writes_attempted: false, tool: 'apply_patch', instruction: 'Read current bytes and use the ordinary patch tool under its normal permissions.' }; }
    const current = api.host.tryCall('workspace.read', { paths: proposed.map(file => file.path) });
    if (!current.ok) return { status: 'denied', reason: current.error, writes_attempted: false };
    const expected: Record<string, string> = Object.create(null);
    const writes: Record<string, string> = Object.create(null);
    try {
      for (const file of proposed) {
        const actual = current.value.files[file.path];
        if (!actual || actual.sha256 !== file.sha256) throw new Error('stale_file_hash');
        expected[file.path] = actual.sha256;
        writes[file.path] = replace(actual.text, file);
      }
    } catch (error) { return { status: 'fallback', reason: String(error), writes_attempted: false, tool: 'apply_patch', instruction: 'Read current bytes and rebase the intended change using the ordinary patch tool. Do not reuse stale anchors.' }; }
    const result = api.host.tryCall('workspace.transaction', { expected, writes });
    return result.ok ? { status: 'applied', files: result.value.files, review: 'Inspect the ordinary diff and run relevant checks.' } : { status: 'transaction_failed', reason: result.error, review: 'Inspect current files and the ordinary diff before any retry: rollback can conflict with an external writer.' };
  });
}
