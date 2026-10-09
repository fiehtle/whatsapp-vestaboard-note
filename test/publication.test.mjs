import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../scripts/check-public.mjs', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'public-export-check-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  return {
    write(path, data) { const target = join(cwd, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, data); },
    stage(path) { execFileSync('git', ['add', '--', path], { cwd }); },
    check() { return spawnSync(process.execPath, [checker], { cwd, encoding: 'utf8' }); },
  };
}

test('publication guard examines staged content even when the working copy hides it', t => {
  const f = fixture(t);
  f.write('fixture.txt', new URL('12025550101', 'https://wa.me/').href); f.stage('fixture.txt');
  f.write('fixture.txt', 'Clean unstaged working copy');
  const result = f.check();
  assert.equal(result.status, 1); assert.match(result.stderr, /hardcoded WhatsApp recipient/);
});

test('publication guard rejects images and arbitrary binary payloads', t => {
  const f = fixture(t);
  f.write('preview.png', Buffer.from('89504e470d0a1a0a0000', 'hex')); f.stage('preview.png');
  f.write('payload.txt', Buffer.from([0, 1, 2, 3])); f.stage('payload.txt');
  const result = f.check();
  assert.equal(result.status, 1); assert.match(result.stderr, /preview.png: unreviewed binary/);
  assert.match(result.stderr, /payload.txt: unreviewed binary/);
});

test('only the exact reviewed upstream font is allowed as a binary asset', t => {
  const f = fixture(t); const path = 'assets/fonts/IBMPlexMono-Light.ttf';
  const font = readFileSync(new URL('../assets/fonts/IBMPlexMono-Light.ttf', import.meta.url));
  f.write(path, font); f.stage(path);
  assert.equal(f.check().status, 0);
  f.write(path, Buffer.concat([font, Buffer.from('unreviewed appended data')])); f.stage(path);
  const result = f.check();
  assert.equal(result.status, 1); assert.match(result.stderr, /digest does not match/);
});
