import type { Json, LayoutNode } from '../../api.d.ts';

export type Edge = 'left' | 'right' | 'top' | 'bottom' | 'tab';
type Split = 'horizontal' | 'vertical';
export type Group = { tabs: string[] };
type Fork = { split: Split; ratio?: number[]; children: Node[] };
export type Node = string | Fork | Group;
export type Failure = { error: string };

export const WAYS: Record<string, Edge> = { left: 'left', right: 'right', up: 'top', down: 'bottom', tab: 'tab' };
export const PANELS = 6;
export const ID = /^[a-z][a-z0-9_]{0,23}$/;
export const CHILDREN = 4;
const DEPTH = 6;
const LEAVES = 12;
export const REGISTERED = 16;

export const obj = (value: unknown): Record<string, Json> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {});

export const kids = (node: Node): Node[] => (typeof node === 'string' ? [] : 'tabs' in node ? node.tabs : node.children);
export const leaves = (node: Node): string[] => (typeof node === 'string' ? [node] : kids(node).flatMap(leaves));
export const signature = (node: Fork) => node.children.map(child => leaves(child).sort().join(',')).join('|');
export const at = (root: Node, path: number[]): Node => path.reduce((node, index) => kids(node)[index], root);
export const set = (root: Node, path: number[], node: Node): Node => {
  if (!path.length) return node;
  kids(at(root, path.slice(0, -1)))[path[path.length - 1]] = node;
  return root;
};
export const locate = (node: Node, id: string, path: number[] = []): number[] | null => {
  if (node === id) return path;
  for (const [index, child] of kids(node).entries()) {
    const found = locate(child, id, [...path, index]);
    if (found) return found;
  }
  return null;
};
export const orient = (node: Node, narrow: boolean): Node => (!narrow || typeof node === 'string' || 'tabs' in node ? node
  : { ...node, split: leaves(node).includes('chat') ? 'vertical' : 'horizontal', children: node.children.map(child => orient(child, narrow)) });
