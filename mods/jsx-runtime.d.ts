import type { TerminalComponent, TerminalSpan } from './api.js';

type Kind = TerminalComponent['type'];
type Member<K extends Kind> = Extract<TerminalComponent, { type: K }>;
type Many<T> = T | readonly T[];
type Child = TerminalComponent | null | undefined | boolean | readonly Child[];
type TextChild = string | number | boolean | null | undefined;
type LineChild = TerminalSpan | string | boolean | null | undefined;

type Props<K extends Kind, M = Member<K>> =
  'children' extends keyof M ? Omit<M, 'type' | 'children'> & { children?: Child }
  : 'text' extends keyof M ? Omit<M, 'type' | 'text'> & ({ text: string; children?: undefined } | { text?: undefined; children: Many<TextChild> })
  : 'spans' extends keyof M ? Omit<M, 'type' | 'spans'> & ({ spans: TerminalSpan[]; children?: undefined } | { spans?: undefined; children: Many<LineChild> })
  : Omit<M, 'type'> & { children?: never };

export function jsx<K extends Kind>(type: K, props: Props<K>): TerminalComponent;
export function jsx<P>(type: (props: P) => TerminalComponent, props: P): TerminalComponent;
export { jsx as jsxs };

export namespace JSX {
  type Element = TerminalComponent;
  type IntrinsicElements = { [K in Kind]: Props<K> };
  interface ElementChildrenAttribute { children: {} }
}
