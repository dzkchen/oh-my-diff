import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCli } from './transport.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const prices = {
  'claude-sonnet-5': [2_000_000, 200_000, 4_000_000, 10_000_000],
  'claude-haiku-4-5-20251001': [1_000_000, 100_000, 2_000_000, 5_000_000],
};

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => sha(await readFile(path));

async function privateFile(path, value) {
  await writeFile(path, value, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

function requireCommand(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'command_failed').trim());
  return result.stdout;
}

async function findCli(value) {
  if (value) return realpath(value);
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, 'claude');
    try { await access(candidate, constants.X_OK); return realpath(candidate); } catch {}
  }
  throw new Error('official_claude_cli_unavailable');
}

async function prepare(recordPath, repositoryPath, prompt, model, claudePath, maxRequests) {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  model ||= 'claude-sonnet-5';
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 8) {
    throw new Error('claude_task_request_limit_must_be_1_to_8');
  }
  if (record.profile !== 'full' || !record.packages?.omd_claude_cli || !(model in prices)) {
    throw new Error('full_claude_mod_and_pinned_model_required');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8192) {
    throw new Error('claude_prompt_must_be_1_to_8192_characters');
  }
  const repository = await realpath(repositoryPath);
  if (!(await stat(repository)).isDirectory()) throw new Error('repository_must_be_a_directory');
  const claude = await findCli(claudePath);
  if (!(await stat(claude)).isFile()) throw new Error('official_claude_cli_unavailable');
  checkCli(claude);
  const prefix = await realpath(record.prefix);
  const mod = await realpath(join(record.store, 'sources', 'omd_claude_cli'));
  if (mod !== source) throw new Error('setup_must_run_from_installed_mod');
  const manager = await realpath(record.manager.installed_path);
  const inspected = JSON.parse(requireCommand([manager, 'inspect', mod]));
  if (inspected.sha256 !== record.packages.omd_claude_cli.sha256) {
    throw new Error('installed_claude_mod_changed');
  }
  const selected = JSON.parse(requireCommand([manager, 'selection-status', record.store]));
  if (!selected.selections?.some(item => item.id === 'omd_claude_cli' && item.effective && !item.error)) {
    throw new Error('enable_the_full_claude_mod_first');
  }
  const node = await realpath(record.author.node);
  const nodeVersion = requireCommand([node, '--version']).trim();
  if (nodeVersion !== 'v24.18.0') throw new Error('node_24_18_0_required');
  const tasks = join(prefix, 'tasks');
  await mkdir(tasks, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(tasks, 'omd-claude-task-'));
  await chmod(root, 0o700);
  const taskStore = join(root, 'store');
  requireCommand([manager, 'init', taskStore, node]);
  for (const id of ['omd_claude_cli', 'omd_workflow']) {
    const packagePath = await realpath(join(record.store, 'sources', id));
    const current = JSON.parse(requireCommand([manager, 'inspect', packagePath]));
    if (current.sha256 !== record.packages[id]?.sha256) throw new Error(`installed_package_changed:${id}`);
    const declared = JSON.parse(await readFile(join(packagePath, 'mod.json'), 'utf8'));
    requireCommand([manager, 'trust', taskStore, packagePath, current.sha256, declared.capabilities.join(',')]);
    requireCommand([manager, 'enable', taskStore, packagePath]);
  }
  requireCommand([manager, 'settings', taskStore, mod, JSON.stringify({ model })]);
  const workflow = join(record.store, 'sources', 'omd_workflow');
  requireCommand([manager, 'settings', taskStore, workflow, JSON.stringify({ check: { program: '/usr/bin/true', argv: [] }, initial_task: { objective: prompt, acceptance_criteria: ['Complete the user request', 'Report verification or limitations'] } })]);
  const contract = await realpath(record.tools?.['omd-contract']?.installed_path ?? '');
  if (await digest(contract) !== record.tools?.['omd-contract']?.sha256) throw new Error('installed_contract_manager_changed');
  const token = randomBytes(40).toString('base64url');
  const tokenPath = join(root, 'local-token');
  await privateFile(tokenPath, token);
  const port = await unusedPort();
  const responseUrl = `http://127.0.0.1:${port}/v1/responses`;
  const rate = prices[model];
  const pricing = { input_microusd_per_million: rate[0], cached_microusd_per_million: rate[1],
    cache_write_microusd_per_million: rate[2], output_microusd_per_million: rate[3],
    reservation_microusd: 500_000, max_output_tokens: 8192, input_token_ceiling: 200_000,
    included_subscription: false, external_subscription: true };
  const route = { name: 'claude_subscription', roles: ['lead'], provider: 'omd_claude_cli', model, reasoning_effort: 'medium',
    responses_url: responseUrl, rates: pricing };
  const home = homedir();
  const username = userInfo().username;
  const readCandidates = [mod, claude, dirname(claude), resolve(dirname(node), '..'), '/opt/homebrew',
    join(home, '.claude'), join(home, '.claude.json'), join(home, 'Library/Keychains'), '/System', '/usr/lib',
    '/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib'];
  const readPaths = [];
  for (const path of readCandidates) {
    try { readPaths.push(await realpath(path)); } catch {}
  }
  const host = {
    schema: 1,
    limits: { requests: maxRequests, exposure_microusd: maxRequests * 500_000, seconds: 240,
      concurrent_workers: 2, max_depth: 2, max_reassessments: 0 },
    worker_limits: { requests: 1, exposure_microusd: 100_000, seconds: 240 },
    routes: [route], snapshot_bytes: 1_000_000, max_request_bytes: 2_000_000,
    secret_refs: { claude_local_token: tokenPath },
    services: [{ id: 'claude_cli', mod_id: 'omd_claude_cli', program: node,
      program_sha256: await digest(node),
      arguments: [join(mod, 'transport.mjs'), 'serve', String(port), model, claude, home, username, String(maxRequests)],
      secrets: { OMD_CLAUDE_LOCAL_TOKEN: 'claude_local_token' },
      route, network: true, read_paths: readPaths }],
  };
  await privateFile(join(taskStore, 'host.json'), `${JSON.stringify(host, null, 2)}\n`);
  let priorHost;
  try { priorHost = JSON.parse(await readFile(join(record.store, 'host.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const priorSelection = priorHost?.contract?.user ?? join(record.store, 'contract-selection.json');
  try { await copyFile(priorSelection, join(taskStore, 'contract-selection.json'), constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const plan = JSON.parse(requireCommand([contract, 'plan', taskStore, repository, 'solo_evidence@1']));
  if (plan.weakens || plan.before.status === 'unavailable') throw new Error('resolve_existing_contract_before_solo_task');
  requireCommand([contract, 'select', taskStore, repository, 'solo_evidence@1']);
  const selectedContract = JSON.parse(requireCommand([contract, 'status', taskStore, repository]));
  if (selectedContract.status !== 'active' || selectedContract.contract.key !== 'solo_evidence@1') throw new Error('repository_contract_disallows_solo_task');
  await mkdir(join(root, 'codex-home'), { mode: 0o700 });
  await mkdir(join(root, 'sqlite'), { mode: 0o700 });
  const settings = [
    `model=${JSON.stringify(model)}`, 'model_provider="omd_claude_cli"',
    'model_reasoning_effort="medium"',
    'web_search="disabled"', 'features.plugins=false',
    `model_catalog_json=${JSON.stringify(join(mod, 'models.json'))}`,
    `model_providers.omd_claude_cli.base_url=${JSON.stringify(`http://127.0.0.1:${port}/v1`)}`,
    'model_providers.omd_claude_cli.name="OMD Claude CLI"',
    'model_providers.omd_claude_cli.wire_api="responses"',
    'model_providers.omd_claude_cli.env_key="OMD_CLAUDE_LOCAL_TOKEN"',
    'model_providers.omd_claude_cli.request_max_retries=0',
    'model_providers.omd_claude_cli.stream_max_retries=0',
    'model_providers.omd_claude_cli.supports_websockets=false',
    'shell_environment_policy.exclude=["OMD_CLAUDE_LOCAL_TOKEN"]',
  ];
  const argv = [];
  for (const setting of settings) argv.push('-c', setting);
  argv.push('exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '-C', repository, prompt);
  const env = { ...process.env, OMD_MODE: 'omd', OMD_INSTALL_PROFILE: 'full',
    OMD_MOD_STORE: taskStore, OMD_CLAUDE_LOCAL_TOKEN: token,
    CODEX_HOME: join(root, 'codex-home'), CODEX_SQLITE_HOME: join(root, 'sqlite') };
  delete env.OMD_CONTROLLED_MANIFEST;
  console.log(JSON.stringify({ task_evidence: join(taskStore, 'sessions'), model, request_limit: maxRequests,
    route: 'claude.ai subscription' }));
  const child = spawnSync(record.binary.installed_path, argv, { env, stdio: 'inherit' });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [record, repository, model, claude, requestLimit, ...prompt] = process.argv.slice(2);
  try { process.exitCode = await prepare(record, repository, prompt.join(' '), model,
    claude, Number(requestLimit)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
