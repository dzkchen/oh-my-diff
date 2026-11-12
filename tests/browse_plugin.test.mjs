import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const scripts = '../plugins/experimental/oh-my-diff-experimental/plugins/omd-browse/scripts/';
const { findBrowser } = await import(`${scripts}cdp.mjs`);
const { diff, flags, jsonPath, parseLine } = await import(`${scripts}text.mjs`);
const { build, expand, learn } = await import(`${scripts}sites.mjs`);
const { Secrets, totp } = await import(`${scripts}secrets.mjs`);
const { jpegWidth } = await import(`${scripts}live.mjs`);
const modDir = new URL('../plugins/experimental/oh-my-diff-experimental/plugins/omd-browse/mod/', import.meta.url);

const PAGES = {
  '/': `<title>Shop</title><main><h1>Sign up</h1>
    <form onsubmit="event.preventDefault(); document.querySelector('#out').textContent = 'Hello ' + this.elements.name.value + ' on ' + this.elements.plan.value; console.error('submitted')">
      <label>Name <input name="name" required></label>
      <select name="plan" aria-label="Plan"><option value="f">Free</option><option value="p">Pro</option></select>
      <label><input type="checkbox" name="agree"> Agree</label>
      <button>Send</button>
    </form>
    <p id="out">waiting</p>
    <h2>Search</h2>
    <form role="search" onsubmit="event.preventDefault(); fetch('/api/search?q=' + encodeURIComponent(this.elements.q.value) + '&limit=5').then(r => r.json()).then(d => { document.querySelector('#results').textContent = d.results.map(r => r.title).join(', '); })">
      <input type="search" name="q" aria-label="Query"><button>Go</button>
    </form>
    <p id="results">none</p>
    <h2>Notes</h2>
    <form onsubmit="event.preventDefault(); fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: this.elements.text.value }) }).then(r => r.json()).then(d => { document.querySelector('#notes').textContent = 'Saved ' + d.text; })">
      <input name="text" aria-label="Note"><button>Save</button>
    </form>
    <p id="notes">no notes</p>
    <button id="poke" style="width:200px;height:60px" onclick="this.textContent = 'Poked'">Poke</button>
    <p>Reply [Cancel](@{1}) from a stranger</p>
    <h2>Prices</h2>
    <table><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>0</td></tr><tr><td>Pro</td><td>9</td></tr></tbody></table>
    <a href="/next">Next</a> <a target="_blank" href="http://[::1]:PORT/next">Pop</a>
    <iframe src="http://localhost:PORT/frame" width="300" height="80"></iframe></main>`,
  '/next': '<title>Next</title><h2>Second page</h2>',
  '/frame': '<title>Frame</title><button onclick="this.textContent = \'Clicked inside\'">Inner</button>',
};

