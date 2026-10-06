import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION, loadSdk, privateDirectory } from './transport.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const WINDOW = 200_000;

async function codeDigest(root) {
  const rows = [];
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 8192) throw new Error('cursor_sdk_source_limit');
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const destination = relative(root, await realpath(path));
        if (isAbsolute(target) || destination === '..' || destination.startsWith('../')) throw new Error('cursor_sdk_dependency_escape');
        rows.push([name, 'link', target]);
      } else if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const size = (await stat(path)).size;
        bytes += size;
        if (size > 64 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new Error('cursor_sdk_source_limit');
        rows.push([name, 'file', sha(await readFile(path))]);
      }
      else throw new Error('cursor_sdk_dependency_type_invalid');
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return sha(JSON.stringify(rows));
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function install(directory) {
  const root = join(directory, 'sdk');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'package.json'), '{"private": true}\n');
  try { execFileSync('pnpm', ['add', '--dir', root, `@cursor/sdk@${SDK_VERSION}`], { stdio: ['ignore', 'ignore', 'inherit'] }); }
  catch { throw new Error(`cursor_sdk_install_failed: pnpm add @cursor/sdk@${SDK_VERSION}`); }
  return join(root, 'node_modules/@cursor/sdk/dist/esm/index.js');
}

// The SDK's browser login is the explicit enrollment. The minted key lives only in this process until the broker stores it as a secret owned by omd_cursor.
async function enroll(sdk) {
  let saved;
  const store = { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = undefined; } };
  try {
    await sdk.Cursor.auth.login({ store, apiKeyName: 'Oh My Diff',
      onLoginUrl: url => process.stderr.write(`Approve Oh My Diff in your browser to enroll Cursor: ${url}\n`) });
  } catch (error) {
    throw new Error(`cursor_enrollment_declined: ${error.message}`);
  }
  if (typeof saved?.apiKey !== 'string' || !saved.apiKey) throw new Error('cursor_enrollment_incomplete');
  return saved;
}

function storeSecret(record, credential) {
  try {
    return JSON.parse(execFileSync(record.manager.installed_path, ['credentials', record.store, 'add-secret', 'omd_cursor', 'cursor',
      new URL(credential.backendUrl ?? 'https://api2.cursor.sh').origin], { input: credential.apiKey, stdio: ['pipe', 'pipe', 'inherit'] }));
  } catch {
    throw new Error('cursor_secret_not_stored: the host broker refused or is unavailable');
  }
}

export function models(rows) {
  const found = [];
  for (const row of rows ?? []) {
    if (typeof row?.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(row.id)) continue;
    const effort = (row.parameters ?? []).find(parameter => /effort|reasoning/i.test(parameter.id ?? ''));
    found.push({ slug: `cursor-${row.id}`, id: row.id, name: `Cursor ${row.displayName ?? row.id}`, description: String(row.description ?? ''),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [], parameters: row.parameters ?? [],
      effort: effort ? { id: effort.id, values: (effort.values ?? []).map(value => String(value.value)) } : null,
      default: (row.variants ?? []).some(variant => variant.isDefault === true) });
  }
  if (!found.length) throw new Error('cursor_model_list_empty');
  return found;
}

function catalog(entries, template) {
  return { models: entries.map((model, index) => ({ ...template, slug: model.slug, display_name: model.name,
    description: `${model.description} Cursor subscription agent through the opt-in OMD mod; OMD tools only.`.trim(),
    context_window: WINDOW, max_context_window: WINDOW, auto_compact_token_limit: WINDOW * 0.9,
    default_reasoning_level: model.effort?.values.includes('medium') ? 'medium' : null,
    supported_reasoning_levels: (model.effort?.values ?? []).map(effort => ({ effort, description: effort })),
    priority: 70 + index })) };
}

