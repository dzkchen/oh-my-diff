const containers = ['box', 'pane', 'dialog'];
const textual = ['text', 'button', 'markdown', 'code'];
const kinds = [...containers, ...textual, 'line', 'input', 'select', 'multiselect', 'list', 'document', 'diff', 'image', 'raster', 'module', 'terminal', 'slot', 'native'];

const flatten = children => [children].flat(Infinity).filter(child => child !== null && child !== undefined && typeof child !== 'boolean');

export const jsx = (tag, props) => {
  if (typeof tag === 'function') return tag(props);
  if (!kinds.includes(tag)) throw new Error(`jsx_unsupported_element: ${String(tag)}`);
  const { children, ...rest } = props;
  const items = flatten(children);
  if (items.length === 0) return { type: tag, ...rest };
  if (containers.includes(tag)) return { type: tag, ...rest, children: items };
  if (textual.includes(tag)) return { type: tag, ...rest, text: items.join('') };
  if (tag === 'line') return { type: tag, ...rest, spans: items.map(item => (typeof item === 'object' ? item : { text: String(item) })) };
  throw new Error(`jsx_children_unsupported: ${tag}`);
};

export const jsxs = jsx;
