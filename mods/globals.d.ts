type ByteArray = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array;

declare var console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
};

declare class TextEncoder {
  readonly encoding: 'utf-8';
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

declare var crypto: {
  getRandomValues<T extends ByteArray>(array: T): T;
  randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
  subtle: {
    digest(algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>;
    [method: string]: (...args: any[]) => Promise<any>;
  };
};
