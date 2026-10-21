import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION, loadSdk, privateDirectory } from './transport.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const WINDOW = 200_000;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const LINK = 'OMD_CURSOR_LINK';
const RESULT = 'OMD_CURSOR_RESULT';
const FAILURE = 'OMD_CURSOR_ERROR';

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
  try { execFileSync('pnpm', ['add', '--dir', root, `@cursor/sdk@${SDK_VERSION}`], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (error) { throw new Error(`cursor_sdk_install_failed: pnpm add @cursor/sdk@${SDK_VERSION}: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`); }
  return join(root, 'node_modules/@cursor/sdk/dist/esm/index.js');
}

async function findOmdMod() {
  for (const directory of (process.env.PATH ?? '').split(':').filter(isAbsolute)) {
    const candidate = join(directory, 'omd-mod');
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error('omd_mod_unavailable: omd-mod is not on PATH');
}

// The SDK's browser login is the explicit enrollment. The minted key lives only in this process until the broker stores it as a secret owned by omd_cursor.
async function enroll(sdk) {
  let saved;
  const store = { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = undefined; } };
  try {
    await sdk.Cursor.auth.login({ store, apiKeyName: 'Oh My Diff', onLoginUrl: url => console.log(`${LINK} ${url}`) });
  } catch (error) {
    throw new Error(`cursor_enrollment_declined: ${error.message}`);
  }
  if (typeof saved?.apiKey !== 'string' || !saved.apiKey) throw new Error('cursor_enrollment_incomplete');
  return saved;
}

function storeSecret(omdMod, store, credential) {
  try {
    return JSON.parse(execFileSync(omdMod, ['credentials', store, 'add-secret', 'omd_cursor', 'cursor',
      new URL(credential.backendUrl ?? 'https://api2.cursor.sh').origin], { input: credential.apiKey, stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (error) {
    throw new Error(`cursor_secret_not_stored: ${String(error.stderr ?? 'the host broker refused or is unavailable').trim().split('\n').pop()}`);
  }
}

export function models(rows) {
  const found = [];
  for (const row of rows ?? []) {
    if (typeof row?.id !== 'string' || !/^[A-Za-z0-9_.-]{1,57}$/.test(row.id)) continue;
    const effort = (row.parameters ?? []).find(parameter => /effort|reasoning/i.test(parameter.id ?? ''));
    const name = `Cursor ${row.displayName ?? row.id}`;
    found.push({ slug: `cursor-${row.id}`, id: row.id, display: Buffer.byteLength(name) <= 64 ? name : `Cursor ${row.id}`,
      effort: effort ? { id: effort.id, values: (effort.values ?? []).map(value => String(value.value)) } : null,
      default: (row.variants ?? []).some(variant => variant.isDefault === true) });
  }
  if (!found.length) throw new Error('cursor_model_list_empty');
  const fallback = found.find(model => model.id === 'auto') ?? found.find(model => model.default) ?? found[0];
  return [fallback, ...found.filter(model => model !== fallback)].slice(0, 16);
}

const publish = model => {
  const efforts = (model.effort?.values ?? []).filter(value => EFFORTS.includes(value)).slice(0, 8);
  return { slug: model.slug, display: model.display, context_window: WINDOW, efforts, ...efforts.includes('medium') && { default_effort: 'medium' } };
};

async function setup(sdkPath) {
  const mod = await realpath(source);
  const store = dirname(dirname(mod));
  if (basename(dirname(mod)) !== 'sources') throw new Error('setup_must_run_from_installed_mod');
  const omdMod = await findOmdMod();
  const directory = join(store, 'routes', 'cursor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await realpath(sdkPath || await install(directory));
  let codeRoot = sdkPath ? dirname(entry) : await realpath(join(directory, 'sdk'));
  if (sdkPath) for (let parent = dirname(entry); parent !== dirname(parent); parent = dirname(parent)) {
    if (basename(parent) === 'node_modules') codeRoot = dirname(parent);
  }
  const within = relative(codeRoot, store);
  if (within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith('../'))) throw new Error('cursor_sdk_requires_separate_directory');
  const sdk = await loadSdk(entry);
  const credential = await enroll(sdk);
  try {
    return await finish(sdk, credential, { mod, store, directory, entry, codeRoot, omdMod });
  } catch (error) {
    throw new Error(String(error.message).split(credential.apiKey).join('[redacted]'));
  }
}

async function finish(sdk, credential, { mod, store, directory, entry, codeRoot, omdMod }) {
  const discovered = models(await sdk.Cursor.models.list({ apiKey: credential.apiKey }));
  const data = `/private/tmp/omd-cursor-${userInfo().uid}`;
  await privateDirectory(data);
  const routePath = join(directory, 'route.json');
  const tokenPath = join(directory, 'local-token');
  let previous = {};
  try { previous = JSON.parse(await readFile(routePath, 'utf8')); } catch {}
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  const port = previous.port ?? await unusedPort();
  const backend = new URL(credential.backendUrl ?? 'https://api2.cursor.sh').origin;
  const node = await realpath(process.execPath);
  const readPaths = [];
  for (const path of [mod, directory, resolve(dirname(node), '..'), '/System', '/usr/lib',
    '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib']) {
    try { const real = await realpath(path); if (!readPaths.includes(real)) readPaths.push(real); } catch {}
  }
  const url = `http://127.0.0.1:${port}/v1`;
  const hostPath = join(store, 'host.json');
  let host = {};
  try { host = JSON.parse(await readFile(hostPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const grant = {
    id: 'cursor', mod_id: 'omd_cursor', program: node, program_sha256: sha(await readFile(node)),
    arguments: [join(mod, 'transport.mjs'), 'serve', routePath],
    secrets: { OMD_CURSOR_LOCAL_TOKEN: 'cursor_local_token' },
    network: true, read_paths: readPaths, code_roots: { [codeRoot]: await codeDigest(codeRoot) },
    route: { name: 'cursor', roles: ['lead'], provider: 'omd_cursor', model: discovered[0].slug, reasoning_effort: 'medium',
      responses_url: `${url}/responses`, rates: { input_microusd_per_million: 0, cached_microusd_per_million: 0,
        output_microusd_per_million: 0, reservation_microusd: 0, max_output_tokens: 128000, input_token_ceiling: WINDOW,
        included_subscription: false, provider_billed: true } } };
  const secret = storeSecret(omdMod, store, credential);
  await writeFile(routePath, `${JSON.stringify({ port, sdk: entry, sdk_version: SDK_VERSION, data, default: discovered[0].slug,
    secret_profile: secret.id, backend_url: backend, credential_expires_at_ms: credential.apiKeyExpiresAtMs ?? null,
    account: credential.email ?? null, discovered_at_ms: Date.now(),
    models: discovered.map(({ slug, id, effort }) => ({ slug, id, effort })) }, null, 2)}\n`);
  host.schema = 1;
  host.worker_limits = { requests: 60, exposure_microusd: 0, ...host.worker_limits,
    seconds: Math.max(host.worker_limits?.seconds ?? 0, 86400) };
  host.secret_refs = { ...host.secret_refs, cursor_local_token: tokenPath };
  host.services = [...(host.services ?? []).filter(item => item.id !== 'cursor'), grant];
  await writeFile(hostPath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  return { sdk: SDK_VERSION, account: credential.email ?? null, expires: credential.apiKeyExpiresAtMs ?? null, data,
    default: discovered[0].slug, models: discovered.map(publish) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(`${RESULT} ${JSON.stringify(await setup(process.argv[2] ?? ''))}`);
  } catch (error) {
    console.log(`${FAILURE} ${String(error.message).replace(/\s+/g, ' ')}`);
    process.exitCode = 1;
  }
}
