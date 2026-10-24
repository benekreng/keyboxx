import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/keyboxx.js', import.meta.url));
const first = '# service: Example\n# purpose: test\nEXAMPLE_API_KEY=test-secret-value-1111\n';
const second = '# service: Example\n# purpose: test\nEXAMPLE_API_KEY=test-secret-value-2222\nOTHER_KEY=second-test-secret\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyboxx-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, 'local'), remote = path.join(root, 'remote'), bin = path.join(root, 'bin');
  for (const dir of [local, remote, bin]) fs.mkdirSync(dir);
  const localFile = path.join(local, 'credentials.env'), remoteFile = path.join(remote, 'credentials.env');
  const log = path.join(root, 'ssh-args.json');
  // A disposable SSH stand-in runs the real protocol receiver with a different
  // KEYBOXX_HOME. No test contacts a host or reads the user's credentials.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeFileSync(process.env.KEYBOXX_TEST_LOG, JSON.stringify(process.argv.slice(2)));
const input = fs.readFileSync(0, 'utf8');
const mode = process.env.KEYBOXX_TEST_MODE;
if (mode === 'fail') {
  console.log('test-secret-value-1111');
  console.error('test-secret-value-2222');
  process.exit(1);
}
if (mode === 'invalid') { console.log('not JSON: test-secret-value-1111'); process.exit(0); }
const request = JSON.parse(input);
if (mode === 'race-remote' && request.op === 'write') fs.writeFileSync(request.file, 'RACE_KEY=raced-test-secret\\n');
if (mode === 'race-local' && request.op === 'read') fs.writeFileSync(process.env.KEYBOXX_TEST_LOCAL_FILE, 'RACE_KEY=raced-test-secret\\n');
const env = { ...process.env, KEYBOXX_HOME: process.env.KEYBOXX_TEST_REMOTE_HOME };
delete env.KEYBOXX_ENV_FILE;
const result = spawnSync(process.execPath, [process.env.KEYBOXX_TEST_CLI, '_sync'], { input, env, encoding: 'utf8' });
if (mode === 'lost-ack' && request.op === 'write') process.exit(1);
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const env = {
    ...process.env, KEYBOXX_HOME: local, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    KEYBOXX_TEST_REMOTE_HOME: remote, KEYBOXX_TEST_CLI: cli, KEYBOXX_TEST_LOG: log,
    KEYBOXX_TEST_LOCAL_FILE: localFile,
  };
  delete env.KEYBOXX_ENV_FILE;
  function run(args, { input, mode, extraEnv = {} } = {}) {
    return spawnSync(process.execPath, [cli, ...args], { input, env: { ...env, KEYBOXX_TEST_MODE: mode ?? '', ...extraEnv }, encoding: 'utf8', timeout: 10_000 });
  }
  function ok(args, options) {
    const result = run(args, options);
    assert.equal(result.status, 0, result.stderr);
    return result;
  }
  return { root, local, remote, localFile, remoteFile, log, run, ok };
}

test('local commands need no remote, SSH, or sync state', (t) => {
  const f = fixture(t);
  f.ok(['add', '--service', 'Example', '--purpose', 'test'], { input: 'test-secret-value-1111' });
  const list = f.ok(['list', '--json']);
  assert.equal(JSON.parse(list.stdout)[0].name, 'EXAMPLE_API_KEY');
  assert.ok(!list.stdout.includes('test-secret-value-1111'));
  const output = path.join(f.root, 'project.env');
  f.ok(['pull', 'example', '--as', 'PROJECT_KEY', '--into', output]);
  assert.equal(fs.readFileSync(output, 'utf8'), 'PROJECT_KEY=test-secret-value-1111\n');
  const run = f.ok(['run', 'PROJECT_KEY=example', '--', process.execPath, '-e', 'process.exit(process.env.PROJECT_KEY === "test-secret-value-1111" ? 0 : 1)']);
  assert.equal(run.stdout, '');
  f.ok(['rm', 'example', '--yes']);
  assert.equal(JSON.parse(f.ok(['list', '--json']).stdout).length, 0);
  assert.deepEqual(fs.readdirSync(f.local), ['credentials.env']);
  assert.equal(fs.existsSync(f.log), false);
});

test('registration is local; push and fetch preserve exact metadata and file contents', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'user@test-host']);
  assert.equal(fs.existsSync(f.log), false);
  assert.equal(fs.existsSync(f.remoteFile), false);
  assert.match(f.ok(['remote', 'list']).stdout, /server.*user@test-host/);
  const pushed = f.ok(['sync', 'push', 'server']);
  assert.ok(!pushed.stdout.includes('test-secret-value-1111'));
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), first);
  assert.equal(fs.statSync(f.remoteFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.local, 'remotes.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.remote, 'remotes.json')), false);
  assert.equal(fs.existsSync(path.join(f.remote, 'sync-state.json')), false);
  assert.match(f.ok(['sync', 'status', 'server']).stdout, /up to date/);
  fs.writeFileSync(f.remoteFile, second);
  assert.match(f.ok(['sync', 'status', 'server']).stdout, /remote changes/);
  f.ok(['sync', 'fetch', 'server']);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), second);
  const args = JSON.parse(fs.readFileSync(f.log, 'utf8'));
  assert.deepEqual(args.slice(-3), ['--', 'user@test-host', 'keyboxx _sync']);
  assert.ok(!args.join(' ').includes('test-secret'));
  f.ok(['remote', 'rm', 'server']);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), second);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), second);
});