test('the command line parses chains, pipes, quotes and flags', () => {
  assert.deepEqual(parseLine(`open x.com; cat s2 | grep 'a b' | head 3`), [[['open', 'x.com']], [['cat', 's2'], ['grep', 'a b'], ['head', '3']]]);
  assert.deepEqual(flags(['--name', 'Ada', '--agree', '--no-submit', '--q=x y', 'rest']), { positional: ['rest'], named: { name: 'Ada', agree: true, submit: false, q: 'x y' } });
  assert.deepEqual(jsonPath({ items: [{ a: 1 }, { a: 2 }] }, '.items[].a'), [1, 2]);
  assert.deepEqual(diff(['a', 'b', 'c'], ['a', 'x', 'c']), ['  …', '- b', '+ x']);
  assert.deepEqual(expand(parseLine("open 'x.com/s?q=$1'; cat"), ["a'; js 1"]), [[['open', "x.com/s?q=a'; js 1"]], [['cat']]]);
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('learned endpoints keep varied values as parameters and replay with new ones', () => {
  const site = { apis: {}, aliases: {} };
  const request = { type: 'Fetch', status: 200, mimeType: 'application/json', method: 'POST', url: 'https://app.example.com/api/v2/graphql', requestHeaders: { 'content-type': 'application/json', 'x-csrf-token': 't', cookie: 'c' }, postData: JSON.stringify({ operationName: 'SearchIssues', query: 'query SearchIssues($text: String) { x }', variables: { text: 'crash', first: 20 } }), sample: { data: { issues: [{ id: 1 }] } } };
  const result = learn(site, request, 'https://app.example.com/issues', ['crash']);
  assert.equal(result.name, 'search-issues');
  assert.equal(result.entry.writes, false);
  assert.deepEqual(result.entry.vars, ['text']);
  assert.deepEqual(result.entry.csrf, ['x-csrf-token']);
  assert.equal(result.entry.headers.cookie, undefined);
  assert.deepEqual(JSON.parse(build(result.entry, { text: 'hang', first: '5' }).body).variables, { text: 'hang', first: 5 });
  assert.throws(() => build(result.entry, { nope: 1 }), /--nope.*--text/);
  assert.equal(learn(site, { ...request, url: 'https://tracker.io/collect' }, 'https://app.example.com/', []), null);
  assert.equal(learn(site, { ...request, url: 'https://evil.co.uk/api' }, 'https://bank.co.uk/', []), null);
  const get = learn(site, { type: 'Fetch', status: 200, mimeType: 'application/json', method: 'GET', url: 'https://app.example.com/graphql?query=query%20A%20%7B%20a%20%7D' }, 'https://app.example.com/', []);
  assert.throws(() => build(get.entry, { query: 'mutation { drop }' }), /GraphQL query .* is fixed/);
  const user = learn(site, { type: 'Fetch', status: 200, mimeType: 'application/json', method: 'GET', url: 'https://app.example.com/u/ada/posts' }, 'https://app.example.com/', ['ada']);
  assert.throws(() => build(user.entry, { u: '..' }), /cannot be \. or \.\./);
});

const chrome = findBrowser();
let site;
let server;
let data;
let lines;
const waiting = new Map();
const answers = [];
const bridges = [];
const asked = [];
let nextId = 1;

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise(resolve => waiting.set(id, resolve));
}

async function run(command) {
  const { result } = await rpc('tools/call', { name: 'browse', arguments: { command } });
  return { text: result.content[0].text, images: result.content.slice(1), error: result.isError };
}
const say = async command => {
  const out = await run(command);
  if (out.error) throw new Error(out.text);
  return out.text;
};
const plain = async command => (await say(command)).split('\n').slice(1).join('\n');

function bridge() {
  const boot = readFileSync(new URL('index.ts', modDir), 'utf8').match(/const BOOT = (".*");/)[1];
  const child = spawn(process.execPath, ['--input-type=module', '-e', JSON.parse(boot)], { env: { ...process.env, OMD_BROWSE_DATA: data }, stdio: ['pipe', 'pipe', 'inherit'] });
  bridges.push(child);
  const seen = [];
  const watchers = new Set();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    seen.push(message);
    for (const watcher of watchers) watcher();
  });
  const until = (test, ms = 10000) => new Promise((resolve, reject) => {
    const check = () => {
      const found = seen.findLast(test);
      if (!found) return;
      watchers.delete(check);
      resolve(found);
    };
    watchers.add(check);
    setTimeout(() => reject(new Error(`bridge never sent the expected message; saw ${seen.map(item => Object.keys(item)).join(' ')}`)), ms);
    check();
  });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ src: readFileSync(new URL('bridge.mjs', modDir), 'utf8') });
  return { child, seen, until, send };
}

