import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host, privateDirectory } from './transport.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const WINDOW = 1_000_000;

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function findMuse(value) {
  if (value) return realpath(value);
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'muse');
    try { await access(candidate, constants.X_OK); return realpath(candidate); } catch {}
  }
  throw new Error('muse_cli_unavailable');
}

async function discover(muse, env) {
  const host = new Host(muse, env, null);
  try {
    const init = await host.ensure().catch(error => { throw new Error(`muse_serve_unavailable:${error.message}; Muse Code needs an MSP host build (\`muse serve\`)`); });
    const fingerprint = init.schema?.fingerprint;
    if (typeof fingerprint !== 'string' || !fingerprint) throw new Error('muse_schema_fingerprint_missing');
    const rows = (await host.request('model/list', {})).models ?? [];
    const models = rows.filter(row => typeof row.modelId === 'string' && row.modelId)
      .map(row => ({ slug: row.modelId, modelId: row.modelId, name: String(row.displayLabel ?? row.modelId), default: row.isDefault === true }));
    if (!models.length) throw new Error('muse_model_list_empty');
    return { fingerprint, models };
  } finally {
    host.stop();
  }
}

function catalog(models, template) {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  return { models: models.map((model, index) => ({ ...template, slug: model.slug, display_name: model.name,
    description: 'Muse Code agent through the opt-in OMD mod; Muse runs its own read-only tools.',
    context_window: WINDOW, max_context_window: WINDOW, auto_compact_token_limit: WINDOW * 0.9,
    default_reasoning_level: 'high', supported_reasoning_levels: levels.map(effort => ({ effort, description: effort })),
    supports_reasoning_summaries: true, default_reasoning_summary: 'auto', priority: 80 + index })) };
}

async function setup(recordPath, musePath) {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.profile !== 'full' || !record.packages?.omd_muse) throw new Error('omd_plus_muse_mod_required');
  const mod = await realpath(join(record.store, 'sources', 'omd_muse'));
  if (mod !== source) throw new Error('setup_must_run_from_installed_mod');
  const muse = await findMuse(musePath);
  const home = homedir();
  const username = userInfo().username;
  const data = `/private/tmp/omd-muse-${userInfo().uid}`;
  await privateDirectory(data);
  const { fingerprint, models } = await discover(muse, { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: data,
    TMPDIR: data, MUSE_EXPERIMENTAL_SDK_ENABLED: '1' });
  const directory = join(record.prefix, 'muse');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const routePath = join(directory, 'route.json');
  const catalogPath = join(directory, 'models.json');
  const tokenPath = join(directory, 'local-token');
  let previous = {};
  try { previous = JSON.parse(await readFile(routePath, 'utf8')); } catch {}
  try { await writeFile(tokenPath, randomBytes(40).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(tokenPath, 0o600);
  const port = previous.port ?? await unusedPort();
  const fallback = models.find(model => model.default) ?? models[0];
  await writeFile(routePath, `${JSON.stringify({ port, muse, fingerprint, data, home, username, default: fallback.slug, models }, null, 2)}\n`);
  const template = JSON.parse(await readFile(join(source, 'models.json'), 'utf8')).models[0];
  await writeFile(catalogPath, `${JSON.stringify(catalog(models, template), null, 2)}\n`);
  const node = await realpath(record.author.node);
  const readPaths = [];
  for (const path of [mod, directory, muse, dirname(muse), resolve(dirname(node), '..'), join(home, '.config/muse'),
    join(home, 'Library/Keychains'), '/System', '/usr/lib', '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld',
    '/System/Volumes/Preboot/Cryptexes/OS/usr/lib']) {
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
  host.secret_refs = { ...host.secret_refs, muse_local_token: tokenPath };
  host.services = [...(host.services ?? []).filter(grant => grant.id !== 'muse'), {
    id: 'muse', mod_id: 'omd_muse', program: node, program_sha256: sha(await readFile(node)),
    arguments: [join(mod, 'transport.mjs'), 'serve', routePath], secrets: { OMD_MUSE_LOCAL_TOKEN: 'muse_local_token' },
    network: true, read_paths: readPaths,
    route: { name: 'muse', roles: ['lead'], provider: 'omd_muse', model: fallback.slug, reasoning_effort: 'high',
      responses_url: `${url}/responses`, rates: { input_microusd_per_million: 0, cached_microusd_per_million: 0,
        output_microusd_per_million: 0, reservation_microusd: 0, max_output_tokens: 128000, input_token_ceiling: WINDOW,
        included_subscription: true } } }];
  await writeFile(hostPath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  return { provider: { id: 'omd_muse', name: 'OMD Muse', base_url: url, env_key: 'OMD_MUSE_LOCAL_TOKEN', token: tokenPath,
    catalog: catalogPath, route: routePath }, fingerprint, models: models.map(({ slug }) => ({ slug })), default: fallback.slug };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, record, muse] = process.argv.slice(2);
  try {
    if (action !== 'setup') throw new Error('unsupported_muse_setup_action');
    console.log(JSON.stringify(await setup(record, muse || '')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