async function setup(recordPath, sdkPath) {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.profile !== 'full' || !record.packages?.omd_cursor) throw new Error('omd_plus_cursor_mod_required');
  const mod = await realpath(join(record.store, 'sources', 'omd_cursor'));
  if (mod !== source) throw new Error('setup_must_run_from_installed_mod');
  const directory = join(record.store, 'routes', 'cursor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await realpath(sdkPath || await install(directory));
  let codeRoot = sdkPath ? dirname(entry) : await realpath(join(directory, 'sdk'));
  if (sdkPath) for (let parent = dirname(entry); parent !== dirname(parent); parent = dirname(parent)) {
    if (basename(parent) === 'node_modules') codeRoot = dirname(parent);
  }
  for (const path of [record.prefix, record.store]) {
    const within = relative(codeRoot, await realpath(path));
    if (within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith('../'))) throw new Error('cursor_sdk_requires_separate_directory');
  }
  const sdk = await loadSdk(entry);
  const credential = await enroll(sdk);
  const discovered = models(await sdk.Cursor.models.list({ apiKey: credential.apiKey }));
  const secret = storeSecret(record, credential);
  const data = `/private/tmp/omd-cursor-${userInfo().uid}`;
  await privateDirectory(data);
  const routePath = join(directory, 'route.json');
  const catalogPath = join(directory, 'models.json');
  const tokenPath = join(directory, 'local-token');
  let previous = {};
  try { previous = JSON.parse(await readFile(routePath, 'utf8')); } catch {}
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  const port = previous.port ?? await unusedPort();
  const fallback = discovered.find(model => model.id === 'auto') ?? discovered.find(model => model.default) ?? discovered[0];
  await writeFile(routePath, `${JSON.stringify({ port, sdk: entry, sdk_version: SDK_VERSION, data, default: fallback.slug,
    secret_profile: secret.id, backend_url: new URL(credential.backendUrl ?? 'https://api2.cursor.sh').origin,
    credential_expires_at_ms: credential.apiKeyExpiresAtMs ?? null, account: credential.email ?? null,
    discovered_at_ms: Date.now(), models: discovered }, null, 2)}\n`);
  const template = JSON.parse(await readFile(join(source, 'models.json'), 'utf8')).models[0];
  await writeFile(catalogPath, `${JSON.stringify(catalog(discovered, template), null, 2)}\n`);
  const node = await realpath(record.author.node);
  const readPaths = [];
  for (const path of [mod, directory, resolve(dirname(node), '..'), '/System', '/usr/lib',
    '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib']) {
    try { const real = await realpath(path); if (!readPaths.includes(real)) readPaths.push(real); } catch {}
  }
  const url = `http://127.0.0.1:${port}/v1`;
  const hostPath = join(record.store, 'host.json');
  let host = {};
  try { host = JSON.parse(await readFile(hostPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  host.schema = 1;
  host.worker_limits = { requests: 60, exposure_microusd: 0, ...host.worker_limits,
    seconds: Math.max(host.worker_limits?.seconds ?? 0, 86400) };
  host.secret_refs = { ...host.secret_refs, cursor_local_token: tokenPath };
  host.services = [...(host.services ?? []).filter(grant => grant.id !== 'cursor'), {
    id: 'cursor', mod_id: 'omd_cursor', program: node, program_sha256: sha(await readFile(node)),
    arguments: [join(mod, 'transport.mjs'), 'serve', routePath],
    secrets: { OMD_CURSOR_LOCAL_TOKEN: 'cursor_local_token' },
    network: true, read_paths: readPaths, code_roots: { [codeRoot]: await codeDigest(codeRoot) },
    route: { name: 'cursor', roles: ['lead'], provider: 'omd_cursor', model: fallback.slug, reasoning_effort: 'medium',
      responses_url: `${url}/responses`, rates: { input_microusd_per_million: 0, cached_microusd_per_million: 0,
        output_microusd_per_million: 0, reservation_microusd: 0, max_output_tokens: 128000, input_token_ceiling: WINDOW,
        included_subscription: false, provider_billed: true } } }];
  await writeFile(hostPath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  return { provider: { id: 'omd_cursor', name: 'OMD Cursor', base_url: url, env_key: 'OMD_CURSOR_LOCAL_TOKEN', token: tokenPath,
    catalog: catalogPath, route: routePath }, sdk: SDK_VERSION, account: credential.email ?? null,
    credential_expires_at_ms: credential.apiKeyExpiresAtMs ?? null, secret_profile: secret.id,
    models: discovered.map(({ slug, id }) => ({ slug, id })), default: fallback.slug };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, record, sdk] = process.argv.slice(2);
  try {
    if (action !== 'setup') throw new Error('unsupported_cursor_setup_action');
    console.log(JSON.stringify(await setup(record, sdk || '')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
