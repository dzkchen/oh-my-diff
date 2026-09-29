import type { Json, ModAPI } from '../../api.d.ts';

type Prompt = { kind: 'prompts'; name: string; scope: 'project' | 'user'; path: string; description: string; argument_hint: string | null; sha256: string; content: string };
type Skill = { kind: 'skills'; name: string; scope: 'project' | 'user'; path: string; description: string; sha256: string; content: string };
type Resource = Prompt | Skill;
type UserResult = { resources?: Resource[]; diagnostics?: Json[]; user_source_digest: string; error?: string; name?: string; path?: string; sha256?: string; text?: string };
type Entry = { path: string; kind: 'file' | 'dir' | 'symlink'; size: number };
type Rule = { root: string; matcher: RegExp; directory: boolean; negated: boolean };

const ROOT = '.pi/prompts';
const SKILLS = '.pi/skills';
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 16_384;
const MAX_RESULT_BYTES = 131_072;
const MAX_SKILL_ENTRIES = 1024;
const MAX_DEPTH = 8;
const IGNORE_FILES = ['.gitignore', '.ignore', '.fdignore'];

function utf8(value: string): Uint8Array {
  const encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Uint8Array.from(encoded, character => character.charCodeAt(0));
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', utf8(value) as BufferSource);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function scalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('|') || trimmed.startsWith('>') || trimmed.startsWith('[') || trimmed.startsWith('{')) return null;
  if (/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?|\.inf|\.nan)$/i.test(trimmed)) return null;
  if (trimmed.startsWith('"')) {
    try { const parsed = JSON.parse(trimmed); return typeof parsed === 'string' ? parsed : null; } catch { return null; }
  }
  if (trimmed.startsWith("'")) return trimmed.endsWith("'") ? trimmed.slice(1, -1).replace(/''/g, "'") : null;
  return trimmed.replace(/\s+#.*$/, '');
}

function frontmatter(content: string): { body: string; name: string | null; description: string | null; argument_hint: string | null } {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { body: normalized, name: null, description: null, argument_hint: null };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { body: normalized, name: null, description: null, argument_hint: null };
  const fields = normalized.slice(4, end).split('\n');
  let name: string | null = null;
  let description: string | null = null;
  let argument_hint: string | null = null;
  for (let index = 0; index < fields.length; index++) {
    const line = fields[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-zA-Z][a-zA-Z0-9-]*):\s*(.*)$/.exec(line);
    if (!match) throw new Error('pi_frontmatter_unsupported');
    let value = scalar(match[2]);
    const block = /^([|>])([+-]?)(?:\s+#.*)?$/.exec(match[2]);
    if (block) {
      const lines: string[] = [];
      while (index + 1 < fields.length && (!fields[index + 1].trim() || /^[ \t]/.test(fields[index + 1]))) lines.push(fields[++index]);
      const indent = Math.min(...lines.filter(item => item.trim()).map(item => /^[ \t]*/.exec(item)![0].length));
      if (!Number.isFinite(indent)) value = '';
      else {
        const content = lines.map(item => item.trim() ? item.slice(indent) : '');
        value = block[1] === '|' ? content.join('\n') : content.reduce((result, item, position) => {
          if (!position) return item;
          return result + (item === '' || content[position - 1] === '' ? '\n' : ' ') + item;
        }, '');
        if (block[2] !== '-') value += '\n';
      }
    }
    if (match[1] === 'name') name = value;
    if (match[1] === 'description') description = value;
    if (match[1] === 'argument-hint') argument_hint = value;
  }
  return { body: normalized.slice(end + 4).trim(), name, description, argument_hint };
}

function fallback(body: string): string {
  const line = body.split('\n').find(line => line.trim()) || '';
  const chars = Array.from(line);
  return chars.length > 60 ? chars.slice(0, 60).join('') + '...' : line;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function readFiles(api: ModAPI, paths: string[]): Record<string, { text: string; sha256: string } | null> {
  const files: Record<string, { text: string; sha256: string } | null> = {};
  for (const batch of batches(paths, 64)) Object.assign(files, api.host.call('workspace.read', { paths: batch }).files);
  return files;
}

async function verifyFiles(api: ModAPI, entries: Entry[], files: Record<string, { text: string; sha256: string } | null>): Promise<void> {
  for (const entry of entries) {
    const file = files[entry.path];
    if (!file || !SHA.test(file.sha256) || utf8(file.text).length !== entry.size || await digest(file.text) !== file.sha256) throw new Error('pi_source_stale');
  }
  for (const batch of batches(entries, 64)) {
    const final = api.host.call('workspace.stat', { paths: batch.map(item => item.path), hash: true }).files;
    for (const entry of batch) if (final[entry.path]?.kind !== 'file' || final[entry.path]?.size !== entry.size
      || final[entry.path]?.sha256 !== files[entry.path]?.sha256) throw new Error('pi_source_stale');
  }
}

function ignoreRules(path: string, content: string): Rule[] {
  const root = path.slice(0, path.lastIndexOf('/'));
  const rules: Rule[] = [];
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    if (!line || line.length > 256 || /[\[\]{}\\]/.test(line)) throw new Error('pi_ignore_pattern_unsupported');
    const directory = line.endsWith('/');
    if (directory) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line || line.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('pi_ignore_pattern_unsupported');
    let pattern = '';
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '*' && line[index + 1] === '*') { pattern += '.*'; index++; }
      else if (char === '*') pattern += '[^/]*';
      else if (char === '?') pattern += '[^/]';
      else pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
    const prefix = anchored || line.includes('/') ? '^' : '(^|/)';
    rules.push({ root, matcher: new RegExp(`${prefix}${pattern}$`), directory, negated });
  }
  return rules;
}

function ignored(entry: Entry, rules: Rule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (!entry.path.startsWith(`${rule.root}/`) || rule.directory && entry.kind !== 'dir') continue;
    const relative = entry.path.slice(rule.root.length + 1);
    if (rule.matcher.test(relative)) result = !rule.negated;
  }
  return result;
}

