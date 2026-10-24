import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnvFile, parse } from '../src/dotenv.js';
import { digest, replaceText, withLock } from '../src/storage.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyboxx-storage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'credentials.env');
}

test('a stale local edit cannot overwrite a sync or another local edit', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'KEY=original-test-secret\n');
  const a = new EnvFile(file), b = new EnvFile(file);
  a.set('KEY', 'new-test-secret');
  a.save();
  b.set('OTHER', 'stale-test-secret');
  assert.throws(() => b.save(), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEY=new-test-secret\n');
  a.set('OTHER', 'fresh-test-secret');
  a.save();
  assert.equal(new EnvFile(file).get('OTHER').value, 'fresh-test-secret');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['credentials.env']);
});

test('locking excludes other keyboxx writes and releases locks after failure', (t) => {
  const file = fixture(t);
  withLock(file, () => {
    assert.throws(() => replaceText(file, 'KEY=test\n', null), /file is busy/);
    assert.equal(fs.existsSync(file), false);
  });
  assert.throws(() => withLock(file, () => { throw new Error('test failure'); }), /test failure/);
  replaceText(file, 'KEY=test\n', null);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['credentials.env']);
});

test('symlinked credential paths retain the link and share the same lock identity', (t) => {
  const file = fixture(t), link = file + '.link';
  fs.writeFileSync(file, 'KEY=original\n');
  fs.symlinkSync(file, link);
  const throughLink = new EnvFile(link), direct = new EnvFile(file);
  throughLink.set('KEY', 'updated');
  throughLink.save();
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEY=updated\n');
  direct.set('KEY', 'stale');
  assert.throws(() => direct.save(), { code: 'CONFLICT' });
});

test('sync replacement tightens permissions and detects missing-file changes', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'KEY=old\n', { mode: 0o644 });
  replaceText(file, 'KEY=new\n', digest('KEY=old\n'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => replaceText(file, 'KEY=lost\n', null), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEY=new\n');
});

test('strict sync parsing accepts normal dotenv comments, quoting, and multiline values', () => {
  const text = '# comment\nexport KEY="first\\nsecond" # comment\nOTHER=\'a\nb\'\nDOTTED.KEY=value\n';
  const result = parse(text, { strict: true });
  assert.equal(result.entries[0].value, 'first\nsecond');
  assert.equal(result.entries[1].value, 'a\nb');
  assert.equal(result.entries[2].name, 'DOTTED.KEY');
  // Existing local files retain the permissive parser behavior.
  assert.equal(parse('not dotenv\nKEY="unfinished').entries[0].value, 'unfinished');
});
