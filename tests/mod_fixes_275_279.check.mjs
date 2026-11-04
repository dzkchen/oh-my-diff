// Stub-host regression checks for the #275/#279 mod fixes. Runs without a built omd-runner:
//   node --experimental-strip-types tests/mod_fixes_275_279.check.mjs
// (repo-pinned Node 24 strips types natively; the flag is a no-op there). Not wired into mise tasks.
const ROOT = process.env.OMD_ROOT ?? new URL('..', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

function makeApi(overrides = {}) {
  const handlers = { on: {}, commands: {}, intercepts: [], replaces: {} };
  let state = null;
  const calls = [];
  const api = {
    settings: {},
    host: { tryCall: (method, args) => { calls.push(method); return (overrides.tryCall ?? (() => ({ ok: false, error: 'unset' })))(method, args); },
      call: (m, a) => { throw new Error('unexpected host.call ' + m); } },
    state: { get: () => state, set: v => { state = v; } },
    uiState: { get: () => null, set: () => {} },
    session: () => ({ thread_id: 'thread-lead', provider: 'p', model: 'm' }),
    on: (event, fn) => { handlers.on[event] = fn; },
    command: (name, fn) => { handlers.commands[name] = fn; },
    intercept: (surface, ...rest) => { handlers.intercepts.push(rest.length === 2 ? rest[1] : rest[0]); },
    replace: (point, fn) => { handlers.replaces[point] = fn; },
    provide: () => {},
    builtins: () => {},
    time: { after: () => () => {} },
    usage: { summarize: () => ({ context: { used: 0 }, tokens: {} }) },
  };
  return { api, handlers, calls, getState: () => state, setState: v => { state = v; } };
}

// ---------- omd_frecency: failed git status is cached (no per-keystroke respawn) ----------
{
  let execRuns = 0;
  const store = {};
  const { api, handlers } = makeApi({ tryCall: (method, args) => {
    if (method === 'store.get') return { ok: true, value: store[args.key] ? { value: store[args.key].value, revision: store[args.key].revision } : null };
    if (method === 'store.put') { store[args.key] = { value: args.value, revision: (store[args.key]?.revision ?? 0) + 1 }; return { ok: true, value: {} }; }
    if (method === 'exec.run') { execRuns++; return { ok: true, value: { exit_code: 128, stdout: '', stderr: 'not a git repository', stdout_truncated: false } }; }
    if (method === 'workspace.stat') return { ok: true, value: { files: {} } };
    return { ok: false, error: 'unexpected ' + method };
  }});
  const { default: activate } = await import(`${ROOT}/mods/first-party/omd_frecency/index.ts`);
  activate(api);
  const rank = handlers.replaces['completion'];
  rank({ kind: 'mention', query: 'foo', candidates: [] });
  rank({ kind: 'mention', query: 'foob', candidates: [] });
  rank({ kind: 'mention', query: 'fooba', candidates: [] });
  check('frecency: failed git status cached across keystrokes', execRuns === 1, `exec.run called ${execRuns}x in 3 keystrokes`);
}

// ---------- omd_frecency: deleted file with cached boost is not offered ----------
{
  const store = { status: { value: { at: Date.now(), boosts: [['gone.ts', 20]], recent: [] }, revision: 1 },
    files: { value: { tick: 1, files: {} }, revision: 1 } };
  const { api, handlers } = makeApi({ tryCall: (method, args) => {
    if (method === 'store.get') return { ok: true, value: store[args.key] ? { value: store[args.key].value, revision: store[args.key].revision } : null };
    if (method === 'store.put') { store[args.key] = { value: args.value, revision: (store[args.key]?.revision ?? 0) + 1 }; return { ok: true, value: {} }; }
    if (method === 'workspace.stat') return { ok: true, value: { files: {} } }; // gone.ts does not exist
    return { ok: false, error: 'unexpected ' + method };
  }});
  const { default: activate } = await import(`${ROOT}/mods/first-party/omd_frecency/index.ts`);
  activate(api);
  const out = handlers.replaces['completion']({ kind: 'mention', query: 'gone', candidates: [] });
  check('frecency: deleted file not offered despite cached boost', !out.items.some(i => i.path === 'gone.ts'), JSON.stringify(out.items));
}

// ---------- omd_frecency: slash command input records no tokens ----------
{
  const store = {};
  let state = null;
  const { api, handlers, getState } = makeApi({ tryCall: () => ({ ok: false, error: 'none' }) });
  const { default: activate } = await import(`${ROOT}/mods/first-party/omd_frecency/index.ts`);
  activate(api);
  const input = handlers.intercepts[handlers.intercepts.length - 1];
  await input({ text: '/preview ./src/x.ts' }, async e => e);
  const afterCommand = getState();
  await input({ text: 'look at ./src/y.ts please' }, async e => e);
  const afterPrompt = getState();
  check('frecency: slash command not counted as a use', afterCommand === null, JSON.stringify(afterCommand));
  check('frecency: prompt path still counted', Array.isArray(afterPrompt?.tokens) && afterPrompt.tokens.includes('src/y.ts'), JSON.stringify(afterPrompt));
}

// ---------- omd_continue: completed turn gets follow-up wording; newline path sanitized ----------
{
  const { api, handlers } = makeApi({ tryCall: (method) => {
    if (method === 'turns.activity') return { ok: true, value: { turns: [{ outcome: 'completed', reason: null, error: null, truncated: false,
      tool_calls: [], processes: [], files: [{ path: 'src/evil\nrm -rf ~.ts' }] }] } };
    return { ok: false, error: 'unexpected ' + method };
  }});
  const { default: activate } = await import(`${ROOT}/mods/first-party/omd_continue/index.ts`);
  activate(api);
  const out = handlers.commands['continue']('ship it');
  const text = out.submit;
  check('continue: completed turn does not say "Resume the interrupted task"', !text.startsWith('Resume the interrupted task'), text.split('\n')[0]);
  const bad = handlers.commands;
  // interrupted case with newline path
  const { api: api2, handlers: h2 } = makeApi({ tryCall: (method) => {
    if (method === 'turns.activity') return { ok: true, value: { turns: [{ outcome: 'failed', reason: null, error: { category: 'x', message: 'boom' }, truncated: false,
      tool_calls: [{ tool: 'shell\necho pwned', finished_at: null, outcome: null }], processes: [], files: [{ path: 'src/evil\nrm -rf ~.ts' }] }] } };
    return { ok: false, error: 'unexpected ' + method };
  }});
  (await import(`${ROOT}/mods/first-party/omd_continue/index.ts`)).default(api2);
  const t2 = h2.commands['continue']('').submit;
  check('continue: no raw newlines from tool/path injection', t2.split('\n').every(l => !l.includes('rm -rf ~.ts') || l.startsWith('- ')), JSON.stringify(t2.split('\n')));
}

// ---------- omd_idle_compact: declined compact request is not recorded as requested ----------
{
  const { api, handlers, getState } = makeApi({ tryCall: (method) => {
    if (method === 'app.request') return { ok: true, value: { status: 'declined' } };
    return { ok: true, value: {} };
  }});
  (await import(`${ROOT}/mods/first-party/omd_idle_compact/index.ts`)).default(api);
  // seed live state: fresh, over min tokens, not expired
  const now = Date.now();
  api.state.set({ at: now - 1000, ttl: 30 * 60000, expires: now + 29 * 60000, reported: false, identity: 'k', tokens: 200_000, running: false, pending: {}, compacted: 0, requested: null });
  // wind the clock to the fire point
  const realNow = Date.now;
  Date.now = () => realNow() + 100 * 3_600_000; // past expiry*0.9 boundary check: at + (expires-at)*0.9 - now < 1000
  handlers.on['timer']();
  Date.now = realNow;
  const requested = getState()?.requested ?? null;
  check('idle_compact: declined request not recorded as requested', requested === null, JSON.stringify(requested));
}

// ---------- omd_plan_panel: eviction keeps active over completed; /todos clear ----------
{
  const { api, handlers, getState } = makeApi({ tryCall: () => ({ ok: false, error: 'none' }) });
  (await import(`${ROOT}/mods/first-party/omd_plan_panel/index.ts`)).default(api);
  const notify = handlers.on['app_notification'];
  // 16 completed plans, then 1 active plan for the lead thread
  for (let i = 1; i <= 16; i++) notify({ method: 'turn/plan/updated', params: { threadId: `t${i}`, plan: [{ step: 'done', status: 'completed' }] }, thread_id: null });
  notify({ method: 'turn/plan/updated', params: { threadId: 'thread-lead', plan: [{ step: 'wip', status: 'inProgress' }] }, thread_id: null });
  let plans = getState().plans;
  check('plan_panel: active plan survives eviction of 16 completed', !!plans['thread-lead'], Object.keys(plans).join(','));
  const out = handlers.commands['todos']('clear');
  plans = getState().plans;
  check('plan_panel: /todos clear drops this thread plan', out.display === 'Plan cleared.' && !plans['thread-lead'], JSON.stringify(out));
}

// ---------- report ----------
let failed = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  :: ' + r.detail}`); if (!r.ok) failed++; }
process.exit(failed ? 1 : 0);