async function discoverSkills(api: ModAPI): Promise<{ resources: Skill[]; diagnostics: Json[] }> {
  const stat = api.host.call('workspace.stat', { paths: [SKILLS] }).files[SKILLS];
  if (stat === null) return { resources: [], diagnostics: [] };
  if (stat?.kind === 'symlink') return { resources: [], diagnostics: [{ path: SKILLS, error: 'pi_symlink_unsupported' }] };
  if (stat?.kind !== 'dir') throw new Error('pi_skill_root_unavailable');
  const listed = api.host.call('workspace.list', { path: SKILLS, recursive: true, include_ignored: true, max_entries: MAX_SKILL_ENTRIES });
  if (listed.truncated || listed.entries.length > MAX_SKILL_ENTRIES) throw new Error('pi_discovery_limit');
  const entries = listed.entries as Entry[];
  const byPath = new Map<string, Entry>();
  const children = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.path.startsWith(`${SKILLS}/`) || entry.path.split('/').some(part => part === '.' || part === '..')) throw new Error('pi_listing_invalid');
    byPath.set(entry.path, entry);
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
    const siblings = children.get(parent) || [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const diagnostics: Json[] = [];
  const ignoreEntries = entries.filter(entry => IGNORE_FILES.includes(entry.path.slice(entry.path.lastIndexOf('/') + 1)) && entry.kind === 'file');
  if (ignoreEntries.length > 32 || ignoreEntries.some(entry => entry.size > 65_536)) throw new Error('pi_discovery_limit');
  const ignoreTexts = readFiles(api, ignoreEntries.map(entry => entry.path));
  const selected: Entry[] = [];
  const walk = (directory: string, depth: number, inherited: Rule[]): void => {
    if (depth > MAX_DEPTH) { diagnostics.push({ path: directory, error: 'pi_depth_limit' }); return; }
    const rules = [...inherited];
    for (const name of IGNORE_FILES) {
      const path = `${directory}/${name}`;
      const entry = byPath.get(path);
      if (entry?.kind === 'symlink') diagnostics.push({ path, error: 'pi_symlink_unsupported' });
      if (entry?.kind === 'file') rules.push(...ignoreRules(path, ignoreTexts[path]?.text || ''));
    }
    const skill = byPath.get(`${directory}/SKILL.md`);
    if (skill?.kind === 'symlink') diagnostics.push({ path: skill.path, error: 'pi_symlink_unsupported' });
    if (skill?.kind === 'file' && !ignored(skill, rules)) { selected.push(skill); return; }
    for (const entry of children.get(directory) || []) {
      const name = entry.path.slice(directory.length + 1);
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (entry.kind === 'symlink') { if (entry.path !== skill?.path) diagnostics.push({ path: entry.path, error: 'pi_symlink_unsupported' }); continue; }
      if (ignored(entry, rules)) continue;
      if (entry.kind === 'dir') walk(entry.path, depth + 1, rules);
      else if (depth === 0 && entry.kind === 'file' && name.endsWith('.md')) selected.push(entry);
    }
  };
  walk(SKILLS, 0, []);
  if (selected.length > MAX_FILES) throw new Error('pi_discovery_limit');
  const resourceEntries = selected.filter(entry => {
    if (entry.size <= MAX_FILE_BYTES) return true;
    diagnostics.push({ path: entry.path, error: 'pi_resource_limit' });
    return false;
  });
  const files = readFiles(api, resourceEntries.map(entry => entry.path));
  await verifyFiles(api, [...ignoreEntries, ...resourceEntries], { ...ignoreTexts, ...files });
  const resources: Skill[] = [];
  const names = new Set<string>();
  for (const entry of resourceEntries) {
    try {
      const parsed = frontmatter(files[entry.path]!.text);
      if (!parsed.description?.trim()) { diagnostics.push({ path: entry.path, error: 'pi_skill_description_required' }); continue; }
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/')).split('/').at(-1)!;
      const name = parsed.name || parent;
      if (!NAME.test(name)) { diagnostics.push({ path: entry.path, error: 'pi_skill_name_invalid' }); continue; }
      if (names.has(name)) { diagnostics.push({ path: entry.path, error: 'pi_duplicate_skill_name' }); continue; }
      names.add(name);
      resources.push({ kind: 'skills', name, scope: 'project', path: entry.path, description: parsed.description,
        sha256: files[entry.path]!.sha256, content: files[entry.path]!.text });
    } catch { diagnostics.push({ path: entry.path, error: 'pi_frontmatter_unsupported' }); }
  }
  resources.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { resources, diagnostics };
}

