(() => {
  if (globalThis.__omd) return;
  const ids = new Map();
  const els = [];
  const id = el => {
    let n = ids.get(el);
    if (!n) {
      els.push(el);
      n = els.length;
      ids.set(el, n);
    }
    return n;
  };
  const BLOCK = new Set('ADDRESS ARTICLE ASIDE BLOCKQUOTE BODY DD DETAILS DIALOG DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TR UL LEGEND'.split(' '));
  const SKIP = new Set('SCRIPT STYLE NOSCRIPT TEMPLATE SVG CANVAS HEAD META LINK OPTION DATALIST'.split(' '));
  const REGIONS = { NAV: 'nav', HEADER: 'header', FOOTER: 'footer', ASIDE: 'aside', MAIN: 'main' };
  const ROLE_REGIONS = { navigation: 'nav', banner: 'header', contentinfo: 'footer', complementary: 'aside', main: 'main' };
  const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const esc = text => String(text).replace(/@\{/g, '@ {');
  const secret = new WeakSet();

  const visible = el => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };

  const ownText = (label, control) => {
    let text = '';
    const walk = node => {
      if (node === control) return;
      if (node.nodeType === 3) text += ` ${node.data}`;
      else if (node.nodeType === 1 && !['SELECT', 'TEXTAREA', 'INPUT', 'OPTION'].includes(node.tagName)) node.childNodes.forEach(walk);
    };
    walk(label);
    return clean(text);
  };

  const kind = el => {
    const role = el.getAttribute('role');
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || role === 'button' || tag === 'SUMMARY' || (tag === 'INPUT' && ['submit', 'button', 'reset', 'image'].includes(el.type))) return 'button';
    if (tag === 'INPUT') {
      if (el.type === 'hidden') return null;
      if (el.type === 'checkbox' || role === 'switch') return 'checkbox';
      if (el.type === 'radio') return 'radio';
      if (el.type === 'file') return 'file';
      return 'input';
    }
    if (tag === 'TEXTAREA') return 'input';
    if (tag === 'SELECT') return 'select';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'input';
    if (role === 'link') return 'link';
    if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') return 'checkbox';
    if (role === 'radio' || role === 'menuitemradio') return 'radio';
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return 'input';
    if (['tab', 'menuitem', 'option', 'treeitem'].includes(role)) return 'button';
    if (el.tabIndex >= 0 && el.hasAttribute('tabindex') && clean(el.textContent)) return 'button';
    if (['DIV', 'SPAN', 'LI', 'IMG'].includes(tag) && !el.closest('a,button,[role=button]') && getComputedStyle(el).cursor === 'pointer'
      && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer' && (clean(el.textContent) || el.getAttribute('aria-label'))) return 'button';
    return null;
  };

  const label = el => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = clean(by.split(/\s+/).map(ref => document.getElementById(ref)?.textContent ?? '').join(' '));
      if (text) return text;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels?.length) {
      const text = clean([...el.labels].map(l => ownText(l, el)).join(' '));
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      const text = clean(el.innerText ?? el.textContent);
      if (text) return clip(text, 120);
      const img = el.querySelector?.('img[alt]');
      if (img && clean(img.alt)) return clean(img.alt);
    }
    return clean(el.getAttribute('placeholder') || el.title || el.getAttribute('name') || el.getAttribute('data-testid') || '');
  };

  const state = (el, type) => {
    if (type === 'checkbox' || type === 'radio') {
      const on = el.checked ?? el.getAttribute('aria-checked') === 'true';
      return on ? ' on' : ' off';
    }
    if (type === 'select') {
      const chosen = [...el.selectedOptions].map(o => clean(o.label)).join(', ');
      return chosen ? ` =${JSON.stringify(chosen)}` : '';
    }
    if (type === 'input') {
      if (el.type === 'password' || secret.has(el)) return el.value || el.innerText ? ' (filled)' : '';
      const value = el.isContentEditable && !('value' in el) ? clean(el.innerText) : el.value;
      return value ? ` =${JSON.stringify(clip(String(value), 80))}` : '';
    }
    return '';
  };

  const token = el => {
    const type = kind(el);
    const n = id(el);
    let name = label(el);
    if (type === 'link') {
      if (!name) {
        try {
          const url = new URL(el.href);
          name = clean(url.pathname.split('/').filter(Boolean).pop()?.replace(/\.\w+$/, '') || url.hostname);
        } catch {}
      }
      name = esc(clip(name || 'link', 120));
      links.push({ id: n, text: name, href: el.href || el.getAttribute('href') || '' });
      controls.push({ id: n, label: name });
      return `[${name}](@{${n}})`;
    }
    const extra = el.disabled || el.getAttribute('aria-disabled') === 'true' ? ' disabled' : '';
    const typeName = type === 'input' && el.type && !['text', 'textarea'].includes(el.type) && el.tagName === 'INPUT' ? el.type : type;
    name = esc(clip(name, 80));
    controls.push({ id: n, label: name });
    return `[${typeName}: ${name} @{${n}}${esc(state(el, type))}${extra}]`;
  };

  const tables = [];
  const links = [];
  const controls = [];
  const tableData = table => {
    const rows = [...table.rows].map(row => [...row.cells].map(cell => esc(clip(clean(cell.innerText), 300))));
    const head = table.tHead?.rows[0] ?? (table.rows[0] && [...table.rows[0].cells].every(cell => cell.tagName === 'TH') ? table.rows[0] : null);
    const headers = head ? [...head.cells].map(cell => esc(clean(cell.innerText))) : [];
    const body = head ? rows.filter((_, index) => table.rows[index] !== head) : rows;
    return { headers, rows: body };
  };
  const isData = table => table.getAttribute('role') !== 'presentation' && !table.querySelector('table') && !!table.querySelector('th');

  function model() {
    const lines = [];
    const sections = [];
    const frames = [];
    const counts = { links: 0, buttons: 0, fields: 0 };
    tables.length = 0;
    links.length = 0;
    controls.length = 0;
    let buffer = '';
    let prefix = '';
    let region = '';
    let hasMain = false;
    const flush = () => {
      const text = clean(buffer);
      if (text) lines.push({ t: `${prefix}${text}`, r: region, s: sections.length });
      buffer = '';
      prefix = '';
    };
    const push = text => {
      flush();
      lines.push({ t: text, r: region, s: sections.length });
    };
    const walk = (node, listDepth) => {
      if (lines.length > 4000) return;
      if (node.nodeType === 3) {
        buffer += esc(node.data);
        return;
      }
      if (node.nodeType === 11) {
        node.childNodes.forEach(child => walk(child, listDepth));
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName;
      if (SKIP.has(tag) || !visible(el)) return;
      if (tag === 'LABEL' && el.control && visible(el.control)) {
        if (el.contains(el.control)) walk(el.control, listDepth);
        return;
      }
      if (tag === 'SLOT') {
        el.assignedNodes({ flatten: true }).forEach(child => walk(child, listDepth));
        return;
      }
      const type = kind(el);
      if (type) {
        if (type === 'link') counts.links++;
        else if (type === 'button') counts.buttons++;
        else counts.fields++;
        buffer += ` ${token(el)} `;
        return;
      }
      if (/^H[1-6]$/.test(tag) || el.getAttribute('role') === 'heading') {
        const level = Number(tag[1] || el.getAttribute('aria-level') || 2);
        const title = esc(clip(clean(el.innerText), 200));
        if (title) {
          const inner = [...el.querySelectorAll('a[href]')];
          if (inner.length === 1) links.push({ id: id(inner[0]), text: title, href: inner[0].href });
          const suffix = inner.length === 1 ? ` (@{${id(inner[0])}})` : '';
          sections.push({ level, title, line: lines.length + (clean(buffer) ? 1 : 0), id: id(el) });
          push(`${'#'.repeat(level)} ${title}${suffix} [s${sections.length}]`);
          if (inner.length === 1) counts.links++;
          return;
        }
      }
      if (tag === 'IFRAME' || tag === 'FRAME') {
        frames.push({ id: id(el), line: lines.length + (clean(buffer) ? 1 : 0) });
        push(`[frame @{${id(el)}} ${esc(clip(el.src || el.title || '', 120))}]`);
        return;
      }
      if (tag === 'IMG') {
        if (clean(el.alt)) buffer += ` ![${esc(clip(clean(el.alt), 80))}] `;
        return;
      }
      if (tag === 'PRE') {
        push(`\`\`\`\n${esc(clip(el.innerText, 3000))}\n\`\`\``);
        return;
      }
      if (tag === 'TABLE' && isData(el)) {
        const data = tableData(el);
        tables.push({ id: id(el), caption: clean(el.caption?.innerText), ...data });
        const number = tables.length;
        push(`[table ${number}${data.headers.length ? `: ${data.headers.join(' | ')}` : ''} — ${data.rows.length} rows; \`table ${number}\`]`);
        for (const row of data.rows.slice(0, 5)) push(`| ${row.join(' | ')} |`);
        if (data.rows.length > 5) push(`… ${data.rows.length - 5} more rows`);
        return;
      }
      if (tag === 'BR') {
        flush();
        return;
      }
      const roleRegion = REGIONS[tag] ?? ROLE_REGIONS[el.getAttribute('role')];
      const savedRegion = region;
      if (roleRegion && !region) {
        flush();
        region = roleRegion;
        if (roleRegion === 'main') hasMain = true;
      }
      const block = BLOCK.has(tag) || (tag !== 'SPAN' && tag !== 'A' && /^(block|flex|grid|list-item|table)/.test(getComputedStyle(el).display));
      if (block) flush();
      if (tag === 'LI') prefix = `${'  '.repeat(Math.max(0, listDepth - 1))}- `;
      if (tag === 'BLOCKQUOTE') prefix = '> ';
      const depth = tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth;
      if (el.shadowRoot) walk(el.shadowRoot, depth);
      else el.childNodes.forEach(child => walk(child, depth));
      if (block || tag === 'TD' || tag === 'TH') {
        if (tag === 'TD' || tag === 'TH') buffer += ' ';
        else flush();
      }
      if (region !== savedRegion) {
        flush();
        region = savedRegion;
      }
    };
    walk(document.body ?? document.documentElement, 0);
    flush();
    return { title: document.title, url: location.href, lines, sections, frames, tables, links: [...links], controls: [...controls], forms: forms(), counts, hasMain };
  }

  const FIELD = 'input,select,textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox],[role=checkbox],[role=switch],[role=radio]';

  function fieldsOf(container, owned) {
    const out = [];
    const radios = new Map();
    for (const el of container.querySelectorAll(FIELD)) {
      const type = kind(el);
      if (!type || type === 'button' || !visible(el) || (owned && el.form !== owned && el.closest('form') !== owned)) continue;
      if (!owned && el.closest('form')) continue;
      if (type === 'radio' && el.name) {
        let group = radios.get(el.name);
        if (!group) {
          group = { id: id(el), kind: 'radio', label: clean(el.closest('fieldset')?.querySelector('legend')?.innerText) || el.name, name: el.name, options: [] };
          radios.set(el.name, group);
          out.push(group);
        }
        group.options.push({ id: id(el), label: esc(label(el)), value: el.value, checked: el.checked });
        continue;
      }
      const field = { id: id(el), kind: type, type: el.type || '', label: esc(label(el)), name: el.getAttribute('name') || '', placeholder: el.getAttribute('placeholder') || '', required: !!el.required || el.getAttribute('aria-required') === 'true' };
      if (type === 'select') field.options = [...el.options].map(o => clean(o.label));
      if (type === 'checkbox') field.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      else if (type === 'input' && el.type !== 'password' && !secret.has(el)) field.value = el.value ?? '';
      out.push(field);
    }
    return out;
  }

  function submitOf(container) {
    const buttons = [...container.querySelectorAll('button,input[type=submit],input[type=image],[role=button]')].filter(el => visible(el) && kind(el) === 'button');
    const submit = buttons.find(el => (el.type === 'submit' && el.tagName !== 'A')) ?? (buttons.length === 1 ? buttons[0] : null);
    return submit ? { id: id(submit), label: esc(label(submit)) } : null;
  }

  function names(container, submit) {
    const out = [];
    const add = value => {
      const text = clean(value);
      if (text && !/^[\w-]*\d{3,}[\w-]*$/.test(text)) out.push(text);
    };
    add(container.getAttribute('aria-label'));
    const by = container.getAttribute('aria-labelledby');
    if (by) add(document.getElementById(by)?.textContent);
    if (container.getAttribute('role') === 'search' || container.querySelector('input[type=search],[role=searchbox]')) out.push('search');
    add(container.querySelector('legend,h1,h2,h3,h4')?.innerText);
    add(container.getAttribute('name'));
    add(container.id);
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter(h => h.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (headings.length) add(headings.at(-1).innerText);
    if (submit) add(submit.label);
    return out;
  }

  function forms() {
    const out = [];
    for (const form of document.forms) {
      if (!visible(form)) continue;
      const fields = fieldsOf(form, form);
      if (!fields.length) continue;
      const submit = submitOf(form);
      out.push({ id: id(form), names: names(form, submit), fields, submit });
    }
    const loose = [...document.querySelectorAll(FIELD)].filter(el => !el.closest('form') && kind(el) && kind(el) !== 'button' && visible(el));
    const seen = new Set();
    for (const el of loose) {
      let container = el.parentElement;
      for (let up = 0; up < 6 && container && container !== document.body; up++) {
        if (submitOf(container)) break;
        container = container.parentElement;
      }
      if (!container || container === document.body || seen.has(container)) continue;
      seen.add(container);
      const fields = fieldsOf(container, null);
      if (!fields.length) continue;
      const submit = submitOf(container);
      out.push({ id: id(container), names: names(container, submit), fields, submit });
    }
    return out;
  }

  globalThis.__omd = { model, get: n => els[n - 1], id, secret: el => secret.add(el) };
})();
