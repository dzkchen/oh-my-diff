import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const WAIT_MS = 9 * 60_000;
const escape = text => String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const style = '<style>body{font:14px system-ui;margin:1rem;background:#111;color:#eee}img{max-width:100%;border:1px solid #444;cursor:crosshair}input,button{font:inherit}</style>';

const viewPage = (session, reason) => `<!doctype html><meta charset=utf-8><title>OMD browser · ${escape(session)}</title>${style}
<p>${escape(reason)}</p>
<form id=done><input id=note size=60 placeholder="Note for the agent (optional)"> <button>Done, return control</button></form>
<img id=view tabindex=0 alt="Live browser view">
<script>
const base = location.pathname, view = document.getElementById('view');
const post = (path, body) => fetch(base + '/' + path, { method: 'POST', body: JSON.stringify(body) });
const tick = () => { view.src = base + '/frame?' + Date.now(); };
view.onload = () => setTimeout(tick, 300);
view.onerror = () => setTimeout(tick, 1000);
view.onclick = e => { view.focus(); post('input', { type: 'click', x: e.offsetX * view.naturalWidth / view.clientWidth, y: e.offsetY * view.naturalHeight / view.clientHeight }); };
view.onwheel = e => { e.preventDefault(); post('input', { type: 'scroll', dy: e.deltaY }); };
view.onkeydown = e => { e.preventDefault(); post('input', e.key.length === 1 ? { type: 'text', text: e.key } : { type: 'key', key: e.key }); };
document.getElementById('done').onsubmit = e => { e.preventDefault(); post('done', { note: document.getElementById('note').value }); document.body.textContent = 'Control returned to the agent. You can close this tab.'; };
tick();
</script>`;

const enrollPage = origin => `<!doctype html><meta charset=utf-8><title>Save a login for ${escape(origin)}</title>${style}
<h1>Save a login for ${escape(origin)}</h1>
<p>The OMD browser encrypts it into its vault and fills it only on ${escape(origin)}. The agent never receives it.</p>
<form id=save><input id=user autocomplete=off placeholder=Username> <input id=secret type=password autocomplete=new-password placeholder=Password> <button>Save</button></form>
<script>
document.getElementById('save').onsubmit = e => { e.preventDefault(); fetch(location.pathname, { method: 'POST', body: JSON.stringify({ username: user.value, password: secret.value }) }).then(() => { document.body.textContent = 'Saved. You can close this tab.'; }); };
</script>`;

const openExternal = url => new Promise(resolve => {
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => resolve(false)).on('exit', code => resolve(code === 0));
});

const readBody = request => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 262_144) request.destroy(new Error('body_too_large'));
  }).on('end', () => resolve(body)).on('error', reject);
});

export function startLive({ frame, input, pane }) {
  const token = randomBytes(16).toString('hex');
  const waiters = new Map();
  const attached = new Map();
  const server = createServer(async (request, response) => {
    const host = `127.0.0.1:${server.address().port}`;
    const [, key, kind, rawName, action] = new URL(request.url, `http://${host}`).pathname.split('/');
    const name = kind === 'pane' || kind === 'view' ? rawName?.toLowerCase() : rawName;
    const waiter = waiters.get(`${kind === 'pane' ? 'view' : kind}/${name}`);
    if (request.headers.host !== host || key !== token || (kind === 'pane' ? !pane?.allowed(name) : !waiter)) return response.writeHead(404).end();
    try {
      if (kind === 'pane') {
        attached.set(name, Date.now());
        if (action === 'cdp') return await pane.cdp(name, request, response);
        const body = request.method === 'POST' ? JSON.parse(await readBody(request)) : null;
        if (action === 'done') waiter?.resolve(body);
        const result = action === 'frame' ? await pane.frame(name) : action === 'done' ? {}
          : Object.hasOwn(pane.routes, action) ? await pane.routes[action](name, body) : { ...await pane.status(name, action === 'state'), handoff: waiter?.reason ?? null };
        return Buffer.isBuffer(result) ? response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(result)
          : response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      }
      if (request.method === 'GET' && !action) return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(waiter.page);
      if (kind === 'view' && action === 'frame') {
        return response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).end(await frame(name));
      }
      if (request.method !== 'POST') return response.writeHead(405).end();
      const body = JSON.parse(await readBody(request));
      if (kind === 'view' && action === 'input') await input(name, body);
      else waiter.resolve(body);
      response.writeHead(204).end();
    } catch (error) {
      response.writeHead(500).end(String(error.message));
    }
  });

  async function listen() {
    if (!server.listening) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}/${token}`;
  }

  async function present(kind, name, page, signal, reason = null) {
    const key = `${kind}/${name}`;
    const url = `${await listen()}/${key}`;
    const inPane = kind === 'view' && Date.now() - (attached.get(name) ?? 0) < 5_000;
    waiters.get(key)?.resolve(null);
    return new Promise(resolve => {
      const finish = value => {
        if (waiters.get(key)?.resolve !== finish) return;
        clearTimeout(timer);
        waiters.delete(key);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), WAIT_MS);
      signal?.addEventListener('abort', () => finish(null), { once: true });
      waiters.set(key, { page, resolve: finish, reason });
      if (!inPane) openExternal(url).then(opened => opened || process.stderr.write(`omd-browser: open ${url} to continue\n`));
    });
  }

  return {
    handoff: (session, reason, signal) => present('view', session, viewPage(session, reason), signal, reason),
    listen,
    enroll: (origin, signal) => present('vault', randomBytes(8).toString('hex'), enrollPage(origin), signal),
    close: () => server.close(),
  };
}