async function discoverPrompts(api: ModAPI): Promise<{ resources: Prompt[]; diagnostics: Json[]; candidate_sha256: string }> {
  const before = api.host.call('workspace.snapshot', {});
  if (!SHA.test(before.candidate_sha256)) throw new Error('pi_candidate_invalid');
  const stat = api.host.call('workspace.stat', { paths: [ROOT] }).files[ROOT];
  if (stat === null) {
    api.host.call('workspace.snapshot', { expected: before.candidate_sha256 });
    return { resources: [], diagnostics: [], candidate_sha256: before.candidate_sha256 };
  }
  if (stat?.kind !== 'dir') throw new Error('pi_prompt_root_unavailable');
  const listed = api.host.call('workspace.list', { path: ROOT, recursive: false, include_ignored: true, max_entries: MAX_FILES });
  if (listed.truncated || listed.entries.length > MAX_FILES) throw new Error('pi_discovery_limit');
  const diagnostics: Json[] = [];
  const eligible: { name: string; path: string; size: number }[] = [];
  for (const entry of listed.entries) {
    if (!entry.path.startsWith(`${ROOT}/`) || entry.path.slice(ROOT.length + 1).includes('/')) throw new Error('pi_listing_invalid');
    const file = entry.path.slice(ROOT.length + 1);
    if (!file.endsWith('.md') || file.startsWith('.')) continue;
    if (entry.kind === 'symlink') { diagnostics.push({ path: entry.path, error: 'pi_symlink_unsupported' }); continue; }
    if (entry.kind !== 'file') continue;
    const name = file.slice(0, -3);
    if (!NAME.test(name)) { diagnostics.push({ path: entry.path, error: 'pi_prompt_name_invalid' }); continue; }
    if (!Number.isSafeInteger(entry.size) || entry.size > MAX_FILE_BYTES) { diagnostics.push({ path: entry.path, error: 'pi_resource_limit' }); continue; }
    eligible.push({ name, path: entry.path, size: entry.size });
  }
  const paths = eligible.map(item => item.path);
  const files = paths.length ? api.host.call('workspace.read', { paths }).files : {};
  const resources: Prompt[] = [];
  for (const item of eligible) {
    const file = files[item.path];
    if (!file || !SHA.test(file.sha256) || utf8(file.text).length !== item.size || await digest(file.text) !== file.sha256) throw new Error('pi_source_stale');
    try {
      const parsed = frontmatter(file.text);
      resources.push({ kind: 'prompts', name: item.name, scope: 'project', path: item.path,
        description: parsed.description?.trim() || fallback(parsed.body), argument_hint: parsed.argument_hint,
        sha256: file.sha256, content: parsed.body });
    } catch { diagnostics.push({ path: item.path, error: 'pi_frontmatter_unsupported' }); }
  }
  if (paths.length) {
    const final = api.host.call('workspace.stat', { paths, hash: true }).files;
    for (const item of eligible) if (final[item.path]?.kind !== 'file' || final[item.path]?.size !== item.size
      || final[item.path]?.sha256 !== files[item.path]?.sha256) throw new Error('pi_source_stale');
  }
  resources.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  api.host.call('workspace.snapshot', { expected: before.candidate_sha256 });
  const result = { resources, diagnostics, candidate_sha256: before.candidate_sha256 };
  if (utf8(JSON.stringify(result)).length > MAX_RESULT_BYTES) throw new Error('pi_resource_aggregate_limit');
  return result;
}