test('dry runs and status write neither files nor checkpoints', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'host']);
  f.ok(['sync', 'status', 'server']);
  f.ok(['sync', 'push', 'server', '--dry-run']);
  assert.equal(fs.existsSync(f.remoteFile), false);
  assert.equal(fs.existsSync(path.join(f.local, 'sync-state.json')), false);
  f.ok(['sync', 'push', 'server']);
  fs.writeFileSync(f.remoteFile, second);
  const before = fs.readFileSync(path.join(f.local, 'sync-state.json'), 'utf8');
  f.ok(['sync', 'fetch', 'server', '--dry-run']);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), first);
  assert.equal(fs.readFileSync(path.join(f.local, 'sync-state.json'), 'utf8'), before);
});

test('first transfer refuses a differing nonempty destination until explicitly forced', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  fs.writeFileSync(f.remoteFile, second);
  f.ok(['remote', 'add', 'server', 'host']);
  for (const action of ['push', 'fetch']) {
    const failed = f.run(['sync', action, 'server']);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /destination has changes/);
    assert.ok(!failed.stderr.includes('test-secret'));
  }
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), second);
  assert.equal(f.run(['sync', 'push', 'server', '--force=false']).status, 2);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), second);
  f.ok(['sync', 'push', 'server', '--force']);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), first);
});

test('tracks changes, refuses conflicting edits, and never resurrects deletions implicitly', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'host']);
  f.ok(['sync', 'push', 'server']);
  fs.writeFileSync(f.localFile, second);
  assert.match(f.ok(['sync', 'status', 'server']).stdout, /local changes/);
  f.ok(['sync', 'push', 'server']);
  fs.writeFileSync(f.remoteFile, first);
  fs.writeFileSync(f.localFile, second + 'THIRD_KEY=third-test-secret\n');
  const status = f.ok(['sync', 'status', 'server']);
  assert.match(status.stdout, /both machines changed/);
  assert.match(status.stdout, /OTHER_KEY/);
  assert.match(status.stdout, /THIRD_KEY/);
  assert.ok(!status.stdout.includes('test-secret'));
  assert.equal(f.run(['sync', 'push', 'server']).status, 1);
  assert.equal(f.run(['sync', 'fetch', 'server']).status, 1);
  f.ok(['sync', 'fetch', 'server', '--force']);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), first);
  // Emptying the destination after a sync is a change, even though an initially
  // empty file would have been a safe first destination.
  fs.writeFileSync(f.remoteFile, '');
  assert.equal(f.run(['sync', 'push', 'server']).status, 1);
  f.ok(['sync', 'fetch', 'server']);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), '');
});

test('missing source never erases the destination, even with force', (t) => {
  const f = fixture(t);
  f.ok(['remote', 'add', 'server', 'host']);
  fs.writeFileSync(f.remoteFile, second);
  assert.equal(f.run(['sync', 'push', 'server', '--force']).status, 1);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), second);
  fs.rmSync(f.remoteFile);
  fs.writeFileSync(f.localFile, first);
  assert.equal(f.run(['sync', 'fetch', 'server', '--force']).status, 1);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), first);
});

test('honors each machine configuration and safely transports custom paths', (t) => {
  const f = fixture(t);
  const alternate = path.join(f.root, "remote spaces '$() ; credentials.env");
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'host', '--remote-file', alternate]);
  f.ok(['sync', 'push', 'server']);
  assert.equal(fs.readFileSync(alternate, 'utf8'), first);
  assert.equal(fs.existsSync(f.remoteFile), false);
  assert.ok(!fs.readFileSync(f.log, 'utf8').includes(alternate));
  const customLocal = path.join(f.root, 'custom-local.env');
  fs.writeFileSync(customLocal, second);
  // A different local source must not inherit the default file's checkpoint.
  assert.equal(f.run(['sync', 'push', 'server', '--env-file', customLocal]).status, 1);
  f.ok(['sync', 'push', 'server', '--env-file', customLocal, '--force']);
  assert.equal(fs.readFileSync(alternate, 'utf8'), second);
  const configuredRemote = path.join(f.root, 'configured-remote.env');
  fs.writeFileSync(path.join(f.remote, 'config.json'), JSON.stringify({ file: configuredRemote }));
  f.ok(['remote', 'add', 'configured', 'host']);
  f.ok(['sync', 'push', 'configured']);
  assert.equal(fs.readFileSync(configuredRemote, 'utf8'), first);
  assert.equal(fs.existsSync(path.join(f.local, 'config.json')), false);
});

