// Shared atomic writes and optimistic locking for local edits and SSH sync.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function canonicalPath(file) {
  file = path.resolve(file);
  try { return fs.realpathSync(file); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(file);
    if (parent === file) throw e;
    return path.join(canonicalPath(parent), path.basename(file));
  }
}

export const digest = (text) => text === null ? null : createHash('sha256').update(text).digest('hex');

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.keyboxx-lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('file is busy: another keyboxx write is in progress (a crashed process may have left a .keyboxx-lock file)');
    throw e;
  }
  try { return fn(); } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, text);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export class ConflictError extends Error {
  constructor(message = 'credentials changed during this operation; retry after reviewing the changes') {
    super(message);
    this.code = 'CONFLICT';
  }
}

export function replaceText(file, text, expected, mode = 0o600) {
  return withLock(file, () => {
    if (digest(readText(file)) !== expected) throw new ConflictError();
    atomicWrite(file, text, mode);
  });
}
