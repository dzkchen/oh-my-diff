import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ITEM = ['-a', 'omd-browser', '-s', 'omd-browser-vault'];
const USERNAME_FIELDS = ['autocomplete=username', 'autocomplete=email', 'type=email', 'name*=user i', 'name*=email i',
  'name*=login i', 'id*=user i', 'id*=email i', 'id*=login i'].map(attribute => `input[${attribute}]`).join(', ');

export function keychainKey() {
  try {
    return Buffer.from(execFileSync('security', ['find-generic-password', ...ITEM, '-w'], { encoding: 'utf8', stdio: 'pipe' }).trim(), 'hex');
  } catch (error) {
    if (error.status !== 44) throw new Error('vault_key_unavailable: macOS Keychain refused access');
    const key = randomBytes(32);
    execFileSync('security', ['-i'], { input: `add-generic-password ${ITEM.join(' ')} -w ${key.toString('hex')}\n`, stdio: 'pipe' });
    return key;
  }
}

export function openVault(file, loadKey = keychainKey) {
  let key;
  const cipherKey = () => (key ??= loadKey());
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schema: 1, records: [] });
  const write = data => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const seal = (origin, value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cipherKey(), iv).setAAD(Buffer.from(origin));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const unseal = record => {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(record.iv, 'base64')).setAAD(Buffer.from(record.origin));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString());
  };
  return {
    add(origin, username, password) {
      const data = read();
      const id = randomBytes(4).toString('hex');
      data.records.push({ id, origin, ...seal(origin, { username, password }) });
      write(data);
      return id;
    },
    list: () => read().records.map(record => ({ id: record.id, origin: record.origin, username: unseal(record).username })),
    remove(id) {
      const data = read();
      const kept = data.records.filter(record => record.id !== id);
      write({ ...data, records: kept });
      return kept.length < data.records.length;
    },
    get(id) {
      const record = read().records.find(candidate => candidate.id === id);
      return record && { origin: record.origin, ...unseal(record) };
    },
    idsFor: origin => read().records.filter(record => record.origin === origin).map(record => record.id),
  };
}

const originOf = url => (URL.canParse(url) ? new URL(url).origin : null);

export async function fill(page, { origin, username, password }, submit) {
  if (originOf(page.url()) !== origin) return 'vault_origin_mismatch';
  for (const frame of page.frames().filter(candidate => originOf(candidate.url()) === origin)) {
    const secret = frame.locator('input[type=password]').filter({ visible: true }).first();
    const user = frame.locator(USERNAME_FIELDS).filter({ visible: true }).first();
    const [hasSecret, hasUser] = [await secret.count(), await user.count()];
    if (!hasSecret && !hasUser) continue;
    if (hasUser && username) await user.fill(username);
    if (hasSecret) await secret.fill(password);
    if (submit) await (hasSecret ? secret : user).press('Enter');
    return hasSecret ? 'filled' : 'filled_username_only';
  }
  return 'no_login_fields';
}
