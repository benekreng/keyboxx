// Optional whole-file replication. No network access outside `sync` commands.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configDir, credentialsPath } from './config.js';
import { parse } from './dotenv.js';
import { atomicWrite, canonicalPath, ConflictError, digest, readText, replaceText, withLock } from './storage.js';

const VERSION = 1;
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_MESSAGE = MAX_TEXT * 6 + 4096; // JSON escaping can expand a character sixfold.
const has = (obj, key) => Object.hasOwn(obj, key);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDigest = (v) => v === null || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));

function jsonFile(name) { return canonicalPath(path.join(configDir(), name)); }

function readJson(file) {
  const text = readText(file);
  if (text === null) return {};
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`invalid keyboxx ${path.basename(file)}; repair it before continuing`);
  }
}

function updateJson(file, update) {
  withLock(file, () => {
    const data = readJson(file);
    update(data);
    atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  });
}

function syncCredentialsPath(flag) {
  const override = flag || process.env.KEYBOXX_ENV_FILE;
  if (override) return credentialsPath(override);
  // Local commands historically tolerate an unreadable config. A replication
  // must not silently switch to a different file when its config is corrupt.
  const config = readJson(jsonFile('config.json'));
  if (has(config, 'file') && (typeof config.file !== 'string' || !config.file || /[\0\r\n]/.test(config.file))) throw new Error('invalid credentials path in config.json');
  return credentialsPath(config.file || path.join(configDir(), 'credentials.env'));
}

function validateText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT || text.includes('\0')) throw new Error('invalid or oversized credentials file');
  parse(text, { strict: true });
}

function snapshot(file) {
  file = canonicalPath(file);
  let text = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT) throw new Error('invalid or oversized credentials file');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
    validateText(text);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { file, text, digest: digest(text) };
}

function validRemote(remote) {
  return isObject(remote) && typeof remote.host === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.@:[\]-]*$/.test(remote.host)
    && (remote.file === undefined || (typeof remote.file === 'string' && remote.file.length > 0 && !/[\0\r\n]/.test(remote.file)));
}

export function cmdRemote({ pos, flags }) {
  const [action = 'list', name, host, ...extra] = pos;
  const file = jsonFile('remotes.json');
  if (action === 'list' && pos.length <= 1) {
    const remotes = readJson(file);
    if (!Object.keys(remotes).length) return console.log('No SSH remotes configured. Local commands work without one.');
    for (const [key, value] of Object.entries(remotes)) {
      if (!validRemote(value)) throw new Error('invalid remote configuration');
      console.log(`${key}  ${value.host}${value.file ? `  ${value.file}` : '  (remote credentials file)'}`);
    }
    return;
  }
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error('usage: keyboxx remote add NAME USER@HOST [--remote-file PATH] | remote rm NAME | remote list');
  if (action === 'add' && host && !extra.length) {
    const remote = { host, ...(flags['remote-file'] ? { file: flags['remote-file'] } : {}) };
    if (!validRemote(remote)) throw new Error('use an SSH host alias or user@host; set ports and jump hosts in ~/.ssh/config');
    updateJson(file, (remotes) => {
      if (has(remotes, name)) throw new Error('remote already exists; remove it before adding a different destination');
      remotes[name] = remote;
    });
    return console.log(`Added SSH remote ${name}. No credentials transferred.`);
  }
  if (action === 'rm' && !host) {
    updateJson(file, (remotes) => {
      if (!has(remotes, name)) throw new Error('unknown SSH remote');
      delete remotes[name];
    });
    return console.log(`Removed SSH remote ${name}. Credentials unchanged.`);
  }
  throw new Error('usage: keyboxx remote add NAME USER@HOST [--remote-file PATH] | remote rm NAME | remote list');
}

async function readMessage(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_MESSAGE) throw new Error('sync message too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new Error('invalid sync message');
  }
}

// Hidden receiver, invoked only by the SSH client. Errors never include payloads.
export async function serveSync() {
  if (process.stdin.isTTY) throw new Error('the sync receiver needs a piped protocol request');
  let result;
  try {
    const request = await readMessage(process.stdin);
    if (!isObject(request) || request.version !== VERSION || !['read', 'write'].includes(request.op)
      || (request.file !== undefined && (typeof request.file !== 'string' || !request.file || /[\0\r\n]/.test(request.file)))) throw new Error('invalid request');
    const file = canonicalPath(syncCredentialsPath(request.file));
    if (request.op === 'read') {
      result = { version: VERSION, ok: true, ...snapshot(file) };
    } else {
      if (!has(request, 'expected') || !isDigest(request.expected)) throw new Error('invalid expected revision');
      validateText(request.text);
      replaceText(file, request.text, request.expected);
      result = { version: VERSION, ok: true, file, digest: digest(request.text) };
    }
  } catch (e) {
    result = { version: VERSION, ok: false, code: e.code === 'CONFLICT' ? 'CONFLICT' : 'FAILED' };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

// A fixed remote command and a piped JSON request avoid shell interpolation of
// paths or secrets. SSH stderr is private too: a broken remote must not echo keys.
export function sshRequest(remote, request) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '--', remote.host, 'keyboxx _sync'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let timedOut = false;
    let response;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    const failure = () => new Error(timedOut ? 'SSH sync timed out; no sync checkpoint saved' : 'SSH sync failed; check SSH login and that a sync-capable keyboxx is on the remote PATH');
    const incoming = readMessage(child.stdout).then((value) => { response = value; }, () => { child.kill('SIGKILL'); });
    child.on('error', () => { clearTimeout(timer); reject(failure()); });
    child.stdin.on('error', () => {}); // An early SSH exit may close stdin.
    child.on('close', async (code) => {
      clearTimeout(timer);
      await incoming;
      if (code !== 0 || !isObject(response) || response.version !== VERSION || typeof response.ok !== 'boolean') return reject(failure());
      if (!response.ok) return reject(response.code === 'CONFLICT' ? new ConflictError('remote credentials changed during transfer; retry after reviewing the changes') : new Error('remote refused sync; check credentials format, permissions, and concurrent writes'));
      resolve(response);
    });
    child.stdin.end(JSON.stringify({ ...request, version: VERSION }));
  });
}

