import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const MAX_BYTES = 5_000_000;
const CDN = 'https://cdn.jsdelivr.net/npm/';
const LANGUAGES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml',
  yaml: 'yaml', toml: 'ini', html: 'xml', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', php: 'php', lua: 'lua',
};
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const QUOTE = /^ {0,3}>/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const MATH = /^ {0,3}\$\$/;
const TABLE_RULE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const INIT = `if (window.hljs) hljs.highlightAll();
if (window.renderMathInElement) renderMathInElement(document.body, { delimiters: [{ left: '\\\\[', right: '\\\\]', display: true }, { left: '\\\\(', right: '\\\\)', display: false }], throwOnError: false });
if (window.mermaid) { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' }); mermaid.run(); }
if (document.body.dataset.watch) { scrollTo(0, Number(sessionStorage.getItem('omd-preview-scroll')) || 0); setInterval(() => { sessionStorage.setItem('omd-preview-scroll', scrollY); location.reload(); }, 2000); }`;
const STYLE = `:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa;--accent:#0969da}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--border:#3d444d;--code:#151b23;--accent:#4493f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:920px;margin:0 auto;padding:2rem 1.5rem}header{color:var(--muted);font-size:.85em;margin-bottom:1.5rem}
a{color:var(--accent)}h1,h2{border-bottom:1px solid var(--border);padding-bottom:.3em}img{max-width:100%}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:88%}:not(pre)>code{background:var(--code);padding:.2em .4em;border-radius:6px}
pre{background:var(--code);padding:1rem;border-radius:6px;overflow:auto}pre code.hljs{background:none;padding:0}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--border);padding:6px 13px}
pre.mermaid{background:none;text-align:center}.math{overflow-x:auto}li>input{margin-right:.4em}`;
const ASSETS = {
  code: [
    ['style', '@highlightjs/cdn-assets@11.12.0/styles/github.min.css', 'sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L', '(prefers-color-scheme: light)'],
    ['style', '@highlightjs/cdn-assets@11.12.0/styles/github-dark.min.css', 'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH', '(prefers-color-scheme: dark)'],
    ['script', '@highlightjs/cdn-assets@11.12.0/highlight.min.js', 'sha384-wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix'],
  ],
  math: [
    ['style', 'katex@0.18.10/dist/katex.min.css', 'sha384-rdqqrpVNEfmY6hsVFS50HU5L84tWeMdr4XpF+TJPvLR6e8YxPgRyDzzpawPHMQE6'],
    ['script', 'katex@0.18.10/dist/katex.min.js', 'sha384-oeXTyN/gxEn/v98/oDFW+7XVfZrp59R6Tporzsg2uNs9g+G9Xel/Afxdamc4Mags'],
    ['script', 'katex@0.18.10/dist/contrib/auto-render.min.js', 'sha384-bjyGPfbij8/NDKJhSGZNP/khQVgtHUE5exjm4Ydllo42FwIgYsdLO2lXGmRBf5Mz'],
  ],
  mermaid: [['script', 'mermaid@12.0.0/dist/mermaid.min.js', 'sha384-xzghz1GQ5u9HCpVskeDPqMsdogD1yvuMQbEK53+wi+G70+6J1AG0L2cfi9PHjDWI']],
};