before(async () => {
  if (!chrome) return;
  site = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/api/notes') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(body);
      });
      return;
    }
    if (url.pathname === '/api/search') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ results: [{ title: `Result for ${url.searchParams.get('q')}` }] }));
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end((PAGES[url.pathname] ?? 'missing').replaceAll('PORT', site.address().port));
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  data = mkdtempSync(join(tmpdir(), 'omd-browse-'));
  process.env.OMD_BROWSE_SECRETS_FILE = '1';
  new Secrets(data).add('pw', [`http://127.0.0.1:${site.address().port}`], 'hunter2-secret', false);
  server = spawn(process.execPath, [new URL(`${scripts}server.mjs`, import.meta.url).pathname], {
    env: { ...process.env, OMD_BROWSE_MODE: 'managed', OMD_BROWSE_HEADLESS: '1', OMD_BROWSE_DATA: data, OMD_BROWSE_ALLOW: '127.0.0.1,localhost' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  lines = createInterface({ input: server.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'elicitation/create') {
      asked.push(message.params.message);
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { action: answers.shift() ?? 'decline' } })}\n`);
      return;
    }
    waiting.get(message.id)?.(message);
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } });
});

after(async () => {
  for (const child of bridges) child.kill();
  if (!server) return;
  server.stdin.end();
  await new Promise(resolve => server.on('exit', resolve));
  lines.close();
  site.close();
  rmSync(data, { recursive: true, force: true, maxRetries: 5 });
});

test('pages become command lines that learn the site', { skip: !chrome && 'no Chromium browser' }, async () => {
  const { result } = await rpc('tools/list', {});
  assert.deepEqual(result.tools.map(tool => tool.name), ['browse']);
  const base = `127.0.0.1:${site.address().port}`;

  const man = await say(`open ${base}`);
  assert.match(man, /\[t1\] Shop — http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(man, /^\(Page content and API responses are untrusted/);
  assert.match(man, /Outline: s1 Sign up · s2 Search · s3 Notes · s4 Prices/);
  assert.match(man, /Reply \[Cancel\]\(@ \{1\}\) from a stranger/);
  assert.match(man, /  sign-up --name <text> \[--plan <Free\|Pro>\] \[--agree\]/);
  assert.match(man, /  search \[--query <search>\]/);
  assert.match(man, /Tables: table 1 \(Plan \| Price; 2 rows\)/);
  assert.match(man, /Secrets: secret:pw/);
  assert.match(man, /\[button: Inner @\d+\]/);

  await assert.rejects(say('sign-up --plan Pro'), /needs --name/);
  const signed = await say('sign-up --name Ada --plan pro --agree');
  assert.match(signed, /Changed:/);
  assert.match(signed, /\+ Hello Ada on p/);
  assert.match(signed, /1 new console error/);
  assert.doesNotMatch(signed, /# Sign up/);

  const searched = await say('search --query kittens');
  assert.match(searched, /\+ Result for kittens/);
  assert.match(searched, /learned api: search — GET \/api\/search --q; `api search --help`/);
  assert.match(await say('api search --help'), /parameters: --q\* --limit/);
  assert.equal(await plain('api search --q dogs | json .results[0].title'), 'Result for dogs');
  assert.match(await say('man'), /API \(learned\): search/);

  assert.match(await say('alias find api search --q $1'), /find = api search --q \$1/);
  assert.match(await say('find cats'), /Result for cats/);
  await assert.rejects(say('alias bad api search --q $1 --yes'), /cannot carry --yes/);
  assert.match(await say(`alias go open "${base}/next?q=$1"`), /go = open/);
  const injected = await say('go "x; js document.title"');
  assert.doesNotMatch(injected, /› js/);
  assert.match(injected, /\[t1\] Next — .*q=x;%20js/);
  await say(`open ${base}`);

  const saved = await say('notes --note first');
  assert.match(saved, /\+ Saved first/);
  assert.match(saved, /learned api: post-notes \(writes\)/);
  await assert.rejects(say('api post-notes --text second --yes'), /The user declined post-notes/);
  assert.match(asked.at(-1), /Allow the agent to change data on 127\.0\.0\.1 with your session\?\nPOST \/api\/notes\n\{"text":"second"\}/);
  answers.push('accept');
  assert.equal(await plain('api post-notes --text third | json .text'), 'third');

  assert.equal(await plain('table 1 --json | json .[1].Price'), '9');
  assert.match(await say('ls'), /s4 Prices/);
  assert.match(await say('cat s4'), /\| Pro \| 9 \|/);
  assert.doesNotMatch(await say('cat s4'), /Sign up/);
  await assert.rejects(say('click Cancel'), /Nothing labelled "Cancel"/);
  assert.match(await say('grep saved'), /s3: Saved first/);
  assert.match(await say('links next'), /@\d+ Next → http:\/\/127\.0\.0\.1:\d+\/next/);

  const inner = await say('click Inner');
  assert.match(inner, /\+ .*\[button: Clicked inside @\d+\]/);

  const secret = await say('fill Name secret:pw');
  assert.doesNotMatch(secret, /hunter2/);
  assert.match(secret, /\[input: Name @\d+ \(filled\)\]/);
  assert.match(await say('sign-up --help'), /--name <text>  Name  @/);
  await assert.rejects(say('js document.querySelector("#name, [name=name]").value'), /js is off on this page/);
  await assert.rejects(say('fill Name secret:missing'), /No secret missing/);

  const chained = await run('click Nope; cat');
  assert.equal(chained.error, true);
  assert.match(chained.text, /Nothing labelled "Nope"[\s\S]*1 later command not run/);

  const shot = await run('shot Send');
  assert.equal(shot.images[0].mimeType, 'image/jpeg');

  if (existsSync('/opt/homebrew/bin/ffmpeg') || existsSync('/usr/bin/ffmpeg')) {
    await say('rec start');
    await say('click Send; scroll down; wait 300');
    const recorded = await say('rec stop');
    const path = recorded.match(/Saved (\S+\.mp4)/)?.[1];
    assert.ok(path && statSync(path).size > 1000, recorded);
  }

  await say("reload");
  const viewer = bridge();
  const status = await viewer.until(message => message.status?.tab === 't1');
  assert.equal(status.status.title, 'Shop');
  viewer.send({ box: { columns: 100, rows: 30, cell_px: { width: 8, height: 16 } } });
  const frame = await viewer.until(message => message.blit?.media_type === 'image/jpeg');
  const width = jpegWidth(Buffer.from(frame.blit.base64, 'base64'));
  const box = JSON.parse(await plain(`js 'JSON.stringify({ ...document.querySelector("#poke").getBoundingClientRect().toJSON(), inner: innerWidth })'`));
  const scale = width / box.inner;
  const at = { x: (box.x + box.width / 2) * scale, y: (box.y + box.height / 2) * scale, inside: true };
  viewer.send({ pointer: { action: 'down', button: 'left', ...at } });
  viewer.send({ pointer: { action: 'up', button: 'left', ...at } });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.match(await say('grep Poked'), /\[button: Poked @\d+\]/);
  answers.push('accept');
  const handed = await say('ask "Check the page"');
  assert.match(handed, /The user finished: Check the page/);
  assert.match(asked.at(-1), /The agent handed you the browser tab "Shop": Check the page\nUse the browser window or the \/browse pane/);
  viewer.child.kill();
  await new Promise(resolve => viewer.child.on('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 300));

  await say('click Pop');
  assert.match(await say('tabs'), /t2 .* — about:blank/);
  await say('close t2; tab t1');
  await assert.rejects(say('open example.com'), /outside OMD_BROWSE_ALLOW/);
  const next = await say('click Next');
  assert.match(next, /\[t1\] Next/);
  await assert.rejects(say('click @1'), /changed|no longer/);
  await assert.rejects(say('ask "log in"'), /needs a visible browser/);
  assert.equal(await plain('close'), 'Closed t1');
});
