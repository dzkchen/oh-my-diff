const PROPERTIES = ['display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius', 'color',
  'background-color', 'background-image', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'gap',
  'flex-direction', 'justify-content', 'align-items', 'grid-template-columns', 'z-index', 'opacity', 'box-shadow', 'transform', 'overflow'];
const QUIET = ['', 'none', 'normal', 'auto', 'static', 'visible', '0px', 'rgba(0, 0, 0, 0)', 'start', 'stretch'];
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function inspect({ x, y, selector, properties, quiet }) {
  const element = selector ? document.querySelector(selector) : document.elementFromPoint(x, y);
  if (!element) return null;
  const path = [];
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    if (node.id) {
      path.unshift(`${node.localName}#${CSS.escape(node.id)}`);
      break;
    }
    const same = [...(node.parentElement?.children ?? [])].filter(other => other.localName === node.localName);
    path.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
  }
  const tag = node => {
    const html = node.cloneNode(false).outerHTML;
    const end = html.lastIndexOf('</');
    return (end > 0 ? html.slice(0, end) : html).slice(0, 200);
  };
  const ancestors = [];
  for (let node = element.parentElement; node && ancestors.length < 3; node = node.parentElement) ancestors.unshift(tag(node));
  const context = [...ancestors.map((line, depth) => `${'  '.repeat(depth)}${line}`),
    ...(element.previousElementSibling ? [`${'  '.repeat(ancestors.length)}previous: ${tag(element.previousElementSibling)}`] : []),
    `${'  '.repeat(ancestors.length)}[selected element]`,
    ...(element.nextElementSibling ? [`${'  '.repeat(ancestors.length)}next: ${tag(element.nextElementSibling)}`] : [])].join('\n');
  const computed = getComputedStyle(element);
  const styles = Object.fromEntries(properties.map(name => [name, computed.getPropertyValue(name).slice(0, 160)]).filter(([, value]) => !quiet.includes(value)));
  const box = element.getBoundingClientRect();
  return { selector: path.join(' > '), html: element.outerHTML.slice(0, 4000), truncated: element.outerHTML.length > 4000, context, styles,
    box: { x: box.x, y: box.y, width: box.width, height: box.height } };
}

export function locate(map, line, column) {
  const lines = String(map?.mappings ?? '').split(';');
  if (!Array.isArray(map?.sources) || line >= lines.length) return null;
  let source = 0;
  let sourceLine = 0;
  let found = null;
  for (let index = 0; index <= line; index++) {
    let generated = 0;
    for (const segment of lines[index].split(',')) {
      const values = [];
      let value = 0;
      let shift = 0;
      for (const character of segment) {
        const digit = BASE64.indexOf(character);
        if (digit < 0) return null;
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value % 2 ? -(value - 1) / 2 : value / 2);
          value = shift = 0;
        }
      }
      if (!values.length) continue;
      generated += values[0];
      if (values.length < 4) continue;
      source += values[1];
      sourceLine += values[2];
      if (index === line && generated <= column) found = { source, line: sourceLine };
    }
  }
  const name = found && map.sources[found.source];
  return typeof name === 'string' ? { source: `${map.sourceRoot ?? ''}${name}`.slice(0, 200), line: found.line + 1 } : null;
}

async function loadMap(page, header, cache) {
  const url = new URL(header.sourceMapURL, header.sourceURL || page.url()).href;
  if (!cache.has(url)) {
    const comma = url.indexOf(',');
    const text = url.startsWith('data:')
      ? (url.slice(0, comma).endsWith(';base64') ? Buffer.from(url.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(url.slice(comma + 1)))
      : await page.evaluate(href => fetch(href).then(response => (response.ok ? response.text() : null)).catch(() => null), url);
    let map = null;
    try {
      map = text && text.length <= 2_000_000 ? JSON.parse(text) : null;
    } catch {}
    cache.set(url, map);
  }
  return cache.get(url);
}

export async function sourceLocations(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const sheets = new Map();
    cdp.on('CSS.styleSheetAdded', ({ header }) => sheets.set(header.styleSheetId, header));
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return [];
    const { matchedCSSRules = [] } = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const maps = new Map();
    const found = [];
    for (const { rule } of matchedCSSRules.reverse()) {
      const header = sheets.get(rule.styleSheetId);
      const range = rule.selectorList?.selectors?.[0]?.range ?? rule.style?.range;
      if (rule.origin !== 'regular' || !header?.sourceMapURL || !range) continue;
      const inline = header.isInline && range.startLine === header.startLine;
      const position = locate(await loadMap(page, header, maps), range.startLine - (header.isInline ? header.startLine : 0),
        range.startColumn - (inline ? header.startColumn : 0));
      if (position) found.push({ rule: rule.selectorList.text.slice(0, 120), source: `${position.source}:${position.line}` });
      if (found.length === 5) break;
    }
    return found;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function jpeg(shoot, limit) {
  for (const quality of [70, 50, 35, 20]) {
    const image = await shoot(quality);
    if (image.length <= limit) return image;
  }
  return null;
}

export async function capture(page, target) {
  if (target.selector) await page.locator(target.selector).first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  const found = await page.evaluate(inspect, { ...target, properties: PROPERTIES, quiet: QUIET });
  if (!found) return null;
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const x = Math.max(0, Math.floor(found.box.x - 8));
  const y = Math.max(0, Math.floor(found.box.y - 8));
  const width = Math.min(view.width, Math.ceil(found.box.x + found.box.width + 8)) - x;
  const height = Math.min(view.height, Math.ceil(found.box.y + found.box.height + 8)) - y;
  const image = width > 0 && height > 0 ? await jpeg(quality => page.screenshot({ type: 'jpeg', quality, scale: 'css', clip: { x, y, width, height } }), 30_000) : null;
  return { ...found, sources: await sourceLocations(page, found.selector).catch(() => []), crop: image?.toString('base64') ?? null,
    url: page.url().slice(0, 2000), origin: new URL(page.url()).origin, time: new Date().toISOString() };
}