export const groupsOf = (node: Node): Group[] => (typeof node === 'object' && 'tabs' in node ? [node] : kids(node).flatMap(groupsOf));
export const clone = (node: Node): Node => JSON.parse(JSON.stringify(node)) as Node;
const fail = (error: string): Failure => ({ error });
export const failed = (value: Node | Failure): value is Failure => typeof value === 'object' && 'error' in value;
export const mirror = (node: Node): Node => {
  if (typeof node === 'string' || 'tabs' in node) return node;
  const children = node.children.map(mirror);
  return node.split === 'horizontal'
    ? { split: node.split, ...(node.ratio ? { ratio: [...node.ratio].reverse() } : {}), children: children.reverse() }
    : { ...node, children };
};
export const prune = (node: Node, keep: (id: string) => boolean): Node | null => {
  if (typeof node === 'string') return keep(node) ? node : null;
  if ('tabs' in node) {
    const tabs = node.tabs.filter(keep);
    return tabs.length ? { tabs } : null;
  }
  const children = node.children.map(child => prune(child, keep)).filter((child): child is Node => child !== null);
  if (children.length <= 1) return children[0] ?? null;
  return { split: node.split, ...(node.ratio && children.length === node.children.length ? { ratio: node.ratio } : {}), children };
};
const tidy = (node: Node): Node | null => {
  if (typeof node === 'string') return node;
  if ('tabs' in node) return node.tabs.length ? node : null;
  const children = node.children.map(tidy).filter((child): child is Node => child !== null);
  const flat = children.flatMap(child => (typeof child === 'object' && 'split' in child && child.split === node.split ? child.children : [child]));
  const list = flat.length <= CHILDREN ? flat : children;
  if (list.length <= 1) return list[0] ?? null;
  return { split: node.split, ...(node.ratio?.length === list.length && node.children.length === list.length ? { ratio: node.ratio } : {}), children: list };
};
const remove = (root: Node, id: string): Node | null => {
  const path = locate(root, id);
  if (!path) return root;
  if (!path.length) return null;
  const parent = at(root, path.slice(0, -1)) as Fork | Group;
  const index = path[path.length - 1];
  kids(parent).splice(index, 1);
  if ('split' in parent && parent.ratio) parent.ratio.splice(index, 1);
  if ('tabs' in parent && parent.tabs.length === 1) root = set(root, path.slice(0, -1), parent.tabs[0]);
  return tidy(root);
};
const spread = (ratio: number[] | undefined, count: number, index: number, share: number) => {
  const old = ratio ?? Array.from({ length: count }, () => 1);
  const total = old.reduce((sum, weight) => sum + weight, 0);
  const scaled = old.map(weight => Math.max(1, Math.round(weight * (100 - share) / total)));
  scaled.splice(index, 0, share);
  return scaled;
};
export const insert = (root: Node, id: string, beside: string, edge: Edge, share?: number): Node | Failure => {
  let path = locate(root, beside);
  if (!path) return fail(`${beside} is not shown`);
  const holder = path.length ? at(root, path.slice(0, -1)) : null;
  if (holder && typeof holder === 'object' && 'tabs' in holder) {
    if (edge === 'tab') {
      if (holder.tabs.length >= PANELS) return fail(`tabs hold at most ${PANELS} panels`);
      holder.tabs.splice(path[path.length - 1] + 1, 0, id);
      return root;
    }
    path = path.slice(0, -1);
  }
  if (edge === 'tab') return beside === 'chat' ? fail('the chat cannot hold tabs') : set(root, path, { tabs: [beside, id] });
  const split: Split = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
  const before = edge === 'left' || edge === 'top';
  const outer = path.length ? at(root, path.slice(0, -1)) : null;
  if (outer && typeof outer === 'object' && 'split' in outer && outer.split === split && outer.children.length < CHILDREN) {
    const index = path[path.length - 1] + (before ? 0 : 1);
    if (share) outer.ratio = spread(outer.ratio, outer.children.length, index, share);
    else delete outer.ratio;
    outer.children.splice(index, 0, id);
    return root;
  }
  const target = at(root, path);
  const ratio = share ? { ratio: before ? [share, 100 - share] : [100 - share, share] } : {};
  return set(root, path, { split, ...ratio, children: before ? [id, target] : [target, id] });
};
export const place = (root: Node, id: string, beside: string, edge: Edge, share?: number): Node | Failure => {
  if (id === beside) return fail('a panel cannot move beside itself');
  const rest = remove(clone(root), id);
  if (rest === null || !locate(rest, beside)) return fail(`${beside} is not shown`);
  const placed = insert(rest, id, beside, edge, share);
  return failed(placed) ? placed : tidy(placed) ?? fail('nothing left to show');
};
export const move = (root: Node, id: string, way: string): Node | Failure => {
  const tree = clone(root);
  const path = locate(tree, id);
  if (!path || !path.length) return fail(`${id} is not shown`);
  const parent = at(tree, path.slice(0, -1)) as Fork | Group;
  const index = path[path.length - 1];
  if (way === 'tab') {
    if ('tabs' in parent) return fail(`${id} is already in tabs`);
    const panelsIn = (node?: Node) => (node === undefined ? [] : leaves(node).filter(name => name !== 'chat'));
    const beside = panelsIn(parent.children[index - 1]).at(-1) ?? panelsIn(parent.children[index + 1])[0];
    return beside ? place(tree, id, beside, 'tab') : fail(`no panel next to ${id}`);
  }
  if ('tabs' in parent) {
    const other = parent.tabs.find(name => name !== id) as string;
    return place(tree, id, other, WAYS[way]);
  }
  const split: Split = way === 'left' || way === 'right' ? 'horizontal' : 'vertical';
  const step = way === 'right' || way === 'down' ? 1 : -1;
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const outer = at(tree, path.slice(0, depth));
    const slot = path[depth];
    if (typeof outer === 'string' || 'tabs' in outer || outer.split !== split || !outer.children[slot + step]) continue;
    if (depth === path.length - 1) {
      [outer.children[slot], outer.children[slot + step]] = [outer.children[slot + step], outer.children[slot]];
      if (outer.ratio) [outer.ratio[slot], outer.ratio[slot + step]] = [outer.ratio[slot + step], outer.ratio[slot]];
      return tree;
    }
    if (outer.children.length >= CHILDREN) return fail(`no room to move ${id} ${way}`);
    parent.children.splice(index, 1);
    if (parent.ratio) parent.ratio.splice(index, 1);
    outer.children.splice(slot + (step > 0 ? 1 : 0), 0, id);
    delete outer.ratio;
    return tidy(tree) ?? fail(`${id} is not shown`);
  }
  if (typeof tree === 'object' && 'split' in tree && tree.split === split && tree.children[step > 0 ? tree.children.length - 1 : 0] === id) return fail(`${id} is already at the ${way} edge`);
  const rest = remove(tree, id);
  if (rest === null) return fail(`${id} is not shown`);
  return tidy({ split, children: step > 0 ? [rest, id] : [id, rest] }) ?? fail(`${id} is not shown`);
};
export const swap = (root: Node, first: string, second: string): Node | Failure => {
  const tree = clone(root);
  const [one, two] = [locate(tree, first), locate(tree, second)];
  if (!one || !two) return fail(`${one ? second : first} is not shown`);
  set(tree, one, second);
  return set(tree, two, first);
};
export const parseNode = (value: unknown): Node | Failure => {
  const seen = new Set<string>();
  const walk = (raw: unknown, depth = 1): Node => {
    if (depth > DEPTH + 2 || seen.size >= LEAVES + REGISTERED) throw new Error(`a tree nests at most ${DEPTH + 2} levels and names at most ${LEAVES + REGISTERED} panels`);
    if (typeof raw === 'string') {
      if (raw !== 'chat' && !ID.test(raw)) throw new Error(`invalid panel id ${JSON.stringify(raw).slice(0, 40)}`);
      if (seen.has(raw)) throw new Error(`${raw} appears twice`);
      seen.add(raw);
      return raw;
    }
    const node = obj(raw);
    if (Array.isArray(node.tabs) && Object.keys(node).length === 1) {
      if (!node.tabs.length || node.tabs.length > PANELS || node.tabs.some(tab => typeof tab !== 'string')) throw new Error(`tabs hold 1 to ${PANELS} panel ids`);
      if (node.tabs.includes('chat')) throw new Error('the chat cannot go into tabs');
      return { tabs: node.tabs.map(tab => walk(tab, depth + 1)) as string[] };
    }
    const { split, ratio, children } = node;
    if ((split !== 'horizontal' && split !== 'vertical') || !Array.isArray(children) || Object.keys(node).some(key => !['split', 'ratio', 'children'].includes(key))) {
      throw new Error('a node is "chat", a panel id, {split, children, ratio?} or {tabs}');
    }
    if (children.length < 2 || children.length > CHILDREN) throw new Error(`a split holds 2 to ${CHILDREN} children`);
    if (ratio !== undefined && (!Array.isArray(ratio) || ratio.length !== children.length || ratio.some(weight => !Number.isInteger(weight) || (weight as number) < 1 || (weight as number) > 100))) {
      throw new Error('ratio needs one whole number from 1 to 100 per child');
    }
    return { split, ...(ratio ? { ratio: ratio as number[] } : {}), children: children.map(child => walk(child, depth + 1)) };
  };
  try {
    const node = walk(value);
    return seen.has('chat') ? node : fail('the arrangement needs "chat" once');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return fail(error.message);
  }
};
const measure = (node: LayoutNode, depth = 1): { depth: number; cells: string[] } => {
  const inner = 'tabs' in node ? node.tabs.map(tab => tab.node) : 'children' in node ? node.children : [];
  const parts = inner.map(child => measure(child, depth + 1));
  return { depth: Math.max(depth, ...parts.map(part => part.depth)), cells: 'content' in node ? [node.content] : parts.flatMap(part => part.cells) };
};
export const problem = (layout: LayoutNode): string | null => {
  const { depth, cells } = measure(layout);
  if (depth > DEPTH) return `nested ${depth} levels deep (the host draws ${DEPTH}; the chat counts two)`;
  if (cells.length > LEAVES) return `${cells.length} cells (the host draws ${LEAVES}; the chat counts two)`;
  return new Set(cells).size === cells.length ? null : 'a panel site appears twice';
};