const escape = text => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const indentOf = line => line.length - line.trimStart().length;
const slug = text => text.toLowerCase().replace(/<[^>]*>|[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
const startsBlock = line => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || MATH.test(line);

function safeUrl(url, base) {
  if (/^(https?:|mailto:|#)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  return url.startsWith('/') ? url : base + url;
}

function inline(text, base) {
  const slots = [];
  const hold = html => `\u0000${slots.push(html) - 1}\u0000`;
  const link = (label, url, title, image) => {
    const href = safeUrl(url, base);
    const titled = title ? ` title="${title}"` : '';
    if (image) return href === null ? label : hold(`<img src="${href}" alt="${label}"${titled}>`);
    return href === null ? label : `${hold(`<a href="${href}"${titled}>`)}${label}${hold('</a>')}`;
  };
  return escape(text
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escape(code.replace(/^ ([\s\S]*) $/, '$1'))}</code>`))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => hold(`<span class="math">\\[${escape(tex)}\\]</span>`))
    .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\w$])/g, (_, lead, tex) => lead + hold(`<span class="math">\\(${escape(tex)}\\)</span>`))
    .replace(/\\([\\`*_{}[\]()#+\-.!|~$<>])/g, (_, character) => hold(escape(character))))
    .replace(/!\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+&#34;(.*?)&#34;)?\s*\)/g, (_, alt, url, title) => link(alt, url, title, true))
    .replace(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g, (_, name, heading, label) => link(label ?? name, `${encodeURI(name.trim())}.md${heading ? `#${slug(heading.slice(1))}` : ''}`, '', false))
    .replace(/\[([^\]]+)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+&#34;(.*?)&#34;)?\s*\)/g, (_, label, url, title) => link(label, url, title, false))
    .replace(/&#60;((?:https?|mailto):[^\s&]+)&#62;/g, (_, url) => hold(`<a href="${url}">${url}</a>`))
    .replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]*[^\s<.,;:!?)'"\u0000])/g, (_, lead, url) => `${lead}${hold(`<a href="${url}">${url}</a>`)}`)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(?: {2,}|\\)\n/g, '<br>\n')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => slots[index]);
}

function list(lines, start, base, out) {
  const first = LIST.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST.exec(lines[index]);
    if (!match || match[1].length !== first[1].length || /\d/.test(match[2]) !== ordered) break;
    const column = match[1].length + match[2].length + Math.min(match[3].length || 1, 4);
    const body = [lines[index].slice(column)];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) {
        if (!lines[index + 1]?.trim() || indentOf(lines[index + 1]) < column) break;
        body.push('');
      } else if (indentOf(line) >= column) body.push(line.slice(column));
      else if (LIST.test(line) || startsBlock(line)) break;
      else body.push(line.trim());
    }
    items.push(body);
    while (!lines[index]?.trim() && index + 1 < lines.length && LIST.exec(lines[index + 1])?.[1].length === first[1].length) index += 1;
  }
  const html = items.map(body => {
    const task = /^\[([ xX])\] /.exec(body[0]);
    if (task) body[0] = body[0].slice(4);
    const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}>` : '';
    if (body.some(line => !line.trim())) return `<li>${blocks(body, base).replace(/^(<p>)?/, `$1${box}`)}</li>`;
    const split = body.findIndex((line, position) => position > 0 && startsBlock(line));
    const head = split < 0 ? body : body.slice(0, split);
    return `<li>${box}${inline(head.join('\n'), base)}${split < 0 ? '' : blocks(body.slice(split), base)}</li>`;
  }).join('');
  const number = Number.parseInt(first[2], 10);
  out.push(ordered ? `<ol${number === 1 ? '' : ` start="${number}"`}>${html}</ol>` : `<ul>${html}</ul>`);
  return index;
}

function table(lines, index, base, out) {
  const cells = row => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim());
  const align = cells(lines[index + 1]).map(cell => (cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : cell.startsWith(':') ? 'left' : ''));
  const row = (line, tag) => `<tr>${cells(line).map((cell, column) =>
    `<${tag}${align[column] ? ` style="text-align:${align[column]}"` : ''}>${inline(cell, base)}</${tag}>`).join('')}</tr>`;
  const body = [];
  for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim(); index += 1) body.push(row(lines[index], 'td'));
  out.push(`<table><thead>${row(lines[index - body.length - 2], 'th')}</thead><tbody>${body.join('')}</tbody></table>`);
  return index;
}

function blocks(lines, base) {
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    let match;
    if (!line.trim()) {
      index += 1;
    } else if ((match = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}\\${match[1][0]}{${match[1].length},} *$`);
      const body = [];
      for (index += 1; index < lines.length && !close.test(lines[index]); index += 1) body.push(lines[index]);
      index += 1;
      const code = escape(body.join('\n'));
      out.push(match[2] === 'mermaid' ? `<pre class="mermaid">${code}</pre>` : `<pre><code class="language-${escape(match[2] || 'plaintext')}">${code}</code></pre>`);
    } else if (MATH.test(line)) {
      const body = [line.replace(/^ *\$\$/, '')];
      while (!/\$\$ *$/.test(body.at(-1)) && index + 1 < lines.length) body.push(lines[++index]);
      index += 1;
      out.push(`<div class="math">\\[${escape(body.join('\n').replace(/\$\$ *$/, ''))}\\]</div>`);
    } else if ((match = HEADING.exec(line))) {
      out.push(`<h${match[1].length} id="${slug(match[2] ?? '')}">${inline(match[2] ?? '', base)}</h${match[1].length}>`);
      index += 1;
    } else if (RULE.test(line)) {
      out.push('<hr>');
      index += 1;
    } else if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) body.push(lines[index++].replace(/^ {0,3}> ?/, ''));
      out.push(`<blockquote>${blocks(body, base)}</blockquote>`);
    } else if (LIST.test(line)) {
      index = list(lines, index, base, out);
    } else if (line.includes('|') && lines[index + 1]?.includes('-') && TABLE_RULE.test(lines[index + 1])) {
      index = table(lines, index, base, out);
    } else if (indentOf(line) >= 4) {
      const body = [];
      while (index < lines.length && (indentOf(lines[index]) >= 4 || !lines[index].trim())) body.push(lines[index++].slice(4));
      out.push(`<pre><code class="language-plaintext">${escape(body.join('\n').trimEnd())}</code></pre>`);
    } else {
      const paragraph = [line];
      let level = 0;
      for (index += 1; index < lines.length && lines[index].trim(); index += 1) {
        if (/^ {0,3}=+ *$/.test(lines[index]) || /^ {0,3}-+ *$/.test(lines[index])) {
          level = lines[index].trim()[0] === '=' ? 1 : 2;
          index += 1;
          break;
        }
        if (startsBlock(lines[index])) break;
        paragraph.push(lines[index]);
      }
      const text = paragraph.join('\n').trim();
      out.push(level ? `<h${level} id="${slug(text)}">${inline(text, base)}</h${level}>` : `<p>${inline(text, base)}</p>`);
    }
  }
  return out.join('\n');
}

function page(title, body, watch) {
  const needs = {
    code: /<pre><code/.test(body),
    math: /class="math"/.test(body),
    mermaid: /<pre class="mermaid"/.test(body),
  };
  const assets = Object.entries(ASSETS).filter(([kind]) => needs[kind]).flatMap(([, list]) => list)
    .map(([kind, path, integrity, media]) => (kind === 'style'
      ? `<link rel="stylesheet" href="${CDN}${path}" integrity="${integrity}" crossorigin="anonymous"${media ? ` media="${media}"` : ''}>`
      : `<script src="${CDN}${path}" integrity="${integrity}" crossorigin="anonymous"></script>`)).join('\n');
  const policy = `default-src 'none'; img-src * data: file:; style-src 'unsafe-inline' ${CDN}; font-src ${CDN}; script-src 'sha256-${createHash('sha256').update(INIT).digest('base64')}' ${CDN}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escape(title)}</title>
<style>${STYLE}</style>
${assets}
</head><body${watch ? ' data-watch="1"' : ''}><main><header>${escape(title)} · rendered ${new Date().toLocaleString()}</header>
${body}
</main><script>${INIT}</script></body></html>
`;
}

function renderSource(text, kind, base) {
  if (kind === 'markdown') return blocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), base);
  return `<pre><code class="language-${kind}">${escape(text)}</code></pre>`;
}

function kindOf(path) {
  const extension = extname(path).slice(1).toLowerCase();
  if (!path || ['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  return ['diff', 'patch'].includes(extension) ? 'diff' : LANGUAGES[extension] ?? 'plaintext';
}

const [output, title, watch, source] = process.argv.slice(2);
if (source && statSync(source).size > MAX_BYTES) throw new Error(`${source} exceeds the 5 MB preview limit`);
const base = relative(dirname(resolve(output)), source ? dirname(resolve(source)) : process.cwd());
const html = page(title, renderSource(source ? readFileSync(source, 'utf8') : markdown, kindOf(source ?? ''), base ? `${base}/` : ''), watch === 'watch');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html);
process.stdout.write(resolve(output));
