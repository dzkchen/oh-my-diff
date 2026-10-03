import type { ExecResult, Json, ModAPI, ServiceContract } from '../../api.d.ts';

type Language = 'rust' | 'python' | 'typescript' | 'javascript' | 'java';
type Source = { path: string; language: Language; sha256: string; bytes: number; text: string };
type Anchor = { path: string; line: number; sha256: string };
type Node = { id: string; kind: 'module' | 'symbol' | 'test' | 'unknown'; name: string; path: string | null; line: number | null };
type Edge = { from: string; to: string; relationship: 'contains' | 'imports' | 'calls' | 'tests'; confidence: 'extracted' | 'inferred' | 'unknown'; evidence: Anchor; detail: string };
type Graph = { schema: 1; generator: string; repository_identity: string; root: string; revision: string; candidate_sha256: string; source_digest: string; sources: { path: string; language: Language; sha256: string; bytes: number }[]; nodes: Node[]; edges: Edge[]; coverage: { path: string; extracted: number; inferred: number; unknown: number }[]; unsupported_languages: string[] };
type Boundary = { id: string; from_prefix: string; denied_to_prefix: string };
type Duplicate = { id: string; path_prefixes: string[]; minimum_logical_lines: number };
type Verification = { id: string; test_path_prefix: string; minimum_tests: number; minimum_assertions_per_test: number };
type Constraints = { schema: 1; version: string; repository_identity: string; approval: { actor: string; reason: string }; dependency_boundaries: Boundary[]; duplication_scopes: Duplicate[]; verification: Verification[]; repair_scope: string[]; max_findings: number };
type Observation = { fingerprint: string; kind: 'dependency_boundary' | 'duplicated_domain_logic' | 'weakened_check'; constraint_id: string; certainty: 'deterministic' | 'inferred' | 'uncertain'; subject: string; evidence: Anchor | null; related_evidence?: Anchor[]; detail: string };
type CheckSignature = { key: string; path: string; name: string; assertions: number; skipped: boolean; evidence: Anchor };
type Body = CheckSignature & { test: boolean; logical_lines: number; normalized_sha256: string };
type Baseline = { schema: 1; generator: string; repository_identity: string; root: string; revision: string; source_digest: string; constraints_sha256: string; observations: Observation[]; checks: CheckSignature[]; integrity_sha256: string };

const GENERATOR = 'omd-repository-analysis-five-language-v3';
const SHA = /^[0-9a-f]{64}$/;
const SOURCE_LIMIT = 32 * 1024 * 1024;
const FILE_LIMIT = 1024 * 1024;
const READ_BATCH_LIMIT = 3 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_NODES = 20000;
const MAX_EDGES = 50000;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/;
const PAGE_SIZE = 32;
const SERVICE: ServiceContract = { name: 'omd.repository_analysis', version: '1.0.0', methods: {
  search: { input: 'object', output: 'object' }, select: { input: 'object', output: 'object' },
} };

function pathValid(path: unknown, empty = false): path is string {
  return typeof path === 'string' && (empty || path.length > 0) && path.length <= 512 && !path.startsWith('/') && !path.includes('\\')
    && (path === '' || path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part !== '.git'));
}

function record(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('analysis_input_invalid');
  return value;
}

function string(value: Json, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`${label}_invalid`);
  return value;
}

function common(input: Json): { identity: string; revision: string; root: string } {
  const value = record(input);
  const identity = string(value.repository_identity, 'repository_identity');
  const revision = string(value.revision, 'revision');
  const root = value.root === undefined ? '' : value.root;
  if (!IDENTIFIER.test(identity) || identity.split('/').some(part => part === '.' || part === '..') || !pathValid(root, true)) throw new Error('analysis_scope_invalid');
  return { identity, revision, root };
}

