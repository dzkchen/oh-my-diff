import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'omd-browse';

export class Secrets {
  constructor(dataDir) {
    this.dir = join(dataDir, 'secrets');
    this.index = join(this.dir, 'index.json');
    this.keychain = platform() === 'darwin' && !process.env.OMD_BROWSE_SECRETS_FILE;
  }

  list() {
    try {
      return JSON.parse(readFileSync(this.index, 'utf8'));
    } catch {
      return {};
    }
  }

  save(list) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.index, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  }

  add(name, origins, value, totp) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('A secret name uses letters, digits, dot, dash and underscore');
    const normalized = origins.map(origin => new URL(origin.includes('://') ? origin : `https://${origin}`).origin);
    if (totp) base32(value);
    if (this.keychain) execFileSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${name} -w "${value.replace(/["\\]/g, '\\$&')}"\n`, stdio: ['pipe', 'ignore', 'ignore'] });
    else {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.dir, name), value, { mode: 0o600 });
      chmodSync(join(this.dir, name), 0o600);
    }
    const list = this.list();
    list[name] = { origins: normalized, totp: !!totp };
    this.save(list);
  }

  remove(name) {
    const list = this.list();
    if (!list[name]) return false;
    if (this.keychain) {
      try {
        execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'ignore' });
      } catch {}
    } else rmSync(join(this.dir, name), { force: true });
    delete list[name];
    this.save(list);
    return true;
  }

  forOrigin(origin) {
    return Object.entries(this.list()).filter(([, entry]) => entry.origins.includes(origin)).map(([name, entry]) => ({ name, ...entry }));
  }

  value(name, origin) {
    const entry = this.list()[name];
    if (!entry) throw new Error(`No secret ${name}; the user adds one with \`omd-browse secret add\``);
    if (!entry.origins.includes(origin)) throw new Error(`Secret ${name} is not for ${origin}`);
    const raw = this.keychain
      ? execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { encoding: 'utf8' }).replace(/\n$/, '')
      : existsSync(join(this.dir, name)) ? readFileSync(join(this.dir, name), 'utf8') : '';
    if (!raw) throw new Error(`Secret ${name} has no stored value`);
    return entry.totp ? totp(raw) : raw;
  }
}

function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('A TOTP seed is base32');
    bits += index.toString(2).padStart(5, '0');
  }
  return Buffer.from(bits.match(/.{8}/g)?.map(byte => parseInt(byte, 2)) ?? []);
}

export function totp(seed, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const hash = createHmac('sha1', base32(seed)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
