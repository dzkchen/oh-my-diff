import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [program, expected, ...argv] = process.argv.slice(2);
if (createHash('sha256').update(readFileSync(program)).digest('hex') !== expected) throw new Error('Git executable changed');
const hash = createHash('sha256');
const child = spawn(program, argv, { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', bytes => hash.update(bytes));
child.stderr.pipe(process.stderr);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  if (code === 0) console.log(hash.digest('hex'));
  else process.exitCode = code || 1;
});
