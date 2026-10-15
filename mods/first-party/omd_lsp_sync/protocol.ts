import type { Json } from '../../api.d.ts';

export type Adapter = 'python' | 'typescript' | 'rust' | 'java';
export type Document = { sha256: string; version: number };
export type Diagnostic = { count: number; version: number | null; errors: string[] };
export type State = {
  adapter: Adapter;
  server: string | null;
  repository: string;
  running: boolean;
  next_id: number;
  capabilities: Json;
  documents: Record<string, Document>;
  diagnostics: Record<string, Diagnostic>;
  preview: { path: string; source_sha256: string; source_version: number; thread_id: string; range: Json; actions: string[] } | null;
  status: 'idle' | 'synced' | 'fallback' | 'stale';
  reason: string;
};
export type Message = Record<string, Json>;
export type Item = { label: string; value: string };
export type Answer = { status: 'ready' | 'error'; message: string; items: Item[]; text: string | null; action: 'open' | 'apply' };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const fail = (error: string) => ({ ok: false as const, error });
export const ok = <T>(value: T) => ({ ok: true as const, value });

export const ADAPTERS: Record<Adapter, { candidates: { name: string; arguments: string[] }[] }> = {
  python: { candidates: [{ name: 'pyright-langserver', arguments: ['--stdio'] }, { name: 'pylsp', arguments: [] }, { name: 'jedi-language-server', arguments: [] }] },
  typescript: { candidates: [{ name: 'typescript-language-server', arguments: ['--stdio'] }, { name: 'vtsls', arguments: ['--stdio'] }] },
  rust: { candidates: [{ name: 'rust-analyzer', arguments: [] }] },
  java: { candidates: [{ name: 'jdtls', arguments: ['--jvm-arg=-Duser.home={process.home}'] }] },
};
export const ORDER: Adapter[] = ['python', 'typescript', 'rust', 'java'];
export const adapterFor = (path: string): Adapter | null => path.length > 240 ? null
  : /\.pyi?$/.test(path) ? 'python'
    : /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) ? 'typescript'
      : path.endsWith('.rs') ? 'rust'
        : path.endsWith('.java') ? 'java' : null;
export const languageId = (path: string) => /\.(?:js|jsx|mjs|cjs)$/.test(path) ? 'javascript' : adapterFor(path);
export const object = (value: Json): Record<string, Json> | null => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
export const string = (value: Json): string | null => typeof value === 'string' ? value : null;
export const number = (value: Json): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
export const linesOf = (text: string): number[] => {
  const lines = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines.push(index + 1);
  return lines;
};
export const fileUri = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
export const uri = (repository: string, path: string) => fileUri(`${repository}/${path}`);
export const doc = (s: { repository: string }, path: string) => ({ textDocument: { uri: uri(s.repository, path) } });
export const pathFromUri = (repository: string, value: string): string | null => {
  if (!value.startsWith('file://')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.slice(7)); } catch { return null; }
  const prefix = `${repository}/`;
  if (!decoded.startsWith(prefix)) return null;
  const path = decoded.slice(prefix.length);
  return path && !path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') ? path : null;
};

export function offset(text: string, lines: number[], position: Json): number | null {
  const point = object(position);
  const line = number(point?.line ?? null);
  const character = number(point?.character ?? null);
  if (line === null || character === null || line < 0 || character < 0 || line >= lines.length) return null;
  const start = lines[line];
  const end = line + 1 < lines.length ? lines[line + 1] - 1 : text.length;
  const width = end - start;
  if (character > width) return null;
  const index = start + character;
  if (index > start && index < text.length) {
    const previous = text.charCodeAt(index - 1);
    const following = text.charCodeAt(index);
    if (previous >= 0xd800 && previous <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) return null;
  }
  return index;
}

export function rewrite(text: string, edits: Json[]): string | null {
  const ranges: { start: number; end: number; value: string }[] = [];
  const lines = linesOf(text);
  for (const entry of edits) {
    const edit = object(entry);
    const range = object(edit?.range ?? null);
    const start = offset(text, lines, range?.start ?? null);
    const end = offset(text, lines, range?.end ?? null);
    const value = string(edit?.newText ?? null);
    if (start === null || end === null || start > end || value === null) return null;
    ranges.push({ start, end, value });
  }
  ranges.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 1; index < ranges.length; index++) if (ranges[index].end > ranges[index - 1].start || ranges[index].start === ranges[index - 1].start) return null;
  let result = text;
  for (const range of ranges) result = result.slice(0, range.start) + range.value + result.slice(range.end);
  return result;
}

export function checkedRange(text: string, value: Json): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  const range = object(value);
  const start = object(range?.start ?? null);
  const end = object(range?.end ?? null);
  const lines = linesOf(text);
  const first = offset(text, lines, start);
  const last = offset(text, lines, end);
  if (first === null || last === null || first > last) return null;
  return { start: { line: Number(start?.line), character: Number(start?.character) }, end: { line: Number(end?.line), character: Number(end?.character) } };
}

