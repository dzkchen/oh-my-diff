/** @param {number} opcode @param {Uint8Array} payload @param {boolean} masked */
export function encodeFrame(opcode, payload, masked) {
  const length = payload.length;
  const extended = length < 126 ? Buffer.alloc(0) : Buffer.alloc(length < 65536 ? 2 : 8);
  if (length >= 65536) extended.writeBigUInt64BE(BigInt(length));
  else if (length >= 126) extended.writeUInt16BE(length);
  const head = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127)]);
  if (!masked) return Buffer.concat([head, extended, payload]);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, extended, key, body]);
}

/** @param {(opcode: number, payload: Uint8Array) => void} onMessage @returns {(chunk: Uint8Array) => void} */
export function frameReader(onMessage) {
  const header = Buffer.alloc(14);
  let headerBytes = 0;
  let headerLength = 2;
  let length = 0;
  let parts = [];
  let fragments = [];
  let opcode = 0;
  return chunk => {
    let at = 0;
    while (at < chunk.length) {
      while (headerBytes < headerLength) {
        const count = Math.min(headerLength - headerBytes, chunk.length - at);
        header.set(chunk.subarray(at, at + count), headerBytes);
        headerBytes += count;
        at += count;
        if (headerBytes < headerLength) return;
        if (headerLength === 2) {
          const size = header[1] & 0x7f;
          headerLength += (size === 126 ? 2 : size === 127 ? 8 : 0) + (header[1] & 0x80 ? 4 : 0);
        }
        if (headerBytes === headerLength) {
          const size = header[1] & 0x7f;
          length = size === 126 ? header.readUInt16BE(2) : size === 127 ? Number(header.readBigUInt64BE(2)) : size;
        }
      }
      const count = Math.min(length, chunk.length - at);
      if (count) parts.push(chunk.subarray(at, at + count));
      at += count;
      length -= count;
      if (length) return;
      const key = header[1] & 0x80 ? header.subarray(headerLength - 4, headerLength) : null;
      const payload = parts.length === 1 ? (key ? Buffer.from(parts[0]) : parts[0]) : Buffer.concat(parts);
      if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      const fin = header[0] & 0x80;
      const frameOpcode = header[0] & 0x0f;
      headerBytes = 0;
      headerLength = 2;
      parts = [];
      if (frameOpcode >= 8) {
        onMessage(frameOpcode, payload);
        continue;
      }
      if (frameOpcode) opcode = frameOpcode;
      fragments.push(payload);
      if (fin) {
        onMessage(opcode, fragments.length === 1 ? fragments[0] : Buffer.concat(fragments));
        fragments = [];
      }
    }
  };
}
