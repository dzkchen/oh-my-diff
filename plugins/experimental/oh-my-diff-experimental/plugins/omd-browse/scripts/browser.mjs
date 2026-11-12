import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, launchManaged, userEndpoints } from './cdp.mjs';

const EXTRACT = readFileSync(new URL('./extract.js', import.meta.url), 'utf8');
const WORLD = 'omd_browse';
const CARD_WORLD = 'omd_browse_card';
const KEYS = {
  Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, ' '], ' ': [32, ' '],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34],
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
const COVER = `function(local) {
  const box = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const x = local ? box.left + this.clientLeft + parseFloat(style.paddingLeft) + local.x : box.left + box.width / 2;
  const y = local ? box.top + this.clientTop + parseFloat(style.paddingTop) + local.y : box.top + box.height / 2;
  const root = this.getRootNode();
  const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
  if (hit && hit !== this && !this.contains(hit) && !hit.contains(this) && hit.control !== this && hit.closest('label')?.control !== this) {
    const cover = hit.closest('dialog,[role=dialog],[aria-modal=true]') ?? hit;
    return { cover: { id: __omd.id(cover), text: (cover.innerText || cover.getAttribute('aria-label') || cover.tagName).replace(/\\s+/g, ' ').trim().slice(0, 80) } };
  }
  return { point: { x, y } };
}`;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Browser {
  constructor({ data, mode, headless, allowed, connectMs }) {
    Object.assign(this, { data, mode, headless, allowed, connectMs });
    this.conn = null;
    this.tabs = new Map();
    this.current = null;
    this.nextTab = 1;
    this.kind = '';
    this.child = null;
    this.notes = [];
    this.attaching = new Set();
    this.viewers = new Set();
    this.changed = () => {};
  }

  async connect() {
    if (this.conn && !this.conn.closed) return;
    this.tabs.clear();
    this.current = null;
    let url = null;
    const failures = [];
    if (this.mode !== 'managed') {
      for (const endpoint of userEndpoints()) {
        try {
          this.conn = await Connection.open(endpoint.url, this.connectMs);
          this.kind = `your browser (${endpoint.name})`;
          url = endpoint.url;
          break;
        } catch (error) {
          failures.push(`${endpoint.name}: ${error.message === 'timeout' ? 'connection not approved in the browser' : 'not reachable'}`);
        }
      }
      if (!url && this.mode === 'user') {
        throw new Error(['Could not connect to your browser.', ...failures,
          'In Chrome, open chrome://inspect/#remote-debugging, turn on "Allow remote debugging for this browser instance", then retry and click Allow in the dialog Chrome shows.'].join('\n'));
      }
    }
    if (!url) {
      const managed = await launchManaged(this.data, { headless: this.headless });
      this.child = managed.child;
      this.conn = await Connection.open(managed.url, 10000);
      this.kind = `OMD's own browser profile${this.headless ? ' (headless)' : ''}`;
      if (failures.length) this.notes.push(`Your browser did not connect (${failures.join('; ')}); using ${this.kind}.`);
    }
    this.conn.on(message => this.event(message));
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
  }

  send(method, params, sessionId, timeoutMs) {
    return this.conn.send(method, params, sessionId, timeoutMs);
  }

  owner(sessionId) {
    for (const tab of this.tabs.values()) if (tab.sessionId === sessionId || tab.frames.has(sessionId)) return tab;
    return null;
  }

  event({ method, params, sessionId }) {
    if (method === 'closed') {
      this.conn = null;
      for (const tab of [...this.tabs.values()]) this.drop(tab);
      return;
    }
    if (method === 'Target.targetCreated') {
      const info = params.targetInfo;
      const opener = [...this.tabs.values()].find(tab => tab.targetId === info.openerId);
      if (info.type === 'page' && opener?.owned && !opener.handoff) {
        const attaching = this.attach(info.targetId, true).catch(() => {});
        this.attaching.add(attaching);
        attaching.finally(() => this.attaching.delete(attaching));
      }
      return;
    }
    if (method === 'Target.targetDestroyed') {
      for (const tab of this.tabs.values()) if (tab.targetId === params.targetId) this.drop(tab);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      for (const tab of this.tabs.values()) {
        if (tab.sessionId === params.sessionId) this.drop(tab);
        else this.forgetFrame(tab, params.sessionId);
      }
      return;
    }
    const tab = sessionId && this.owner(sessionId);
    if (!tab) return;
    if (method === 'Target.attachedToTarget') {
      this.attachFrame(tab, sessionId, params).catch(() => {});
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      for (const [key, context] of tab.worlds) if (key.startsWith(`${sessionId}|`) && context === params.executionContextId) tab.worlds.delete(key);
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      for (const key of [...tab.worlds.keys()]) if (key.startsWith(`${sessionId}|`)) tab.worlds.delete(key);
      return;
    }
    if (method === 'Fetch.requestPaused') {
      if (tab.handoff || this.allowed(params.request.url)) this.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
      else {
        tab.events.push(`blocked by allowlist: ${params.request.url}`);
        this.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
      }
      return;
    }
    if (sessionId !== tab.sessionId) return;
    const at = Date.now();
    switch (method) {
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          tab.url = params.frame.url;
          tab.secretTyped = false;
          if (!tab.handoff && !this.allowed(tab.url)) this.leave(tab).catch(() => {});
          this.changed();
        }
        break;
      case 'Page.frameStartedLoading':
        if (params.frameId === tab.targetId) tab.loading = true;
        break;
      case 'Page.frameStoppedLoading':
        if (params.frameId === tab.targetId) {
          tab.loading = false;
          tab.loadedAt = at;
          if (tab.handoff?.message) this.card(tab).catch(() => {});
        }
        break;
      case 'Page.javascriptDialogOpening': {
        if (!tab.owned || tab.handoff) {
          tab.events.push(`dialog ${params.type} left for the user: ${params.message}`);
          break;
        }
        const accept = params.type === 'alert' || params.type === 'beforeunload';
        tab.events.push(`dialog ${params.type} ${accept ? 'accepted' : 'dismissed'}: ${params.message}`);
        this.send('Page.handleJavaScriptDialog', { accept }, tab.sessionId).catch(() => {});
        break;
      }
      case 'Page.screencastFrame':
        this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, tab.sessionId).catch(() => {});
        if (tab.id === this.current) for (const viewer of this.viewers) viewer.frame(params);
        if (tab.recording && !tab.handoff) {
          const file = join(tab.recording.dir, `${String(tab.recording.frames.length).padStart(6, '0')}.jpg`);
          writeFileSync(file, Buffer.from(params.data, 'base64'));
          tab.recording.frames.push({ file, at: params.metadata.timestamp ?? at / 1000 });
        }
        break;
      case 'Runtime.consoleAPICalled':
        this.log(tab, params.type, params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '));
        break;
      case 'Runtime.exceptionThrown':
        this.log(tab, 'exception', params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
        break;
      case 'Log.entryAdded':
        this.log(tab, params.entry.level, `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
        break;
      case 'Network.requestWillBeSent':
        tab.lastNetwork = at;
        if (params.type !== 'EventSource' && params.type !== 'WebSocket') tab.inflight.add(params.requestId);
        tab.requests.set(params.requestId, { id: params.requestId, method: params.request.method, url: params.request.url, type: params.type, start: at, requestHeaders: params.request.headers, postData: params.request.postData, documentURL: params.documentURL });
        if (tab.requests.size > 1000) tab.requests.delete(tab.requests.keys().next().value);
        break;
      case 'Network.responseReceived': {
        const request = tab.requests.get(params.requestId);
        if (request) Object.assign(request, { status: params.response.status, mimeType: params.response.mimeType, responseHeaders: params.response.headers });
        break;
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        tab.lastNetwork = at;
        tab.inflight.delete(params.requestId);
        const request = tab.requests.get(params.requestId);
        if (request) Object.assign(request, { end: at, size: params.encodedDataLength, failed: params.errorText });
        break;
      }
      case 'Runtime.bindingCalled':
        if (params.name === 'omdBrowseContinue' && tab.handoff) tab.handoff.resolve('continued');
        break;
    }
  }

  log(tab, level, text) {
    tab.console.push({ level, text: String(text).slice(0, 2000) });
    if (tab.console.length > 500) {
      tab.console.shift();
      tab.consoleRead = Math.max(0, tab.consoleRead - 1);
    }
  }

  async attach(targetId, owned) {
    const existing = [...this.tabs.values()].find(tab => tab.targetId === targetId);
    if (existing) return existing;
    const tab = {
      id: `t${this.nextTab++}`, targetId, sessionId: null, owned, url: '', loading: false, loadedAt: Date.now(), lastNetwork: 0,
      inflight: new Set(), requests: new Map(), console: [], consoleRead: 0, events: [], lastUsed: Date.now(), handoff: owned ? null : { resolve: () => {} },
      frames: new Map(), worlds: new Map(), refs: new Map(), refKeys: new Map(), nextRef: 1, lastLines: null, recording: null, cast: '', secretTyped: false,
    };
    this.tabs.set(tab.id, tab);
    try {
      ({ sessionId: tab.sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true }));
    } catch (error) {
      this.tabs.delete(tab.id);
      throw error;
    }
    const sessionId = tab.sessionId;
    await this.enable(tab, sessionId, true);
    const { targetInfo } = await this.conn.send('Target.getTargetInfo', { targetId }, undefined, 5000);
    tab.url = targetInfo.url;
    if (!this.allowed(tab.url)) await this.leave(tab);
    return tab;
  }

  async enable(tab, sessionId, top) {
    const methods = top ? ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'] : ['Page.enable', 'Runtime.enable'];
    try {
      await Promise.all(methods.map(method => this.send(method, {}, sessionId, 5000)));
      if (top) await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
      if (this.allowed.active) {
        if (top) await this.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
        await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document' }] }, sessionId);
      }
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, sessionId).catch(() => {});
    } finally {
      await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  async attachFrame(tab, parentSessionId, { sessionId, targetInfo }) {
    if (targetInfo.type !== 'iframe') {
      await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    tab.frames.set(sessionId, { parent: parentSessionId, frameId: targetInfo.targetId });
    await this.enable(tab, sessionId, false);
  }

  forgetFrame(tab, sessionId) {
    if (!tab.frames.delete(sessionId)) return;
    for (const key of [...tab.worlds.keys()]) if (key.startsWith(`${sessionId}|`)) tab.worlds.delete(key);
  }

  async leave(tab) {
    tab.events.push(`left ${tab.url}: outside OMD_BROWSE_ALLOW`);
    if (tab.owned) await this.send('Page.navigate', { url: 'about:blank' }, tab.sessionId);
    else {
      await this.conn.send('Target.detachFromTarget', { sessionId: tab.sessionId }).catch(() => {});
      this.drop(tab);
    }
  }

  drop(tab) {
    if (tab.handoff) tab.handoff.resolve('tab closed');
    this.tabs.delete(tab.id);
    if (this.current === tab.id) this.current = [...this.tabs.keys()].at(-1) ?? null;
    this.changed();
  }

  async open() {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', background: true });
    const tab = await this.attach(targetId, true);
    this.current = tab.id;
    this.changed();
    return tab;
  }

  find(id) {
    const tab = this.tabs.get(id ?? this.current);
    if (!tab) throw new Error(id ? `No tab ${id}; \`tabs\` lists them` : 'No tab yet; start with `open URL`');
    return tab;
  }

  tab(id) {
    const tab = this.find(id);
    if (tab.handoff) throw new Error(`${tab.id} is with the user; wait for \`ask\` to return`);
    const switched = this.current !== tab.id;
    this.current = tab.id;
    tab.lastUsed = Date.now();
    if (switched) this.changed();
    return tab;
  }

  async settle(tab, started = Date.now()) {
    await sleep(150);
    await Promise.all(this.attaching);
    while (Date.now() - started < 10000) {
      const quiet = tab.inflight.size === 0 && Date.now() - tab.lastNetwork > 300;
      if (!tab.loading && (quiet || Date.now() - tab.loadedAt > 2500)) return;
      await sleep(100);
    }
  }

  async world(tab, sessionId, frameId) {
    const key = `${sessionId}|${frameId}`;
    let context = tab.worlds.get(key);
    if (context) return context;
    ({ executionContextId: context } = await this.send('Page.createIsolatedWorld', { frameId, worldName: WORLD }, sessionId));
    const { exceptionDetails } = await this.send('Runtime.evaluate', { contextId: context, expression: EXTRACT }, sessionId);
    if (exceptionDetails) throw new Error(`Page reader failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    tab.worlds.set(key, context);
    return context;
  }

  async run(tab, sessionId, frameId, expression, byValue = true) {
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.world(tab, sessionId, frameId);
      try {
        const { result, exceptionDetails } = await this.send('Runtime.evaluate', { contextId, expression, returnByValue: byValue, awaitPromise: true }, sessionId, 20000);
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return { result, contextId };
      } catch (error) {
        tab.worlds.delete(`${sessionId}|${frameId}`);
        if (attempt || !/context|Execution/i.test(error.message)) throw error;
      }
    }
  }

  globalRef(tab, sessionId, frameId, contextId, local) {
    const key = `${sessionId}|${contextId}|${local}`;
    let ref = tab.refKeys.get(key);
    if (!ref) {
      ref = tab.nextRef++;
      tab.refKeys.set(key, ref);
      tab.refs.set(ref, { sessionId, frameId, contextId, local });
    }
    return ref;
  }

  async model(tab) {
    return this.frameModel(tab, tab.sessionId, tab.targetId, 0);
  }

  async frameModel(tab, sessionId, frameId, depth) {
    const { result, contextId } = await this.run(tab, sessionId, frameId, '__omd.model()');
    const page = result.value;
    const ref = local => this.globalRef(tab, sessionId, frameId, contextId, local);
    const swap = text => text.replace(/@\{(\d+)\}/g, (_, local) => `@${ref(Number(local))}`);
    const lines = page.lines.map(line => ({ ...line, t: swap(line.t) }));
    page.sections = page.sections.map(section => ({ ...section, title: swap(section.title), ref: ref(section.id) }));
    page.tables = page.tables.map(table => ({ ...table, ref: ref(table.id) }));
    page.links = page.links.map(link => ({ ...link, ref: ref(link.id) }));
    page.controls = page.controls.map(control => ({ ...control, ref: ref(control.id) }));
    page.forms = page.forms.map(form => ({
      ...form, ref: ref(form.id), origin: new URL(page.url).origin,
      submit: form.submit && { ...form.submit, ref: ref(form.submit.id) },
      fields: form.fields.map(field => ({ ...field, ref: ref(field.id), options: field.kind === 'radio' ? field.options.map(option => ({ ...option, ref: ref(option.id) })) : field.options })),
    }));
    if (depth < 3) {
      for (const frame of [...page.frames].reverse()) {
        try {
          const owner = await this.run(tab, sessionId, frameId, `__omd.get(${frame.id})`, false);
          const { node } = await this.send('DOM.describeNode', { objectId: owner.result.objectId }, sessionId);
          if (!node.frameId) continue;
          const child = [...tab.frames].find(([, entry]) => entry.frameId === node.frameId)?.[0] ?? sessionId;
          const inner = await this.frameModel(tab, child, node.frameId, depth + 1);
          const offset = page.tables.length;
          const region = lines[frame.line]?.r ?? '';
          const section = lines[frame.line]?.s ?? 0;
          const renumber = text => text.replace(/ \[s\d+\]$/, '').replace(/\[table (\d+)/g, (_, n) => `[table ${Number(n) + offset}`).replace(/`table (\d+)`/g, (_, n) => `\`table ${Number(n) + offset}\``);
          lines.splice(frame.line + 1, 0, ...inner.lines.map(line => ({ t: `  ${renumber(line.t)}`, r: region, s: section })));
          page.tables.push(...inner.tables);
          page.forms.push(...inner.forms);
          page.links.push(...inner.links);
          page.controls.push(...inner.controls);
          for (const key of Object.keys(page.counts)) page.counts[key] += inner.counts[key];
        } catch {}
      }
    }
    return { ...page, lines };
  }

  async resolve(tab, ref) {
    const entry = tab.refs.get(Number(String(ref).replace(/^@/, '')));
    if (!entry) throw new Error(`Unknown ref ${ref}; run \`cat\` or \`man\` for current refs`);
    if (tab.worlds.get(`${entry.sessionId}|${entry.frameId}`) !== entry.contextId) throw new Error(`${ref} is from a page that has changed; run \`cat\` for current refs`);
    const { result } = await this.send('Runtime.evaluate', { contextId: entry.contextId, expression: `__omd.get(${entry.local})` }, entry.sessionId);
    if (!result.objectId) throw new Error(`${ref} no longer exists`);
    return { ...entry, objectId: result.objectId };
  }

  async call(element, functionDeclaration, args = []) {
    const { result, exceptionDetails } = await this.send('Runtime.callFunctionOn', {
      objectId: element.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true,
    }, element.sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async offset(tab, sessionId) {
    const frame = tab.frames.get(sessionId);
    if (!frame) return { x: 0, y: 0 };
    const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: frame.frameId }, frame.parent);
    const { model } = await this.send('DOM.getBoxModel', { backendNodeId }, frame.parent);
    const outer = await this.offset(tab, frame.parent);
    return { x: outer.x + model.content[0], y: outer.y + model.content[1] };
  }

  async point(tab, element, ref) {
    await this.send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId }, element.sessionId).catch(() => {});
    const { quads } = await this.send('DOM.getContentQuads', { objectId: element.objectId }, element.sessionId).catch(() => ({ quads: [] }));
    const quad = quads.find(q => Math.abs((q[2] - q[0]) * (q[5] - q[1])) > 0);
    if (!quad) throw new Error(`${ref} has no visible box`);
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    let at = element;
    let local = null;
    for (let depth = 0; at && depth < 6; depth++) {
      const check = await this.call(at, COVER, [local]).catch(() => null);
      if (check?.cover) {
        const coverRef = this.globalRef(tab, at.sessionId, at.frameId, at.contextId, check.cover.id);
        throw new Error(`${ref} is covered by @${coverRef} "${check.cover.text}"; deal with that first`);
      }
      if (!check?.point) break;
      local = check.point;
      at = await this.frameOwner(tab, at.sessionId).catch(() => null);
    }
    const shift = await this.offset(tab, element.sessionId);
    return { x: x + shift.x, y: y + shift.y };
  }

  async frameOwner(tab, sessionId) {
    const frame = tab.frames.get(sessionId);
    if (!frame) return null;
    const parentFrame = tab.frames.get(frame.parent)?.frameId ?? tab.targetId;
    const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: frame.frameId }, frame.parent);
    const contextId = await this.world(tab, frame.parent, parentFrame);
    const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId }, frame.parent);
    return { sessionId: frame.parent, frameId: parentFrame, contextId, objectId: object.objectId };
  }

  async mouse(tab, type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : 'left', clickCount: 1, ...extra }, tab.sessionId);
  }

  async click(tab, ref) {
    const element = await this.resolve(tab, ref);
    const { x, y } = await this.point(tab, element, ref);
    await this.mouse(tab, 'mouseMoved', x, y);
    await this.mouse(tab, 'mousePressed', x, y);
    await this.mouse(tab, 'mouseReleased', x, y);
  }

  async hover(tab, ref) {
    const element = await this.resolve(tab, ref);
    const { x, y } = await this.point(tab, element, ref);
    await this.mouse(tab, 'mouseMoved', x, y);
  }

  async originOf(element) {
    return this.call(element, 'function() { return location.origin; }');
  }

  async fill(tab, ref, value, replace = true) {
    const element = await this.resolve(tab, ref);
    if (typeof value === 'function') {
      const text = await value(await this.originOf(element));
      tab.secretTyped = true;
      const done = await this.call(element, `function(text) {
        this.focus();
        if (typeof this.select === 'function') this.select();
        else getSelection().selectAllChildren(this);
        if (this.type !== 'password') this.style.setProperty('-webkit-text-security', 'disc');
        __omd.secret(this);
        return document.activeElement === this && document.execCommand('insertText', false, text);
      }`, [text]);
      if (!done) throw new Error(`${ref} did not take focus, so the secret was not typed`);
      return;
    }
    const text = value;
    await this.call(element, replace
      ? `function() { this.focus(); if (typeof this.select === 'function') this.select(); else { const range = document.createRange(); range.selectNodeContents(this); getSelection().removeAllRanges(); getSelection().addRange(range); } }`
      : 'function() { this.focus(); }');
    if (replace) await this.press(tab, 'Delete');
    if (text) await this.send('Input.insertText', { text }, tab.sessionId);
  }

  async setChecked(tab, ref, on) {
    const element = await this.resolve(tab, ref);
    const checked = await this.call(element, `function() { return this.checked ?? this.getAttribute('aria-checked') === 'true'; }`);
    if (checked !== on) await this.click(tab, ref);
  }

  async choose(tab, ref, wanted) {
    const element = await this.resolve(tab, ref);
    const done = await this.call(element, `function(wanted) {
      const options = [...(this.options ?? [])];
      const want = String(wanted).toLowerCase();
      const option = options.find(o => o.value === wanted || o.label.trim() === wanted) ?? options.find(o => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want) ?? options.find(o => o.label.toLowerCase().includes(want));
      if (!option) return options.map(o => o.label.trim());
      this.value = option.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`, [wanted]);
    if (done !== true) throw new Error(`No option ${JSON.stringify(wanted)} in @${ref}; options: ${done.join(', ')}`);
  }

  async upload(tab, ref, files) {
    const element = await this.resolve(tab, ref);
    await this.send('DOM.setFileInputFiles', { objectId: element.objectId, files }, element.sessionId);
  }

  async focus(tab, ref) {
    await this.call(await this.resolve(tab, ref), 'function() { this.focus(); }');
  }

  async press(tab, combo) {
    const parts = combo === '+' ? ['+'] : combo.split('+');
    const name = parts.pop();
    let modifiers = 0;
    for (const part of parts) {
      if (!MODIFIERS[part]) throw new Error(`Unknown modifier ${part}`);
      modifiers |= MODIFIERS[part];
    }
    const known = KEYS[name];
    if (!known && name.length !== 1) throw new Error(`Unknown key ${name}`);
    const code = known ? known[0] : /[a-z0-9]/i.test(name) ? name.toUpperCase().charCodeAt(0) : 0;
    const text = known ? known[1] : modifiers & 8 ? name.toUpperCase() : name;
    const event = { key: name === 'Space' ? ' ' : name, windowsVirtualKeyCode: code, modifiers };
    const typed = text && !(modifiers & 6);
    await this.send('Input.dispatchKeyEvent', { type: typed ? 'keyDown' : 'rawKeyDown', ...event, ...(typed ? { text } : {}) }, tab.sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, tab.sessionId);
  }

  async scroll(tab, direction) {
    const { cssLayoutViewport: view } = await this.send('Page.getLayoutMetrics', {}, tab.sessionId);
    await this.mouse(tab, 'mouseWheel', view.clientWidth / 2, view.clientHeight / 2, { deltaX: 0, deltaY: (direction === 'up' ? -1 : 1) * view.clientHeight * 0.8 });
  }

  async evaluate(tab, expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10000 }, tab.sessionId, 15000);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result;
  }

  async fetchIn(tab, request) {
    const { result } = await this.run(tab, tab.sessionId, tab.targetId, `(async () => {
      const request = ${JSON.stringify(request)};
      const headers = { ...request.headers };
      for (const name of new URL(request.url).origin === location.origin ? request.csrf : []) {
        const meta = document.querySelector('meta[name="csrf-token"],meta[name="_csrf"],meta[name="csrf_token"],meta[name="xsrf-token"]')?.content;
        const cookie = document.cookie.split('; ').find(c => /^(xsrf-token|csrf-token|csrftoken|_csrf)=/i.test(c))?.split('=').slice(1).join('=');
        const value = meta ?? (cookie && decodeURIComponent(cookie));
        if (value) headers[name] = value;
      }
      const response = await fetch(request.url, { method: request.method, headers, body: request.body, credentials: 'include' });
      return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
    })()`);
    return result.value;
  }

  async body(tab, requestId) {
    const { body, base64Encoded } = await this.send('Network.getResponseBody', { requestId }, tab.sessionId);
    return base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  }

  async card(tab) {
    const { frameTree } = await this.send('Page.getFrameTree', {}, tab.sessionId);
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: CARD_WORLD }, tab.sessionId);
    await this.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: `(() => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px';
        const root = host.attachShadow({ mode: 'closed' });
        const card = document.createElement('div');
        card.style.cssText = 'font:14px system-ui;background:#111;color:#fff;padding:12px 14px;border-radius:10px;box-shadow:0 4px 18px #0006;max-width:340px';
        const text = document.createElement('div');
        text.textContent = ${JSON.stringify(tab.handoff.message)};
        const button = document.createElement('button');
        button.textContent = ${JSON.stringify(tab.handoff.button)};
        button.style.cssText = 'margin-top:10px;padding:6px 14px;border:0;border-radius:6px;background:#4f8cff;color:#fff;font:inherit;cursor:pointer';
        button.addEventListener('click', event => { if (event.isTrusted) { omdBrowseContinue('done'); host.remove(); } });
        card.append(text, button);
        root.append(card);
        document.documentElement.append(host);
      })()`,
    }, tab.sessionId);
  }

  async waitForUser(tab, message, button, timeoutMs, signal) {
    if (signal.aborted) return 'cancelled';
    let finish;
    const outcome = new Promise(resolve => { finish = resolve; });
    tab.handoff = { message, button, resolve: finish };
    this.changed();
    signal.addEventListener('abort', () => finish('cancelled'), { once: true });
    const timer = setTimeout(() => finish('timed out'), timeoutMs);
    try {
      await this.send('Runtime.addBinding', { name: 'omdBrowseContinue', executionContextName: CARD_WORLD }, tab.sessionId);
      await this.conn.send('Target.activateTarget', { targetId: tab.targetId });
      await this.card(tab);
      return await outcome;
    } finally {
      clearTimeout(timer);
      tab.handoff = null;
      this.changed();
    }
  }

  async startRecording(tab) {
    if (tab.recording) throw new Error(`${tab.id} is already recording`);
    const dir = join(this.data, 'recordings', `${tab.id}-${Date.now()}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    tab.recording = { dir, frames: [], started: Date.now() };
    await this.cast(tab);
  }

  async stopRecording(tab) {
    const recording = tab.recording;
    if (!recording) throw new Error(`${tab.id} is not recording`);
    tab.recording = null;
    await this.cast(tab).catch(() => {});
    if (!recording.frames.length) throw new Error('No frames were captured; the tab did not paint while recording');
    const end = Date.now() / 1000;
    const list = recording.frames.map((frame, index) => {
      const next = recording.frames[index + 1]?.at ?? end;
      return `file '${frame.file.replace(/'/g, "'\\''")}'\nduration ${Math.max(0.04, next - frame.at).toFixed(3)}`;
    });
    list.push(`file '${recording.frames.at(-1).file.replace(/'/g, "'\\''")}'`);
    writeFileSync(join(recording.dir, 'frames.txt'), `${list.join('\n')}\n`);
    const output = `${recording.dir}.mp4`;
    const ok = await new Promise(resolve => execFile(process.env.OMD_BROWSE_FFMPEG || 'ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(recording.dir, 'frames.txt'),
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-r', '25', output,
    ], error => resolve(!error)));
    if (!ok) return { path: recording.dir, frames: recording.frames.length, video: false };
    rmSync(recording.dir, { recursive: true, force: true });
    return { path: output, frames: recording.frames.length, video: true, seconds: (Date.now() - recording.started) / 1000 };
  }

  async cast(tab) {
    const live = tab.id === this.current && this.viewers.size > 0;
    const size = tab.recording ? { width: 1280, height: 1280 } : [...this.viewers].reduce((most, viewer) => ({ width: Math.max(most.width, viewer.width), height: Math.max(most.height, viewer.height) }), { width: 320, height: 200 });
    const want = tab.recording || live ? JSON.stringify(size) : '';
    if (want === tab.cast) return;
    if (tab.cast) await this.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {});
    tab.cast = want;
    if (want) await this.send('Page.startScreencast', { format: 'jpeg', quality: tab.recording ? 70 : 60, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }, tab.sessionId);
  }

  async closeOwned(filter = () => true) {
    const closing = [...this.tabs.values()].filter(tab => tab.owned && filter(tab));
    for (const tab of closing) {
      await this.conn?.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      this.drop(tab);
    }
    return closing.length;
  }
}