export function renameEdit(repository: string, old: string, next: string, response: Json): Result<Record<string, { version: number | null; edits: Json[] }>> {
  if (response === null) return ok({});
  const edit = object(response);
  if (!edit || (edit.changeAnnotations !== undefined && Object.keys(object(edit.changeAnnotations) ?? {}).length)) return fail('server_rename_edit_unsupported');
  const grouped: Record<string, { version: number | null; edits: Json[] }> = {};
  if (edit.changes !== undefined) {
    const changes = object(edit.changes);
    if (!changes) return fail('server_rename_changes_invalid');
    for (const [name, edits] of Object.entries(changes)) {
      const path = pathFromUri(repository, name);
      if (!path || !Array.isArray(edits) || grouped[path]) return fail('server_rename_scope_invalid');
      grouped[path] = { version: null, edits };
    }
  }
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges) || edit.changes !== undefined) return fail('server_rename_changes_conflict');
    for (const entry of edit.documentChanges) {
      const change = object(entry);
      if (!change) return fail('server_rename_change_invalid');
      if (change.kind === 'rename') {
        if (change.oldUri !== uri(repository, old) || change.newUri !== uri(repository, next)) return fail('server_rename_extra_file_operation');
        continue;
      }
      if (change.kind !== undefined) return fail('server_rename_extra_file_operation');
      const target = object(change.textDocument ?? null);
      const path = target && string(target.uri) ? pathFromUri(repository, String(target.uri)) : null;
      const version = number(target?.version ?? null);
      if (!path || !Array.isArray(change.edits) || grouped[path] || (target?.version !== null && target?.version !== undefined && version === null)) return fail('server_rename_document_invalid');
      grouped[path] = { version, edits: change.edits };
    }
  }
  if (edit.changes === undefined && edit.documentChanges === undefined) return fail('server_rename_edit_missing');
  return ok(grouped);
}

export function textWorkspaceEdit(repository: string, response: Json): Result<Record<string, { version: number | null; edits: Json[] }>> {
  const edit = object(response);
  if (!edit || edit.changeAnnotations !== undefined || (edit.changes !== undefined && edit.documentChanges !== undefined)) return fail('server_edit_unsupported');
  const grouped: Record<string, { version: number | null; edits: Json[] }> = {};
  const add = (name: Json, version: Json, edits: Json): boolean => {
    const path = string(name);
    const relative = path && pathFromUri(repository, path);
    if (!relative || relative.length > 240 || grouped[relative] || !Array.isArray(edits) || edits.length > 1024) return false;
    if (version !== null && (number(version) === null || Number(version) < 0)) return false;
    if (edits.some(entry => !object(entry) || object(entry)?.annotationId !== undefined)) return false;
    grouped[relative] = { version: number(version), edits };
    return true;
  };
  if (edit.changes !== undefined) {
    const changes = object(edit.changes);
    if (!changes) return fail('server_edit_invalid');
    for (const [name, edits] of Object.entries(changes)) if (!add(name, null, edits)) return fail('server_edit_invalid');
  } else if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) return fail('server_edit_invalid');
    for (const entry of edit.documentChanges) {
      const change = object(entry);
      const targetDocument = object(change?.textDocument ?? null);
      if (!change || change.kind !== undefined || !targetDocument || !add(targetDocument.uri ?? null, targetDocument.version ?? null, change.edits ?? null)) return fail('server_edit_invalid');
    }
  } else return fail('server_edit_missing');
  if (!Object.keys(grouped).length || Object.values(grouped).reduce((count, target) => count + target.edits.length, 0) > 1024) return fail('server_edit_empty_or_large');
  return ok(grouped);
}

export function state(value: Json, adapter: Adapter): State {
  const root = object(value) ?? {};
  const saved = object(object(root.servers ?? null)?.[adapter] ?? null) ?? {};
  const documents: Record<string, Document> = {};
  for (const [path, entry] of Object.entries(object(saved.documents ?? null) ?? {})) {
    const data = object(entry);
    if (data && string(data.sha256) && number(data.version) !== null) documents[path] = { sha256: String(data.sha256), version: Number(data.version) };
  }
  const diagnostics: Record<string, Diagnostic> = {};
  for (const [path, entry] of Object.entries(object(saved.diagnostics ?? null) ?? {})) {
    const data = object(entry);
    if (data && number(data.count) !== null) diagnostics[path] = { count: Number(data.count), version: number(data.version), errors: Array.isArray(data.errors) ? data.errors.filter(item => typeof item === 'string').slice(0, 50) as string[] : [] };
  }
  const savedPreview = object(saved.preview ?? null);
  const previewActions = savedPreview?.actions;
  const preview = string(savedPreview?.path ?? null) && string(savedPreview?.source_sha256 ?? null) && number(savedPreview?.source_version ?? null) !== null && string(savedPreview?.thread_id ?? null) && object(savedPreview?.range ?? null) && Array.isArray(previewActions) && previewActions.length <= 32 && previewActions.every(item => typeof item === 'string') && serializedBytes(previewActions) <= 16_384
    ? { path: String(savedPreview?.path), source_sha256: String(savedPreview?.source_sha256), source_version: Number(savedPreview?.source_version), thread_id: String(savedPreview?.thread_id), range: savedPreview?.range ?? null, actions: previewActions as string[] }
    : null;
  return {
    adapter,
    server: string(saved.server ?? null),
    repository: string(saved.repository ?? null) ?? '',
    running: saved.running === true,
    next_id: number(saved.next_id ?? null) ?? 1,
    capabilities: saved.capabilities ?? null,
    documents,
    diagnostics,
    preview,
    status: saved.status === 'synced' || saved.status === 'stale' || saved.status === 'fallback' ? saved.status : 'idle',
    reason: string(saved.reason ?? null) ?? '',
  };
}

export function failure(s: State, reason: string, stale = false): void {
  s.status = stale ? 'stale' : 'fallback';
  s.reason = [...reason].slice(0, 256).join('');
}

export const OBSERVED_REPOSITORY_KEY = 'lsp.observed_repository';
export const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const size = (value: unknown) => serializedBytes(value) + 96;