test('concurrent destination edits survive even a forced transfer', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'host']);
  const push = f.run(['sync', 'push', 'server', '--force'], { mode: 'race-remote' });
  assert.equal(push.status, 1);
  assert.match(push.stderr, /changed during transfer/);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), 'RACE_KEY=raced-test-secret\n');
  assert.equal(fs.existsSync(path.join(f.local, 'sync-state.json')), false);
  fs.writeFileSync(f.remoteFile, second);
  const fetch = f.run(['sync', 'fetch', 'server', '--force'], { mode: 'race-local' });
  assert.equal(fetch.status, 1);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), 'RACE_KEY=raced-test-secret\n');
});

test('SSH failures and malformed responses never print payloads or advance checkpoints', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'host']);
  for (const mode of ['fail', 'invalid']) {
    const result = f.run(['sync', 'push', 'server'], { mode });
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('test-secret'));
    assert.equal(fs.existsSync(path.join(f.local, 'sync-state.json')), false);
  }
  // A write may succeed remotely even if the acknowledgement is lost. Retrying
  // recognizes the matching snapshot and records the checkpoint safely.
  assert.equal(f.run(['sync', 'push', 'server'], { mode: 'lost-ack' }).status, 1);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), first);
  assert.equal(fs.existsSync(path.join(f.local, 'sync-state.json')), false);
  f.ok(['sync', 'push', 'server']);
  assert.match(f.ok(['sync', 'status', 'server']).stdout, /up to date/);
});

test('invalid credentials and corrupted checkpoints fail closed', (t) => {
  const f = fixture(t);
  f.ok(['remote', 'add', 'server', 'host']);
  for (const text of ['KEY="unterminated', 'KEY=a\nKEY=b\n', 'broken line\n', 'KEY=a\0b\n']) {
    fs.writeFileSync(f.localFile, text);
    assert.equal(f.run(['sync', 'push', 'server']).status, 1);
    assert.equal(fs.existsSync(f.remoteFile), false);
  }
  fs.writeFileSync(f.localFile, first);
  fs.writeFileSync(path.join(f.local, 'sync-state.json'), '{bad JSON: test-secret');
  const result = f.run(['sync', 'push', 'server']);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes('test-secret'));
  assert.equal(fs.existsSync(f.remoteFile), false);
});

test('preserves BOM, Unicode and CRLF bytes through push and fetch', (t) => {
  const f = fixture(t);
  const text = '\uFEFF# service: Example\r\n# purpose: café 🔑\r\nKEY="test-secret-αβγ"\r\n';
  fs.writeFileSync(f.localFile, text);
  f.ok(['remote', 'add', 'server', 'host']);
  f.ok(['sync', 'push', 'server']);
  assert.equal(fs.readFileSync(f.remoteFile, 'utf8'), text);
  const updated = text + 'OTHER=another-test-secret\r\n';
  fs.writeFileSync(f.remoteFile, updated);
  f.ok(['sync', 'fetch', 'server']);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), updated);
});

test('fetch can bootstrap a missing local file without copying the remote config', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, 'remote-custom.env');
  fs.writeFileSync(source, first);
  fs.writeFileSync(path.join(f.remote, 'config.json'), JSON.stringify({ file: source }));
  f.ok(['remote', 'add', 'server', 'host']);
  f.ok(['sync', 'fetch', 'server']);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), first);
  assert.equal(fs.existsSync(path.join(f.local, 'config.json')), false);
});

test('corrupt local or remote path configuration cannot silently select a fallback file', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.localFile, first);
  f.ok(['remote', 'add', 'server', 'host']);
  fs.writeFileSync(path.join(f.local, 'config.json'), '{bad JSON');
  assert.equal(f.run(['sync', 'push', 'server']).status, 1);
  assert.equal(fs.existsSync(f.remoteFile), false);
  // An explicit path can still be used to recover from a broken local config.
  f.ok(['sync', 'push', 'server', '--env-file', f.localFile]);
  fs.rmSync(path.join(f.local, 'config.json'));
  fs.writeFileSync(path.join(f.remote, 'config.json'), JSON.stringify({ file: {} }));
  assert.equal(f.run(['sync', 'fetch', 'server', '--force']).status, 1);
  assert.equal(fs.readFileSync(f.localFile, 'utf8'), first);
});

test('receiver validates protocol and payload without reflecting secrets', (t) => {
  const f = fixture(t);
  for (const request of [
    'test-secret-not-json',
    JSON.stringify({ version: 9, op: 'read', text: 'test-secret' }),
    JSON.stringify({ version: 1, op: 'write', text: first }),
    JSON.stringify({ version: 1, op: 'write', expected: null, text: 'KEY="test-secret' }),
  ]) {
    const result = f.ok(['_sync'], { input: request });
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(!result.stdout.includes('test-secret'));
    assert.equal(fs.existsSync(f.localFile), false);
  }
});