function bytes(text: string): Uint8Array {
  const encoded = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes(text) as BufferSource);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compare(left, right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

async function hashJson(value: Json): Promise<string> { return digest(JSON.stringify(canonical(value))); }

function language(path: string): Language | null {
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.py')) return 'python';
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return 'javascript';
  if (path.endsWith('.java')) return 'java';
  return null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sources(api: ModAPI, root: string): Promise<{ files: Source[]; candidate: string; unsupported: string[] }> {
  const before = api.host.call('workspace.fingerprint', {});
  if (!SHA.test(before.candidate_sha256)) throw new Error('candidate_digest_invalid');
  const listing = api.host.call('workspace.list', { path: root, recursive: true, include_ignored: false, max_entries: 20000 });
  if (listing.truncated) throw new Error('analysis_listing_truncated');
  const entries = listing.entries.filter(entry => language(entry.path));
  if (entries.some(entry => !pathValid(entry.path) || (root && !under(entry.path, root)) || entry.kind === 'symlink')) throw new Error('analysis_source_unsafe');
  const selected = entries.filter(entry => entry.kind === 'file').sort((a, b) => compare(a.path, b.path));
  if (new Set(selected.map(entry => entry.path)).size !== selected.length || selected.some(entry => !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new Error('analysis_source_unsafe');
  if (selected.length > MAX_FILES) throw new Error('analysis_file_limit');
  if (selected.some(entry => entry.size > FILE_LIMIT) || selected.reduce((sum, entry) => sum + entry.size, 0) > SOURCE_LIMIT) throw new Error('analysis_byte_limit');
  const files: Source[] = [];
  for (let index = 0; index < selected.length;) {
    const batch = [];
    let size = 0;
    while (index < selected.length && batch.length < 16 && size + selected[index].size <= READ_BATCH_LIMIT) {
      batch.push(selected[index++]);
      size += batch[batch.length - 1].size;
    }
    if (!batch.length) batch.push(selected[index++]);
    const paths = batch.map(entry => entry.path);
    const read = api.host.call('workspace.read', { paths });
    for (const entry of batch) {
      const file = read.files[entry.path];
      if (!file || !SHA.test(file.sha256) || await digest(file.text) !== file.sha256) throw new Error('analysis_source_stale');
      const readSize = bytes(file.text).length;
      if (readSize !== entry.size) throw new Error('analysis_source_stale');
      files.push({ path: entry.path, language: language(entry.path)!, sha256: file.sha256, bytes: readSize, text: file.text });
    }
  }
  api.host.call('workspace.fingerprint', { expected: before.candidate_sha256 });
  return { files, candidate: before.candidate_sha256, unsupported: [] };
}

async function liveSources(api: ModAPI, root: string): Promise<{ files: Source[]; source_digest: string }> {
  const list = () => api.host.call('workspace.list', { path: root, recursive: true, include_ignored: false, max_entries: 20000 });
  const selected = (listing: ReturnType<typeof list>) => {
    if (listing.truncated) throw new Error('analysis_listing_truncated');
    const entries = listing.entries.filter(entry => language(entry.path));
    if (entries.some(entry => !pathValid(entry.path) || root && !under(entry.path, root) || entry.kind === 'symlink')) throw new Error('analysis_source_unsafe');
    const files = entries.filter(entry => entry.kind === 'file').sort((left, right) => compare(left.path, right.path));
    if (new Set(files.map(entry => entry.path)).size !== files.length || files.some(entry => !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new Error('analysis_source_unsafe');
    if (files.length > MAX_FILES) throw new Error('analysis_file_limit');
    if (files.some(entry => entry.size > FILE_LIMIT) || files.reduce((sum, entry) => sum + entry.size, 0) > SOURCE_LIMIT) throw new Error('analysis_byte_limit');
    return files;
  };
  const before = selected(list());
  const files: Source[] = [];
  for (let index = 0; index < before.length;) {
    const batch = [];
    let size = 0;
    while (index < before.length && batch.length < 16 && size + before[index].size <= READ_BATCH_LIMIT) {
      batch.push(before[index++]);
      size += batch[batch.length - 1].size;
    }
    if (!batch.length) batch.push(before[index++]);
    const paths = batch.map(entry => entry.path);
    const read = api.host.call('workspace.read', { paths });
    for (const entry of batch) {
      const file = read.files[entry.path];
      if (!file || !SHA.test(file.sha256) || await digest(file.text) !== file.sha256) throw new Error('analysis_source_stale');
      const readSize = bytes(file.text).length;
      if (readSize !== entry.size) throw new Error('analysis_source_stale');
      files.push({ path: entry.path, language: language(entry.path)!, sha256: file.sha256, bytes: readSize, text: file.text });
    }
  }
  const after = selected(list());
  if (JSON.stringify(before.map(entry => [entry.path, entry.size])) !== JSON.stringify(after.map(entry => [entry.path, entry.size]))) throw new Error('analysis_source_stale');
  if (files.length) {
    const final = api.host.call('workspace.stat', { paths: files.map(file => file.path), hash: true }).files;
    for (const file of files) if (final[file.path]?.kind !== 'file' || final[file.path]?.size !== file.bytes
      || final[file.path]?.sha256 !== file.sha256) throw new Error('analysis_source_stale');
  }
  return { files, source_digest: await digest(JSON.stringify(files.map(file => [file.path, file.sha256]))) };
}

function codeLines(file: Source): string[] {
  const lines = file.text.split(/\r?\n/);
  let block = false;
  return lines.map(line => {
    let code = '';
    for (let index = 0; index < line.length; index++) {
      if (block) {
        if (line.slice(index, index + 2) === '*/') { block = false; index++; }
      } else if (line.slice(index, index + 2) === '/*') { block = true; index++; }
      else if (line.slice(index, index + 2) === '//' || (file.language === 'python' && line[index] === '#')) break;
      else code += line[index];
    }
    return code;
  });
}

function definition(line: string, lang: Language): { name: string; kind: string } | null {
  let match: RegExpMatchArray | null;
  if (lang === 'rust') match = line.match(/^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|const|extern|default)\s+)*(fn|struct|enum|trait|mod|type)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/);
  else if (lang === 'python') match = line.match(/^\s*(?:async\s+)?(def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/);
  else if (lang === 'java') {
    match = line.match(/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(class|interface|enum|record)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/);
    if (!match) {
      const method = line.match(/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:[a-zA-Z_][\w<>\[\],?]*\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      if (method) return { name: method[1], kind: 'function' };
    }
  } else {
    match = line.match(/^\s*(?:(?:export|default|declare|async|public|private|protected|static|abstract)\s+)*(function|class|interface|type|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/);
    if (!match) {
      const arrow = line.match(/^\s*(?:(?:export|default|declare)\s+)*(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=.*=>/);
      if (arrow) return { name: arrow[1], kind: 'function' };
    }
  }
  return match ? { name: match[2], kind: match[1] === 'fn' || match[1] === 'def' || match[1] === 'function' ? 'function' : match[1] } : null;
}

function importValues(line: string, lang: Language): string[] {
  const code = line.trim();
  if (lang === 'rust') {
    const used = code.match(/^(?:pub\s+)?use\s+((?:crate|self|super)::[a-zA-Z0-9_:]+)\s*;/);
    const module = code.match(/^(?:pub\s+)?mod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/);
    return used ? [used[1]] : module ? [`self::${module[1]}`] : [];
  }
  if (lang === 'python') {
    const from = code.match(/^from\s+([.a-zA-Z_][.a-zA-Z0-9_]*)\s+import\s+/);
    const imported = code.match(/^import\s+([a-zA-Z_][.a-zA-Z0-9_]*)\b/);
    return from ? [from[1]] : imported ? [imported[1]] : [];
  }
  if (lang === 'java') {
    const imported = code.match(/^import\s+(?:static\s+)?([a-zA-Z_][.a-zA-Z0-9_]*)(?:\.\*)?\s*;/);
    return imported ? [imported[1]] : [];
  }
  if (/^import\s+/.test(code) || /^export\s+(?:type\s+)?(?:\*|\{)[^;]*\bfrom\s*['"]/.test(code) || /\brequire\s*\(/.test(code)) {
    const imported = code.match(/(?:from\s*|^\s*import\s*|require\s*\()(['"])([^'"]+)\1/);
    return imported ? [imported[2]] : [];
  }
  return [];
}

function importStatement(line: string, lang: Language): boolean {
  const code = line.trim();
  if (lang === 'rust') return /^(?:pub\s+)?(?:use|mod)\s+/.test(code);
  if (lang === 'python') return /^(?:from|import)\s+/.test(code);
  if (lang === 'java') return /^import\s+/.test(code);
  return /^import\s+/.test(code) || /^export\s+(?:type\s+)?(?:\*|\{)[^;]*\bfrom\s*['"]/.test(code) || /\brequire\s*\(/.test(code);
}

function normalizedPath(parts: string[]): string | null {
  const path: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!path.length) return null; path.pop(); }
    else path.push(part);
  }
  return path.join('/');
}

function importTarget(path: string, raw: string, lang: Language, present: Set<string>): { target: string | null; inferred_path: string } {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  let bases: string[] = [];
  let suffixes: string[];
  if (lang === 'rust') {
    const marker = raw.startsWith('crate::') ? 'crate::' : raw.startsWith('self::') ? 'self::' : raw.startsWith('super::') ? 'super::' : '';
    if (!marker) return { target: null, inferred_path: raw };
    const segments = raw.slice(marker.length).split('::');
    if (segments.some(segment => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment))) return { target: null, inferred_path: raw };
    const base = marker === 'crate::' ? 'src' : marker === 'super::' ? parent.split('/').slice(0, -1).join('/') : parent;
    for (let size = segments.length; size >= 1; size--) bases.push([base, ...segments.slice(0, size)].filter(Boolean).join('/'));
    suffixes = ['.rs', '/mod.rs'];
  } else if (lang === 'python') {
    const relative = raw.startsWith('.');
    const levels = relative ? raw.match(/^\.+/)![0].length : 0;
    const tail = raw.slice(levels).replace(/\./g, '/');
    const directories = parent.split('/').filter(Boolean);
    if (levels > directories.length + 1) return { target: null, inferred_path: raw };
    const ancestor = directories.slice(0, directories.length - levels + 1).join('/');
    bases = relative ? [[ancestor, tail].filter(Boolean).join('/')] : [tail, [parent, tail].filter(Boolean).join('/')];
    suffixes = ['.py', '/__init__.py'];
  } else if (lang === 'java') {
    bases = [raw.replace(/\./g, '/'), [parent, raw.replace(/\./g, '/')].filter(Boolean).join('/')];
    suffixes = ['.java'];
  } else {
    if (!raw.startsWith('.')) return { target: null, inferred_path: raw };
    const base = normalizedPath([...parent.split('/').filter(Boolean), ...raw.split('/')]);
    if (!base) return { target: null, inferred_path: raw };
    bases = [base];
    suffixes = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  }
  for (const base of bases) {
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`;
      if (present.has(candidate)) return { target: candidate, inferred_path: candidate };
    }
  }
  return { target: null, inferred_path: `${bases[0] || raw}${suffixes[0] || ''}` };
}

function graph(identity: string, revision: string, root: string, candidate: string, files: Source[], unsupported: string[], sourceDigest: string): Graph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const coverage: Graph['coverage'] = [];
  const present = new Set(files.map(file => file.path));
  const definitions = new Map<string, Node[]>();
  const linesByPath = new Map(files.map(file => [file.path, codeLines(file)]));
  for (const file of files) {
    nodes.push({ id: `module:${file.path}`, kind: 'module', name: file.path, path: file.path, line: 1 });
    const lines = linesByPath.get(file.path)!;
    for (let index = 0; index < lines.length; index++) {
      const found = definition(lines[index], file.language);
      if (!found) continue;
      const node: Node = { id: `symbol:${file.path}:${index + 1}:${found.name}`, kind: file.path.split('/').some(part => part === 'tests' || part === 'test' || part === '__tests__') || /^(?:test_|should_)/.test(found.name) || found.name.endsWith('Test') || file.text.split(/\r?\n/)[index - 1]?.trim() === '#[test]' ? 'test' : 'symbol', name: found.name, path: file.path, line: index + 1 };
      nodes.push(node);
      definitions.set(found.name, [...(definitions.get(found.name) || []), node]);
      edges.push({ from: `module:${file.path}`, to: node.id, relationship: 'contains', confidence: 'extracted', evidence: { path: file.path, line: index + 1, sha256: file.sha256 }, detail: `${found.kind} definition` });
    }
  }
  for (const file of files) {
    const lines = linesByPath.get(file.path)!;
    let extracted = edges.filter(edge => edge.evidence.path === file.path).length;
    let inferred = 0;
    let unknown = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const code = line;
      const imports = importValues(code, file.language);
      if (!imports.length && importStatement(code, file.language)) {
        const raw = code.trim().slice(0, 160);
        const target = `unknown:import_syntax:${file.path}:${index + 1}`;
        nodes.push({ id: target, kind: 'unknown', name: raw, path: null, line: null });
        edges.push({ from: `module:${file.path}`, to: target, relationship: 'imports', confidence: 'unknown', evidence: { path: file.path, line: index + 1, sha256: file.sha256 }, detail: `unsupported import syntax: ${raw}` });
        unknown++;
      }
      for (const raw of imports) {
        const resolved = importTarget(file.path, raw, file.language, present);
        const target = resolved.target ? `module:${resolved.target}` : `unknown:import:${resolved.inferred_path}`;
        if (!resolved.target && !nodes.some(node => node.id === target)) nodes.push({ id: target, kind: 'unknown', name: raw, path: null, line: null });
        const confidence = resolved.target ? 'extracted' : 'unknown';
        edges.push({ from: `module:${file.path}`, to: target, relationship: 'imports', confidence, evidence: { path: file.path, line: index + 1, sha256: file.sha256 }, detail: resolved.inferred_path });
        if (resolved.target) extracted++; else unknown++;
      }
      const declared = definition(code, file.language)?.name;
      for (const match of code.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
        const name = match[1];
        if (name === declared || ['if', 'while', 'for', 'match', 'Some', 'Ok', 'Err', 'require', 'import', 'def', 'class'].includes(name)) continue;
        const options = definitions.get(name) || [];
        const local = options.filter(node => node.path === file.path);
        const target = local.length === 1 ? local[0] : options.length === 1 ? options[0] : null;
        const caller = [...nodes].reverse().find(node => node.path === file.path && node.line !== null && node.line <= index + 1 && (node.kind === 'test' || node.kind === 'symbol')) || nodes.find(node => node.id === `module:${file.path}`)!;
        const to = target?.id || `unknown:${options.length ? 'ambiguous_call' : 'call'}:${name}`;
        if (!target && !nodes.some(node => node.id === to)) nodes.push({ id: to, kind: 'unknown', name, path: null, line: null });
        edges.push({ from: caller.id, to, relationship: caller.kind === 'test' ? 'tests' : 'calls', confidence: target ? 'inferred' : 'unknown', evidence: { path: file.path, line: index + 1, sha256: file.sha256 }, detail: `lexical call ${name}` });
        if (target) inferred++; else unknown++;
      }
    }
    coverage.push({ path: file.path, extracted, inferred, unknown });
  }
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) throw new Error('analysis_graph_limit');
  nodes.sort((a, b) => compare(a.id, b.id));
  edges.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const result: Graph = { schema: 1, generator: GENERATOR, repository_identity: identity, root, revision, candidate_sha256: candidate, source_digest: sourceDigest,
    sources: files.map(({ path, language, sha256, bytes }) => ({ path, language, sha256, bytes })), nodes, edges, coverage, unsupported_languages: unsupported };
  if (bytes(JSON.stringify(result)).length > 16 * 1024 * 1024) throw new Error('analysis_output_limit');
  return result;
}

async function buildEvidence(api: ModAPI, input: Json): Promise<{ graph: Graph; files: Source[] }> {
  const { identity, revision, root } = common(input);
  const value = record(input);
  const read = await sources(api, root);
  const sourceDigest = await digest(JSON.stringify(read.files.map(file => [file.path, file.sha256])));
  if (value.expected_source_digest !== undefined && value.expected_source_digest !== sourceDigest) throw new Error('analysis_source_digest_stale');
  return { graph: graph(identity, revision, root, read.candidate, read.files, read.unsupported, sourceDigest), files: read.files };
}

async function build(api: ModAPI, input: Json): Promise<Graph> {
  return (await buildEvidence(api, input)).graph;
}

function constraints(input: Json, identity: string): Constraints {
  const value = record(input);
  const approval = record(value.approval);
  const duplication = value.duplication_scopes === undefined ? [] : value.duplication_scopes;
  const verification = value.verification === undefined ? [] : value.verification;
  if (value.schema !== 1 || value.repository_identity !== identity || !Array.isArray(value.dependency_boundaries) || !Array.isArray(value.repair_scope)
    || !Array.isArray(duplication) || !Array.isArray(verification) || duplication.length > 32 || verification.length > 32
    || !Number.isInteger(value.max_findings) || Number(value.max_findings) < 1 || Number(value.max_findings) > 64
    || value.dependency_boundaries.length > 32 || value.repair_scope.length > 32
    || !value.approval || typeof approval.actor !== 'string' || !approval.actor.trim() || approval.actor.length > 128
    || typeof approval.reason !== 'string' || !approval.reason.trim() || approval.reason.length > 512
    || Object.keys(approval).some(key => !['actor', 'reason'].includes(key))
    || typeof value.version !== 'string' || !value.version.trim() || value.version.length > 128
    || Object.keys(value).some(key => !['schema', 'version', 'repository_identity', 'approval', 'dependency_boundaries', 'duplication_scopes', 'verification', 'repair_scope', 'max_findings'].includes(key))) throw new Error('analysis_constraints_invalid');
  const rules: Boundary[] = [];
  const ids = new Set<string>();
  for (const item of value.dependency_boundaries) {
    const rule = record(item);
    if (typeof rule.id !== 'string' || !IDENTIFIER.test(rule.id) || ids.has(rule.id) || !pathValid(rule.from_prefix) || !pathValid(rule.denied_to_prefix)
      || Object.keys(rule).some(key => !['id', 'from_prefix', 'denied_to_prefix'].includes(key))) throw new Error('analysis_boundary_invalid');
    ids.add(rule.id);
    rules.push({ id: rule.id, from_prefix: rule.from_prefix, denied_to_prefix: rule.denied_to_prefix });
  }
  const duplicates: Duplicate[] = [];
  for (const item of duplication) {
    const rule = record(item);
    if (typeof rule.id !== 'string' || !IDENTIFIER.test(rule.id) || ids.has(rule.id) || !Array.isArray(rule.path_prefixes)
      || rule.path_prefixes.length < 1 || rule.path_prefixes.length > 32 || !rule.path_prefixes.every(path => pathValid(path))
      || new Set(rule.path_prefixes).size !== rule.path_prefixes.length || !Number.isInteger(rule.minimum_logical_lines)
      || Number(rule.minimum_logical_lines) < 2 || Number(rule.minimum_logical_lines) > 200
      || Object.keys(rule).some(key => !['id', 'path_prefixes', 'minimum_logical_lines'].includes(key))) throw new Error('analysis_duplication_invalid');
    ids.add(rule.id);
    duplicates.push({ id: rule.id, path_prefixes: [...rule.path_prefixes as string[]].sort(compare), minimum_logical_lines: Number(rule.minimum_logical_lines) });
  }
  const checks: Verification[] = [];
  for (const item of verification) {
    const rule = record(item);
    if (typeof rule.id !== 'string' || !IDENTIFIER.test(rule.id) || ids.has(rule.id) || !pathValid(rule.test_path_prefix)
      || !Number.isInteger(rule.minimum_tests) || Number(rule.minimum_tests) < 0 || Number(rule.minimum_tests) > 10000
      || !Number.isInteger(rule.minimum_assertions_per_test) || Number(rule.minimum_assertions_per_test) < 0 || Number(rule.minimum_assertions_per_test) > 64
      || Object.keys(rule).some(key => !['id', 'test_path_prefix', 'minimum_tests', 'minimum_assertions_per_test'].includes(key))) throw new Error('analysis_verification_invalid');
    ids.add(rule.id);
    checks.push({ id: rule.id, test_path_prefix: rule.test_path_prefix as string, minimum_tests: Number(rule.minimum_tests), minimum_assertions_per_test: Number(rule.minimum_assertions_per_test) });
  }
  if (!value.repair_scope.every(item => pathValid(item))) throw new Error('analysis_repair_scope_invalid');
  return { schema: 1, version: value.version, repository_identity: identity, approval: { actor: approval.actor as string, reason: approval.reason as string },
    dependency_boundaries: rules.sort((a, b) => compare(a.id, b.id)), duplication_scopes: duplicates.sort((a, b) => compare(a.id, b.id)),
    verification: checks.sort((a, b) => compare(a.id, b.id)), repair_scope: [...new Set(value.repair_scope as string[])].sort(compare), max_findings: Number(value.max_findings) };
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

async function bodySignatures(value: Graph, files: Source[]): Promise<Body[]> {
  const bodies: Body[] = [];
  for (const file of files) {
    const raw = file.text.split(/\r?\n/);
    const code = codeLines(file);
    const nodes = value.nodes.filter(node => node.path === file.path && node.line !== null && (node.kind === 'symbol' || node.kind === 'test'))
      .sort((a, b) => a.line! - b.line!);
    const ordinals = new Map<string, number>();
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      const start = node.line! - 1;
      if (definition(code[start] || '', file.language)?.kind !== 'function') continue;
      const end = nodes[index + 1]?.line ? nodes[index + 1].line! - 1 : raw.length;
      const body = code.slice(start, end).join('\n');
      const normalized = code.slice(start, end).map(line => line.trim().replace(/\s+/g, ' ')).filter(line => line && !['{', '}', '};'].includes(line)).join('\n').replace(node.name, '<symbol>');
      const ordinal = ordinals.get(node.name) || 0;
      ordinals.set(node.name, ordinal + 1);
      let first = start;
      while (first > 0 && start - first < 4) {
        const previous = raw[first - 1].trim();
        if (previous === '' || previous.startsWith('#') || previous.startsWith('@')) first--;
        else break;
      }
      const context = raw.slice(first, end).join('\n').toLowerCase();
      const markers = ['assert!', 'assert_eq!', 'assert_ne!', 'assert ', 'pytest.raises', 'expect(', 'assert(', 'assert.', 'assertEquals(', 'assertTrue(', 'assertFalse(', 'assertThrows('];
      const assertions = markers.reduce((count, marker) => count + body.split(marker).length - 1, 0);
      bodies.push({ key: `${file.path}:${node.name}:${ordinal}`, path: file.path, name: node.name, test: node.kind === 'test',
        logical_lines: normalized ? normalized.split('\n').length : 0, normalized_sha256: await digest(normalized), assertions,
        skipped: ['#[ignore]', '@disabled', '.skip(', 'test.skip', 'pytest.mark.skip', '@unittest.skip'].some(marker => context.includes(marker.toLowerCase())),
        evidence: { path: file.path, line: node.line!, sha256: file.sha256 } });
    }
  }
  return bodies.sort((a, b) => compare(a.key, b.key));
}

async function observations(value: Graph, rules: Constraints, bodies: Body[], baselineChecks: CheckSignature[] = []): Promise<Observation[]> {
  const nodes = new Map(value.nodes.map(node => [node.id, node]));
  const found: Observation[] = [];
  const seen = new Set<string>();
  const add = async (kind: Observation['kind'], rule: string, certainty: Observation['certainty'], subject: string, evidence: Anchor | null, detail: string, related_evidence?: Anchor[]) => {
    const fingerprint = await digest(JSON.stringify([kind, rule, subject]));
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    found.push({ fingerprint, kind, constraint_id: rule, certainty, subject, evidence, detail, ...(related_evidence ? { related_evidence } : {}) });
    if (found.length > rules.max_findings) throw new Error('analysis_findings_limit');
  };
  for (const rule of rules.dependency_boundaries) {
    for (const edge of value.edges) {
      if (edge.relationship !== 'imports' || !under(edge.evidence.path, rule.from_prefix)) continue;
      const target = nodes.get(edge.to)?.path;
      const uncertain = edge.confidence === 'unknown' && under(edge.detail, rule.denied_to_prefix);
      if (!target && !uncertain) continue;
      if (target && !under(target, rule.denied_to_prefix)) continue;
      const subject = `${edge.evidence.path}->${target || `unresolved:${edge.detail}`}`;
      await add('dependency_boundary', rule.id, target ? 'deterministic' : 'uncertain', subject, edge.evidence,
        target ? `${edge.evidence.path} imports denied boundary ${target}` : `${edge.evidence.path} may import denied boundary ${rule.denied_to_prefix}`);
    }
  }
  for (const rule of rules.duplication_scopes) {
    const groups = new Map<string, Body[]>();
    for (const body of bodies) {
      if (body.test || body.logical_lines < rule.minimum_logical_lines || !rule.path_prefixes.some(prefix => under(body.path, prefix))) continue;
      groups.set(body.normalized_sha256, [...(groups.get(body.normalized_sha256) || []), body]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => compare(a.key, b.key));
      for (const duplicate of group.slice(1)) {
        await add('duplicated_domain_logic', rule.id, 'inferred', `${group[0].key}==${duplicate.key}`, duplicate.evidence,
          `${group[0].key} and ${duplicate.key} contain the same normalized logic`, [group[0].evidence]);
      }
    }
  }
  const checks = bodies.filter(body => body.test);
  for (const rule of rules.verification) {
    const selected = checks.filter(check => under(check.path, rule.test_path_prefix));
    if (selected.length < rule.minimum_tests) {
      await add('weakened_check', rule.id, 'inferred', `${rule.test_path_prefix}:minimum-tests`, selected[0]?.evidence || null,
        `${rule.test_path_prefix} contains ${selected.length} extracted tests; approved minimum is ${rule.minimum_tests}`);
    }
    for (const check of selected) {
      if (check.assertions < rule.minimum_assertions_per_test) await add('weakened_check', rule.id, 'inferred', `${check.key}:minimum-assertions`, check.evidence,
        `${check.key} has ${check.assertions} assertion markers; approved minimum is ${rule.minimum_assertions_per_test}`);
      if (check.skipped) await add('weakened_check', rule.id, 'inferred', `${check.key}:skipped`, check.evidence, `${check.key} is marked skipped or ignored`);
    }
    const current = new Map(selected.map(check => [check.key, check]));
    for (const before of baselineChecks.filter(check => under(check.path, rule.test_path_prefix))) {
      const after = current.get(before.key);
      if (!after) await add('weakened_check', rule.id, 'inferred', `${before.key}:removed`, before.evidence, `${before.key} was removed after the baseline`);
      else {
        if (after.assertions < before.assertions) await add('weakened_check', rule.id, 'inferred', `${before.key}:assertions-reduced`, after.evidence,
          `${before.key} assertion markers decreased from ${before.assertions} to ${after.assertions}`);
        if (!before.skipped && after.skipped) await add('weakened_check', rule.id, 'inferred', `${before.key}:newly-skipped`, after.evidence,
          `${before.key} became skipped or ignored after the baseline`);
      }
    }
  }
  return found.sort((a, b) => compare(a.fingerprint, b.fingerprint));
}

async function baselineKey(identity: string, root: string): Promise<string> {
  return `analysis.baseline.${await digest(JSON.stringify([GENERATOR, identity, root]))}`;
}

async function baseline(api: ModAPI, input: Json): Promise<Json> {
  const { identity, revision, root } = common(input);
  const approved = constraints(record(input).constraints, identity);
  const key = await baselineKey(identity, root);
  if (api.host.call('store.get', { key, scope: 'repository' })) throw new Error('analysis_baseline_exists');
  const { graph: current, files } = await buildEvidence(api, input);
  if (!current.sources.length) throw new Error('analysis_no_sources');
  const bodies = await bodySignatures(current, files);
  const body = { schema: 1 as const, generator: GENERATOR, repository_identity: identity, root, revision,
    source_digest: current.source_digest, constraints_sha256: await hashJson(approved as unknown as Json), observations: await observations(current, approved, bodies),
    checks: bodies.filter(item => item.test).map(({ key, path, name, assertions, skipped, evidence }) => ({ key, path, name, assertions, skipped, evidence })) };
  const saved: Baseline = { ...body, integrity_sha256: await hashJson(body as unknown as Json) };
  api.host.call('workspace.fingerprint', { expected: current.candidate_sha256 });
  api.host.call('store.put', { key, scope: 'repository', expected_revision: null, value: saved as unknown as Json });
  return { baseline: saved, candidate_sha256: current.candidate_sha256, unsupported_languages: current.unsupported_languages } as Json;
}

async function check(api: ModAPI, input: Json): Promise<Json> {
  const { identity, revision, root } = common(input);
  const approved = constraints(record(input).constraints, identity);
  const key = await baselineKey(identity, root);
  const entry = api.host.call('store.get', { key, scope: 'repository' });
  if (!entry) throw new Error('analysis_baseline_missing');
  const saved = entry.value as unknown as Baseline;
  if (!saved || saved.schema !== 1 || saved.generator !== GENERATOR || saved.repository_identity !== identity || saved.root !== root
    || !SHA.test(saved.source_digest) || !SHA.test(saved.constraints_sha256) || !Array.isArray(saved.observations) || saved.observations.length > 64
    || saved.observations.some(item => !item || !SHA.test(item.fingerprint) || !['dependency_boundary', 'duplicated_domain_logic', 'weakened_check'].includes(item.kind)
      || !['deterministic', 'inferred', 'uncertain'].includes(item.certainty) || typeof item.subject !== 'string' || typeof item.detail !== 'string'
      || (item.evidence !== null && (!item.evidence || !pathValid(item.evidence.path) || !Number.isSafeInteger(item.evidence.line) || item.evidence.line < 1 || !SHA.test(item.evidence.sha256))))
    || !Array.isArray(saved.checks) || saved.checks.length > MAX_NODES
    || saved.checks.some(item => !item || typeof item.key !== 'string' || !pathValid(item.path) || typeof item.name !== 'string'
      || !Number.isSafeInteger(item.assertions) || item.assertions < 0 || typeof item.skipped !== 'boolean' || !item.evidence
      || item.evidence.path !== item.path || !Number.isSafeInteger(item.evidence.line) || item.evidence.line < 1 || !SHA.test(item.evidence.sha256))
    ) throw new Error('analysis_baseline_invalid');
  const baselineBody = { schema: saved.schema, generator: saved.generator, repository_identity: saved.repository_identity,
    root: saved.root, revision: saved.revision, source_digest: saved.source_digest, constraints_sha256: saved.constraints_sha256,
    observations: saved.observations, checks: saved.checks };
  if (saved.integrity_sha256 !== await hashJson(baselineBody as unknown as Json)
    && saved.integrity_sha256 !== await digest(JSON.stringify(baselineBody))) throw new Error('analysis_baseline_invalid');
  if (saved.constraints_sha256 !== await hashJson(approved as unknown as Json)
    && saved.constraints_sha256 !== await digest(JSON.stringify(approved))) throw new Error('analysis_constraints_stale');
  const { graph: current, files } = await buildEvidence(api, input);
  if (!current.sources.length) throw new Error('analysis_no_sources');
  const bodies = await bodySignatures(current, files);
  const prior = new Set(saved.observations.map(item => item.fingerprint));
  const results = await observations(current, approved, bodies, saved.checks);
  api.host.call('workspace.fingerprint', { expected: current.candidate_sha256 });
  const findings = results.map(item => ({ ...item, origin: prior.has(item.fingerprint) ? 'existing_debt' : 'introduced',
    repair: item.evidence && approved.repair_scope.some(prefix => under(item.evidence!.path, prefix)) ? 'authorized_scope_metadata' : 'requires_authorization' }));
  return { schema: 1, generator: GENERATOR, repository_identity: identity, baseline_revision: saved.revision, baseline_source_digest: saved.source_digest,
    current_revision: revision, current_source_digest: current.source_digest, candidate_sha256: current.candidate_sha256,
    constraints_sha256: saved.constraints_sha256, introduced_findings: findings.filter(item => item.origin === 'introduced' && item.certainty !== 'uncertain'),
    existing_debt: findings.filter(item => item.origin === 'existing_debt' && item.certainty !== 'uncertain'),
    uncertain_findings: findings.filter(item => item.certainty === 'uncertain'), unsupported_languages: current.unsupported_languages } as Json;
}

function expectedDigest(input: Json): void {
  if (!SHA.test(record(input).expected_source_digest as string)) throw new Error('analysis_expected_digest_required');
}

async function select(api: ModAPI, input: Json): Promise<Json> {
  expectedDigest(input);
  const requested = record(input).node_ids;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 16 || requested.some(id => typeof id !== 'string' || id.length > 256)) throw new Error('analysis_selection_invalid');
  const current = await build(api, input);
  const ids = new Set(requested as string[]);
  if (ids.size !== requested.length || current.nodes.filter(node => ids.has(node.id)).length !== ids.size) throw new Error('analysis_selection_unknown');
  const relationships = current.edges.filter(edge => ids.has(edge.from) || ids.has(edge.to));
  const related = new Set([...ids, ...relationships.flatMap(edge => [edge.from, edge.to])]);
  const nodes = current.nodes.filter(node => related.has(node.id));
  const paths = new Set([...nodes.map(node => node.path), ...relationships.map(edge => edge.evidence.path)]);
  const packet = { schema: 1, graph_generator: GENERATOR, repository_identity: current.repository_identity, revision: current.revision,
    source_digest: current.source_digest, candidate_sha256: current.candidate_sha256, nodes, relationships,
    coverage: current.coverage.filter(item => paths.has(item.path)), guidance: 'Verify inferred and unknown relationships against source before relying on them.' };
  if (bytes(JSON.stringify(packet)).length > 32 * 1024) throw new Error('analysis_selection_limit');
  api.host.call('workspace.fingerprint', { expected: current.candidate_sha256 });
  return packet as Json;
}

function serviceInput(input: Json): { value: Record<string, Json>; identity: string; revision: string; root: string } {
  const value = record(input);
  const normalized: Record<string, Json> = { ...value, repository_identity: value.repository_identity ?? 'workspace', revision: value.revision ?? 'live-source' };
  return { value: normalized, ...common(normalized) };
}

async function serviceGraph(api: ModAPI, input: Json): Promise<{ current: Graph; value: Record<string, Json> }> {
  const { value, identity, revision, root } = serviceInput(input);
  const read = await liveSources(api, root);
  if (value.expected_source_digest !== undefined && (!SHA.test(value.expected_source_digest as string)
    || value.expected_source_digest !== read.source_digest)) throw new Error('analysis_source_digest_stale');
  return { current: graph(identity, revision, root, '', read.files, [], read.source_digest), value };
}

const SERVICE_PROVENANCE = { workspace_snapshot: false, validation: 'double_list_and_hash' };

async function serviceSearch(api: ModAPI, input: Json): Promise<Json> {
  const { current, value } = await serviceGraph(api, input);
  const query = value.query === undefined ? '' : value.query;
  const requestedPage = value.page === undefined ? 0 : value.page;
  if (typeof query !== 'string' || query.length > 100 || !Number.isSafeInteger(requestedPage) || (requestedPage as number) < 0
    || (requestedPage as number) > 10_000) throw new Error('analysis_search_invalid');
  const lowered = query.toLocaleLowerCase();
  const visible = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, limit);
  const matched = current.nodes.filter(node => !lowered || `${node.name} ${node.id} ${node.kind} ${node.path || ''}`.toLocaleLowerCase().includes(lowered));
  const page = Math.min(requestedPage as number, Math.max(0, Math.ceil(matched.length / PAGE_SIZE) - 1));
  const chosen = matched.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (chosen.some(node => node.id.length > 768)) throw new Error('analysis_service_node_id_limit');
  const counts = new Map(chosen.map(node => [node.id, [0, 0, 0]]));
  for (const edge of current.edges) for (const id of [edge.from, edge.to]) {
    const count = counts.get(id);
    if (count) count[edge.confidence === 'extracted' ? 0 : edge.confidence === 'inferred' ? 1 : 2]++;
  }
  const rows = chosen.map(node => {
    const [extracted, inferred, unknown] = counts.get(node.id)!;
    return { id: node.id, label: visible(node.name, 96), detail: visible(`${node.kind} · ${node.path ? `${node.path}:${node.line}` : 'unresolved source'} · ${extracted} extracted / ${inferred} inferred / ${unknown} unknown`, 180) };
  });
  const result = { schema: 1, generator: GENERATOR, repository_identity: current.repository_identity, revision: current.revision,
    source_digest: current.source_digest, provenance: SERVICE_PROVENANCE, count: matched.length, page, page_size: PAGE_SIZE, rows };
  if (bytes(JSON.stringify(result)).length > 32 * 1024) throw new Error('analysis_service_limit');
  return result as Json;
}

async function serviceSelect(api: ModAPI, input: Json): Promise<Json> {
  expectedDigest(input);
  const { current, value } = await serviceGraph(api, input);
  const id = value.node_id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 768) throw new Error('analysis_selection_invalid');
  if (!current.nodes.some(node => node.id === id)) throw new Error('analysis_selection_unknown');
  const relationships = current.edges.filter(edge => edge.from === id || edge.to === id);
  const related = new Set([id, ...relationships.flatMap(edge => [edge.from, edge.to])]);
  const nodes = current.nodes.filter(node => related.has(node.id));
  const paths = new Set([...nodes.map(node => node.path), ...relationships.map(edge => edge.evidence.path)]);
  const packet = { schema: 1, graph_generator: GENERATOR, repository_identity: current.repository_identity, revision: current.revision,
    source_digest: current.source_digest, provenance: SERVICE_PROVENANCE, nodes, relationships,
    coverage: current.coverage.filter(item => paths.has(item.path)), guidance: 'Verify inferred and unknown relationships against source before relying on them.' };
  if (bytes(JSON.stringify(packet)).length > 32 * 1024) throw new Error('analysis_selection_limit');
  return packet as Json;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function html(api: ModAPI, input: Json): Promise<Json> {
  expectedDigest(input);
  const current = await build(api, input);
  const sourceHref = (path: string, line: number) => `${path.split('/').map(encodeURIComponent).join('/')}#L${line}`;
  const rows = current.edges.map((edge, index) => `<tr id="source-${index}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-confidence="${edge.confidence}"><td><button type="button" class="node" data-node="${escapeHtml(edge.from)}">${escapeHtml(edge.from)}</button></td><td>${escapeHtml(edge.relationship)}</td><td><button type="button" class="node" data-node="${escapeHtml(edge.to)}">${escapeHtml(edge.to)}</button></td><td>${escapeHtml(edge.confidence)}</td><td><a href="#source-${index}" data-path="${escapeHtml(edge.evidence.path)}" data-line="${edge.evidence.line}" data-sha256="${edge.evidence.sha256}">${escapeHtml(edge.evidence.path)}:${edge.evidence.line}</a> <a href="${escapeHtml(sourceHref(edge.evidence.path, edge.evidence.line))}">Open source</a></td></tr>`).join('');
  const nodeOptions = current.nodes.map(node => `<option value="${escapeHtml(node.id)}">${escapeHtml(`${node.name} · ${node.kind} · ${node.path ?? 'unresolved'}`)}</option>`).join('');
  const behavior = String.raw`(() => {
    const doc = self.document;
    const rows = Array.from(doc.querySelectorAll('tbody tr'));
    const search = doc.getElementById('search');
    const confidence = doc.getElementById('confidence');
    const nodePicker = doc.getElementById('node');
    const count = doc.getElementById('count');
    const focusLabel = doc.getElementById('focus');
    const related = doc.getElementById('related');
    const diagram = doc.getElementById('diagram');
    const copy = doc.getElementById('copy');
    const evidence = doc.getElementById('evidence');
    let focus = '';
    function update() {
      const query = search.value.toLowerCase();
      const selectedConfidence = confidence.value;
      let visible = 0;
      const neighbors = [];
      for (const row of rows) {
        const matched = (!query || row.textContent.toLowerCase().includes(query))
          && (!selectedConfidence || row.dataset.confidence === selectedConfidence)
          && (!focus || row.dataset.from === focus || row.dataset.to === focus);
        row.hidden = !matched;
        if (matched) visible++;
        if (focus && (row.dataset.from === focus || row.dataset.to === focus))
          neighbors.push(row.dataset.from + ' → ' + row.dataset.to + ' (' + row.dataset.confidence + ')');
      }
      count.textContent = visible + ' of ' + rows.length + ' relationships';
      focusLabel.textContent = focus ? 'Neighborhood: ' + focus : 'Select a node to inspect its neighborhood';
      related.replaceChildren();
      for (const label of neighbors.slice(0, 32)) {
        const item = doc.createElement('li');
        item.textContent = label;
        related.append(item);
      }
      diagram.replaceChildren();
      if (focus) {
        const svg = 'http://www.w3.org/2000/svg';
        const add = (kind, attributes, label) => {
          const item = doc.createElementNS(svg, kind);
          for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, String(value));
          if (label) item.textContent = label;
          diagram.append(item);
        };
        add('text', { x: 10, y: 22, fill: '#8de3c2' }, focus.slice(0, 72));
        for (const [index, label] of neighbors.slice(0, 8).entries()) {
          const y = 49 + index * 28;
          add('line', { x1: 16, y1: 25, x2: 34, y2: y - 4, stroke: '#657381' });
          add('text', { x: 42, y, fill: '#e8edf2' }, label.slice(0, 78));
        }
      }
      copy.disabled = !focus;
    }
    doc.addEventListener('click', event => {
      const node = event.target.closest('button[data-node]');
      if (node) { focus = node.dataset.node; update(); }
    });
    doc.getElementById('clear').addEventListener('click', () => { focus = ''; update(); });
    nodePicker.addEventListener('change', () => { focus = nodePicker.value; update(); });
    copy.addEventListener('click', () => {
      const lines = rows.filter(row => row.dataset.from === focus || row.dataset.to === focus)
        .slice(0, 32).map(row => row.textContent.trim().replace(/\s+/g, ' '));
      evidence.value = 'Source digest: ' + doc.body.dataset.sourceDigest + '\n' + lines.join('\n');
      evidence.hidden = false;
      evidence.select();
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(evidence.value).catch(() => {});
    });
    search.addEventListener('input', update);
    confidence.addEventListener('change', update);
    update();
  })();`;
  const document = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oh My Diff repository graph</title><style>body{font:14px system-ui;margin:2rem;max-width:90rem;background:#101318;color:#e8edf2}a{color:#8de3c2}button,input,select,textarea{font:inherit}button,input,select{padding:.4rem}button{cursor:pointer}label{display:inline-flex;gap:.35rem;align-items:center;margin:.3rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #657381;padding:.35rem;text-align:left;overflow-wrap:anywhere}tr:nth-child(even){background:#1b242d}tr[hidden]{display:none}.node{border:0;background:none;color:#8de3c2;text-align:left}textarea{width:100%;min-height:6rem}#related{max-height:12rem;overflow:auto}#diagram{width:100%;height:280px;border:1px solid #657381}@media(max-width:760px){body{margin:.6rem}table{font-size:12px}}</style><body data-source-digest="${current.source_digest}"><h1>Repository graph</h1><p>Source digest: <code>${current.source_digest}</code>; revision: ${escapeHtml(current.revision)}. Extracted imports are source-linked; inferred calls and unknown targets require verification.</p><label>Search <input id="search" type="search"></label><label>Confidence <select id="confidence"><option value="">All</option><option>extracted</option><option>inferred</option><option>unknown</option></select></label><label>Node <select id="node"><option value="">Select a node</option>${nodeOptions}</select></label><button id="clear" type="button">Clear node</button><p id="count"></p><h2 id="focus"></h2><svg id="diagram" viewBox="0 0 640 280" role="img" aria-label="Selected node neighborhood"></svg><ol id="related"></ol><button id="copy" type="button">Copy neighborhood evidence</button><textarea id="evidence" aria-label="Copyable neighborhood evidence" hidden readonly></textarea><table><thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Confidence</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table><script>${behavior}</script></body></html>`;
  if (bytes(document).length > ((api as ModAPI & { artifact_output?: boolean }).artifact_output ? 16 * 1024 * 1024 : 64 * 1024)) throw new Error('analysis_html_limit');
  api.host.call('workspace.fingerprint', { expected: current.candidate_sha256 });
  return { html: document, source_digest: current.source_digest, candidate_sha256: current.candidate_sha256 } as Json;
}


function runAnalysis(api: ModAPI, request: { tool: string; input: Json; candidate: string; raw_html?: boolean }, options: { max_output_bytes: number; output_artifact?: boolean }): ExecResult {
  const source = api.assets.read('index.ts');
  const bootstrap = api.assets.read('analysis_cli.mjs');
  if (!SHA.test(source.sha256) || bytes(source.text).length > 64 * 1024 || !SHA.test(bootstrap.sha256) || bytes(bootstrap.text).length > 8 * 1024) throw new Error('analysis_package_source_invalid');
  const node = api.host.call('process.which', { names: ['node'] }).found.find(item => item.name === 'node');
  if (!node) throw new Error('analysis_node_unavailable');
  const result = api.host.call('exec.run', { program: node.path, sha256: node.sha256,
    argv: ['--no-warnings', '--input-type=module', '--eval', bootstrap.text, JSON.stringify(request)],
    stdin: source.text, timeout_ms: 120_000, ...options });
  if (result.exit_code !== 0 || result.timed_out || result.stdout_truncated || result.stderr_truncated || options.output_artifact && !result.output_artifact)
    throw new Error(`analysis_process_failed: ${result.stderr.slice(-800)}`);
  api.host.call('workspace.fingerprint', { expected: request.candidate });
  return result;
}

async function artifactReport(api: ModAPI, input: Json, kind: 'graph' | 'html'): Promise<Json> {
  common(input);
  if (kind === 'html') expectedDigest(input);
  const candidate = api.host.call('workspace.fingerprint', {}).candidate_sha256;
  const result = runAnalysis(api, { tool: kind, input, candidate, raw_html: kind === 'html' },
    { max_output_bytes: 16 * 1024 * 1024, output_artifact: true });
  const found = kind === 'graph' ? result.stdout.match(/"source_digest":"([0-9a-f]{64})"/) : null;
  if (kind === 'graph' && !found) throw new Error('analysis_artifact_digest_missing');
  return { artifact: result.output_artifact, bytes: result.stdout_bytes, sha256: result.stdout_sha256,
    source_digest: kind === 'graph' ? found![1] : record(input).expected_source_digest, candidate_sha256: candidate } as Json;
}

async function largeSelect(api: ModAPI, input: Json): Promise<Json> {
  common(input);
  expectedDigest(input);
  const candidate = api.host.call('workspace.fingerprint', {}).candidate_sha256;
  return JSON.parse(runAnalysis(api, { tool: 'select', input, candidate }, { max_output_bytes: 32 * 1024 }).stdout) as Json;
}

export default function activate(api: ModAPI) {
  // Expected refusals return as values; a non-Error throw is the host suspending the callback.
  const refuse = <T>(run: () => T | Promise<T>, value: (reason: string) => T): T | Promise<T> => {
    const refused = (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return value(error.message);
    };
    try {
      const result = run();
      return result instanceof Promise ? result.catch(refused) : result;
    } catch (error) {
      return refused(error);
    }
  };
  const tool: ModAPI['tool'] = (spec, handler) => api.tool(spec, input => refuse(() => handler(input), reason => ({ status: 'refused', reason })));
  api.provide(SERVICE, { search: input => serviceSearch(api, input), select: input => serviceSelect(api, input) });
  const parameters = { type: 'object' as const, properties: { repository_identity: { type: 'string' }, revision: { type: 'string' }, root: { type: 'string' },
    constraints: { type: 'object' }, expected_source_digest: { type: 'string' }, node_ids: { type: 'array', items: { type: 'string' } } }, required: ['repository_identity', 'revision'], additionalProperties: false };
  tool({ name: 'graph', description: 'Build a bounded five-language source graph with extracted, inferred, and unknown relationships.', parameters }, async input => {
    const result = await build(api, input);
    api.host.call('workspace.fingerprint', { expected: result.candidate_sha256 });
    return result as Json;
  });
  tool({ name: 'graph_artifact', description: 'Build a large source graph with a hash-bound paged output artifact.', parameters }, input => artifactReport(api, input, 'graph'));
  tool({ name: 'html_artifact', description: 'Render a standalone interactive HTML artifact from the current source.', parameters }, input => artifactReport(api, input, 'html'));
  tool({ name: 'select_large', description: 'Select checked source evidence from a large current graph.', parameters }, input => largeSelect(api, input));
  tool({ name: 'baseline', description: 'Record an immutable approved repository-health baseline for the current source.', parameters }, input => baseline(api, input));
  tool({ name: 'check', description: 'Compare current boundary, duplication, and verification observations with an approved baseline.', parameters }, input => check(api, input));
  tool({ name: 'select', description: 'Return bounded source-bound graph evidence for selected nodes.', parameters }, input => select(api, input));
  tool({ name: 'html', description: 'Render a bounded static HTML view of the current source graph.', parameters }, input => html(api, input));
}