function validateSnapshot(value) {
  if (typeof value.file !== 'string' || /[\0\r\n]/.test(value.file)
    || !(path.posix.isAbsolute(value.file) || path.win32.isAbsolute(value.file)) || !isDigest(value.digest)) throw new Error('invalid remote snapshot');
  if (value.text !== null) validateText(value.text);
  if (digest(value.text) !== value.digest) throw new Error('invalid remote snapshot');
  return value;
}

function changedNames(local, remote) {
  const entries = (text) => new Map(parse(text ?? '').entries.map((e) => [e.name, JSON.stringify([e.value, e.meta])]));
  const a = entries(local.text), b = entries(remote.text);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}

function status(local, remote, base) {
  if (local.digest === remote.digest) return 'up to date';
  if (base === undefined) return 'not yet synced';
  const a = local.digest !== base, b = remote.digest !== base;
  return a && b ? 'both machines changed' : a ? 'local changes' : 'remote changes';
}

export async function cmdSync({ pos, flags }, transport = sshRequest) {
  const [action, name, ...extra] = pos;
  if (!['push', 'fetch', 'status'].includes(action) || !name || extra.length) throw new Error('usage: keyboxx sync push|fetch|status NAME [--dry-run] [--force]');
  const remotes = readJson(jsonFile('remotes.json'));
  if (!has(remotes, name)) throw new Error('unknown SSH remote; add one with: keyboxx remote add NAME USER@HOST');
  const remote = remotes[name];
  if (!validRemote(remote)) throw new Error('invalid remote configuration');
  const local = snapshot(syncCredentialsPath(flags['env-file']));
  const other = validateSnapshot(await transport(remote, { op: 'read', ...(remote.file ? { file: remote.file } : {}) }));
  const stateFile = jsonFile('sync-state.json');
  // Scope checkpoints to both resolved files and the host, not just a friendly name.
  const stateKey = digest(JSON.stringify([local.file, remote.host, other.file]));
  const state = readJson(stateFile);
  const base = has(state, stateKey) ? state[stateKey] : undefined;
  if (base !== undefined && !isDigest(base)) throw new Error('invalid sync checkpoint');
  const changed = changedNames(local, other);
  const summary = `${name}: ${status(local, other, base)}`;
  if (action === 'status') {
    console.log(summary);
    if (changed.length) console.log(`Different keys: ${changed.join(', ')}`);
    else if (local.digest !== other.digest) console.log('File contents or comments differ.');
    return;
  }
  const source = action === 'push' ? local : other;
  const target = action === 'push' ? other : local;
  if (source.text === null) throw new Error(`${action === 'push' ? 'local' : 'remote'} credentials file is missing; nothing transferred`);
  const same = source.digest === target.digest;
  // Missing/empty destinations are safe only on the first transfer. Once a base
  // exists, an emptied destination is an edit (possibly deliberate deletions).
  const conflict = !same && (base === undefined ? target.text !== null && target.text.trim() !== '' : target.digest !== base);
  if (conflict && !flags.force) throw new ConflictError(`${summary}; destination has changes. Review with sync status, then use --force only to replace the entire destination. Different keys: ${changed.join(', ') || '(file contents or comments)'}`);
  if (flags['dry-run']) {
    console.log(`${summary}. Would ${same ? 'record matching files' : `${action === 'push' ? 'send' : 'receive'} ${changed.length} changed key(s) and file metadata`}. Nothing written.`);
    return;
  }
  if (!same) {
    if (action === 'push') {
      const result = await transport(remote, { op: 'write', file: other.file, expected: other.digest, text: local.text });
      if (result.digest !== local.digest || result.file !== other.file) throw new Error('remote did not acknowledge the expected credentials revision');
    } else {
      replaceText(local.file, other.text, local.digest);
    }
  }
  updateJson(stateFile, (checkpoints) => { checkpoints[stateKey] = source.digest; });
  console.log(`${name}: ${same ? 'already matched' : action === 'push' ? 'sent credentials' : 'received credentials'}; sync checkpoint saved.`);
}