async function discover(api: ModAPI): Promise<{ resources: Resource[]; diagnostics: Json[]; candidate_sha256: string }> {
  const prompts = await discoverPrompts(api);
  const skills = await discoverSkills(api);
  const user = await userResources(api, 'discover', {});
  api.host.call('workspace.snapshot', { expected: prompts.candidate_sha256 });
  const selected = new Map<string, Resource>();
  for (const resource of user?.resources || []) selected.set(`${resource.kind}/${resource.name}`, resource);
  for (const resource of [...prompts.resources, ...skills.resources]) selected.set(`${resource.kind}/${resource.name}`, resource);
  const resources = [...selected.values()].sort((left, right) => `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`));
  const result = { resources, diagnostics: [...(user?.diagnostics || []), ...prompts.diagnostics, ...skills.diagnostics],
    candidate_sha256: prompts.candidate_sha256, ...(user ? { user_source_digest: user.user_source_digest } : {}) };
  if (utf8(JSON.stringify(result)).length > MAX_RESULT_BYTES) throw new Error('pi_resource_aggregate_limit');
  return result;
}

async function userResources(api: ModAPI, tool: 'discover' | 'expand', input: Json): Promise<UserResult | null> {
  const directory = api.settings.user_agent_dir;
  if (directory === undefined) return null;
  if (typeof directory !== 'string' || !directory.startsWith('/') || directory.length > 4096 || directory.split('/').includes('..')) throw new Error('pi_user_root_invalid');
  const source = api.assets.read('index.ts');
  const bootstrap = api.assets.read('pi_user_cli.mjs');
  if (!SHA.test(source.sha256) || utf8(source.text).length > 64 * 1024 || !SHA.test(bootstrap.sha256)
    || utf8(bootstrap.text).length > 16 * 1024) throw new Error('pi_package_source_invalid');
  const node = api.host.call('process.which', { names: ['node'] }).found.find(item => item.name === 'node');
  if (!node) throw new Error('pi_user_node_unavailable');
  const result = api.host.call('exec.run', { program: node.path, sha256: node.sha256,
    argv: ['--no-warnings', '--input-type=module', '--eval', bootstrap.text, JSON.stringify({ tool, input, user_agent_dir: directory })],
    stdin: source.text, timeout_ms: 30_000, max_output_bytes: MAX_RESULT_BYTES, output_artifact: true });
  if (result.exit_code !== 0 || result.timed_out || result.stdout_truncated || result.stderr_truncated || !result.output_artifact)
    throw new Error(`pi_user_process_failed: ${result.stderr.slice(-800)}`);
  let cursor: number | undefined;
  let output = '';
  for (let index = 0; index < 9; index++) {
    const page = api.host.call('exec.output_page', { artifact: result.output_artifact, cursor, max_bytes: 16_384 });
    output += page.text;
    if (page.cursor === null) {
      if (await digest(output) !== result.stdout_sha256) throw new Error('pi_user_output_changed');
      const parsed = JSON.parse(output) as Json;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !SHA.test(parsed.user_source_digest as string)) throw new Error('pi_user_output_invalid');
      return parsed as unknown as UserResult;
    }
    cursor = page.cursor;
  }
  throw new Error('pi_user_output_limit');
}

