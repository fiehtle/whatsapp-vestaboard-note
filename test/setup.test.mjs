import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('secret setup generates independent keys privately, never prints them and refuses replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'note-setup-test-'));
  const script = fileURLToPath(new URL('../scripts/setup-secrets.mjs', import.meta.url));
  try {
    const first = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(first.status, 0);
    const path = join(dir, '.env.local'), contents = await readFile(path, 'utf8');
    const values = Object.fromEntries(contents.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    assert.equal(Buffer.from(values.CONFIG_ENCRYPTION_KEY, 'base64').length, 32);
    for (const name of ['ADMIN_TOKEN', 'CRON_SECRET', 'KAPSO_WEBHOOK_SECRET']) assert.match(values[name], /^[a-f0-9]{64}$/);
    assert.equal(new Set(Object.values(values)).size, 4);
    for (const value of Object.values(values)) assert.ok(!(first.stdout + first.stderr).includes(value));
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const second = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(second.status, 1); assert.equal(await readFile(path, 'utf8'), contents);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
