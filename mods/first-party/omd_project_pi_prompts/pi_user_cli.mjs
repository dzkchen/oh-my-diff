import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const request = JSON.parse(process.argv[1]);
const requestedRoot = request.user_agent_dir;
if (typeof requestedRoot !== 'string' || !requestedRoot.startsWith('/') || requestedRoot.length > 4096 || resolve(requestedRoot) !== requestedRoot) throw Error('pi_user_root_invalid');
const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
if (root !== requestedRoot) throw Error('pi_user_root_symlink');
const sha = value => createHash('sha256').update(value).digest('hex');
function pathFor(name) {
  if (typeof name !== 'string' || !name.startsWith('.pi/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw Error('pi_user_path_invalid');
  const path = resolve(root, name.slice(4));
  if (!path.startsWith(root + sep)) throw Error('pi_user_path_invalid');
  let current = root;
  for (const part of name.slice(4).split('/').slice(0, -1)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('pi_user_symlink_denied');
  }
  return path;
}
function stat(name, hash = false) {
  const path = pathFor(name);
  let value;
  try { value = lstatSync(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const kind = value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'dir' : value.isFile() ? 'file' : 'other';
  if (kind === 'other') return null;
  const result = { kind, size: value.size, mtime_ms: value.mtimeMs };
  if (kind === 'file' && hash) result.sha256 = sha(readFileSync(path));
  return result;
}
function listing(name, recursive, limit) {
  const start = pathFor(name);
  const target = stat(name);
  if (target === null) return { entries: [], truncated: false };
  if (target.kind !== 'dir') throw Error('pi_user_directory_invalid');
  const entries = [];
  function walk(path, prefix) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = `${prefix}/${item.name}`;
      const value = stat(child);
      if (value) entries.push({ path: child, ...value });
      if (entries.length > limit) return;
      if (recursive && value?.kind === 'dir') walk(join(path, item.name), child);
      if (entries.length > limit) return;
    }
  }
  walk(start, name);
  return { entries: entries.slice(0, limit), truncated: entries.length > limit };
}
function candidate() {
  const entries = [];
  for (const name of ['.pi/prompts', '.pi/skills']) {
    const result = listing(name, true, 1100);
    if (result.truncated) throw Error('pi_user_discovery_limit');
    entries.push(...result.entries.map(({ path, kind, size, mtime_ms }) => [path, kind, size, mtime_ms]));
  }
  return sha(JSON.stringify(entries));
}
const initial = candidate();
const handlers = new Map();
const api = {
  settings: {},
  tool(spec, handler) { handlers.set(spec.name, handler); },
  command() {},
  host: { call(operation, input) {
    if (operation === 'workspace.snapshot') {
      const current = candidate();
      if (current !== initial || input?.expected && input.expected !== initial) throw Error('pi_user_source_stale');
      return { candidate_sha256: initial, snapshot: null };
    }
    if (operation === 'workspace.list') return listing(input.path, input.recursive === true, input.max_entries || 1024);
    if (operation === 'workspace.stat') return { files: Object.fromEntries(input.paths.map(name => [name, stat(name, input.hash === true)])) };
    if (operation === 'workspace.read') return { files: Object.fromEntries(input.paths.map(name => {
      const path = pathFor(name);
      const value = stat(name);
      if (!value || value.kind !== 'file' || value.size > 65_536) return [name, null];
      const raw = readFileSync(path);
      return [name, { text: raw.toString('utf8'), sha256: sha(raw) }];
    })) };
    throw Error('pi_user_operation_unsupported');
  } },
};
try {
  if (!existsSync(root)) {
    process.stdout.write(JSON.stringify(request.tool === 'discover' ? { resources: [], diagnostics: [], user_source_digest: initial }
      : { error: 'pi_prompt_not_found', user_source_digest: initial }));
  } else {
    const source = readFileSync(0, 'utf8');
    const module = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
    module.default(api);
    const handler = handlers.get(request.tool);
    if (!handler) throw Error('pi_user_tool_invalid');
    const value = await handler(request.input || {});
    if (candidate() !== initial) throw Error('pi_user_source_stale');
    if (request.tool === 'discover') {
      value.resources = value.resources.map(item => ({ ...item, scope: 'user', path: join(root, item.path.slice(4)) }));
      value.diagnostics = value.diagnostics.map(item => item?.path ? { ...item, path: join(root, item.path.slice(4)) } : item);
      delete value.candidate_sha256;
      value.user_source_digest = initial;
    } else {
      value.path = join(root, value.path.slice(4));
      delete value.candidate_sha256;
      value.user_source_digest = initial;
    }
    process.stdout.write(JSON.stringify(value));
  }
} catch (error) {
  process.stderr.write(String(error?.message || error));
  process.exitCode = 1;
}