function parseArgs(input: string): string[] {
  const parsed: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of input) {
    if (quote && character === quote) quote = null;
    else if (quote) current += character;
    else if (character === '"' || character === "'") quote = character;
    else if (character === ' ' || character === '\t') { if (current) { parsed.push(current); current = ''; } }
    else current += character;
  }
  if (current) parsed.push(current);
  return parsed;
}

function replaceAll(value: string, needle: string, replacement: string): string {
  let output = '';
  let cursor = 0;
  while (true) {
    const start = value.indexOf(needle, cursor);
    if (start < 0) return output + value.slice(cursor);
    const end = start + needle.length;
    output += value.slice(cursor, start);
    for (let index = 0; index < replacement.length; index++) {
      const character = replacement[index];
      if (character !== '$') { output += character; continue; }
      const next = replacement[index + 1];
      if (next === '$') { output += '$'; index++; }
      else if (next === '&') { output += needle; index++; }
      else if (next === '`') { output += value.slice(0, start); index++; }
      else if (next === "'") { output += value.slice(end); index++; }
      else output += '$';
    }
    cursor = end;
  }
}

function substitute(content: string, arguments_: string[]): string {
  const positional = content.replace(/\$(\d+)/g, (_, digits: string) => {
    const index = Number(digits);
    return index >= 1 && Number.isSafeInteger(index) ? arguments_[index - 1] || '' : '';
  });
  const sliced = positional.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, start: string, count?: string) => {
    const offset = Math.max(0, Number(start) - 1);
    const limit = count === undefined ? undefined : Number(count);
    return arguments_.slice(offset, limit === undefined ? undefined : offset + limit).join(' ');
  });
  const all = arguments_.join(' ');
  return replaceAll(replaceAll(sliced, '$ARGUMENTS', all), '$@', all);
}

async function expand(api: ModAPI, input: Json): Promise<Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('pi_input_invalid');
  const name = input.name;
  const args = input.args;
  if (typeof name !== 'string' || !NAME.test(name) || typeof args !== 'string' || args.length > 4096) throw new Error('pi_input_invalid');
  const catalog = await discoverPrompts(api);
  const prompt = catalog.resources.find(item => item.name === name);
  if (!prompt) {
    const user = await userResources(api, 'expand', input);
    if (!user || user.error === 'pi_prompt_not_found') throw new Error('pi_prompt_not_found');
    api.host.call('workspace.snapshot', { expected: catalog.candidate_sha256 });
    return { ...user, candidate_sha256: catalog.candidate_sha256 };
  }
  const text = substitute(prompt.content, parseArgs(args));
  if (utf8(text).length > 61_440) throw new Error('pi_prompt_expansion_limit');
  return { name, path: prompt.path, sha256: prompt.sha256, text, candidate_sha256: catalog.candidate_sha256 };
}

async function command(api: ModAPI, input: Json): Promise<Json> {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('pi_command_invalid');
  const trimmed = input.trim();
  if (!trimmed) {
    const catalog = await discover(api);
    const prompts = catalog.resources.filter(item => item.kind === 'prompts');
    return { display: prompts.length ? prompts.map(item => `${item.name} (${item.scope}): ${item.description}`).join('\n') : 'No Pi prompts found.' };
  }
  const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match || !NAME.test(match[1])) throw new Error('pi_command_invalid');
  const result = await expand(api, { name: match[1], args: match[2] || '' });
  const content = result && typeof result === 'object' && !Array.isArray(result) ? result.text : null;
  if (typeof content !== 'string' || !content.trim() || utf8(content).length > 16_384) throw new Error('pi_command_expansion_invalid');
  return { submit: content };
}

export default function activate(api: ModAPI) {
  api.tool({ name: 'discover', description: 'Discover bounded project-local Pi Markdown prompts without executing them.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => discover(api));
  api.tool({ name: 'expand', description: 'Expand an exact project-local Pi prompt using Pi positional argument rules.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'string' } },
      required: ['name', 'args'], additionalProperties: false } }, input => expand(api, input));
  api.command('pi', input => command(api, input), { description: 'List Pi prompts or submit a named prompt with arguments' });
}
