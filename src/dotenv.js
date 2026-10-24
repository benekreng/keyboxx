// Read and edit dotenv files while keeping comments and unrelated lines intact.
//
// Entries can carry metadata as comment lines directly above them:
//   # service: OpenAI
//   # purpose: personal projects
//   OPENAI_API_KEY=sk-...
// The file stays a normal dotenv file that uv, docker compose, etc. can read.

import fs from 'node:fs';
import { canonicalPath, digest, replaceText } from './storage.js';

const ENTRY_RE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s?(.*)$/s;
const META_RE = /^\s*#\s*(service|purpose):\s?(.*)$/is;

function unescapeDouble(s) {
  return s.replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
}

// Find the closing quote, allowing backslash escapes inside double quotes.
function closingQuote(s, q, from) {
  for (let i = from; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) return i;
  }
  return -1;
}

export function parse(text, { strict = false } = {}) {
  const names = new Set();
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) {
      if (strict && lines[i].trim() && !lines[i].trimStart().startsWith('#')) throw new Error('invalid credentials format');
      continue;
    }
    const [, exported, name, rest] = m;
    if (strict && names.has(name)) throw new Error('duplicate credentials name');
    names.add(name);
    const valueStart = i;
    let value;
    const q = rest[0];

    if (q === '"' || q === "'" || q === '`') {
      // Quoted values may span several lines.
      let buf = rest;
      let close = closingQuote(buf, q, 1);
      while (close < 0 && i + 1 < lines.length) {
        buf += '\n' + lines[++i];
        close = closingQuote(buf, q, 1);
      }
      if (strict && (close < 0 || !/^\s*(#.*)?$/s.test(buf.slice(close + 1)))) throw new Error('invalid quoted credentials value');
      const inner = close < 0 ? buf.slice(1) : buf.slice(1, close);
      value = q === '"' ? unescapeDouble(inner) : inner;
    } else {
      value = rest.replace(/\s+#.*$/s, '').trim();
    }

    // Collect "# service:" / "# purpose:" comments right above the entry.
    const meta = {};
    let start = valueStart;
    while (start > 0 && META_RE.test(lines[start - 1])) {
      const [, k, v] = META_RE.exec(lines[start - 1]);
      meta[k.toLowerCase()] ??= v.trim();
      start--;
    }

    entries.push({ name, value, meta, exported: Boolean(exported), start, valueStart, end: i });
  }
  return { lines, entries };
}

// Quote a value so dotenv parsers and `source .env` read it back exactly.
export function formatValue(v) {
  if (/^[A-Za-z0-9_\-.\/:+=@,]*$/.test(v)) return v;
  if (!v.includes("'") && !v.includes('\n')) return `'${v}'`;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$') + '"';
}

export class EnvFile {
  constructor(file) {
    this.file = canonicalPath(file);
    this.exists = fs.existsSync(this.file);
    this.mode = this.exists ? fs.statSync(this.file).mode & 0o777 : 0o600;
    const text = this.exists ? fs.readFileSync(this.file, 'utf8') : null;
    this.originalDigest = digest(text);
    this.#load(text ?? '');
  }

  #load(text) {
    const { lines, entries } = parse(text);
    this.lines = lines;
    this.entries = entries;
  }

  #reparse() {
    this.#load(this.lines.join('\n'));
  }

  get(name) {
    return this.entries.find((e) => e.name === name);
  }

  // Set a value. `meta` (service/purpose) replaces existing metadata when given.
  set(name, value, meta) {
    const all = this.entries.filter((e) => e.name === name);
    const metaLines = meta
      ? Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `# ${k}: ${v}`)
      : [];

    if (all.length === 0) {
      if (metaLines.length && this.lines.length && this.lines[this.lines.length - 1].trim() !== '') {
        this.lines.push('');
      }
      this.lines.push(...metaLines, `${name}=${formatValue(value)}`);
      this.#reparse();
      return 'added';
    }

    // Drop later duplicates (bottom-up so line numbers stay valid), then replace the first.
    for (const dup of all.slice(1).reverse()) this.lines.splice(dup.start, dup.end - dup.start + 1);
    const e = all[0];
    const from = meta ? e.start : e.valueStart;
    const line = `${e.exported ? 'export ' : ''}${name}=${formatValue(value)}`;
    this.lines.splice(from, e.end - from + 1, ...(meta ? metaLines : []), line);
    this.#reparse();
    return 'updated';
  }

  remove(name) {
    const all = this.entries.filter((e) => e.name === name);
    for (const e of all.reverse()) this.lines.splice(e.start, e.end - e.start + 1);
    this.#reparse();
    return all.length > 0;
  }

  save() {
    const text = this.lines.join('\n') + '\n';
    replaceText(this.file, text, this.originalDigest, this.mode);
    this.originalDigest = digest(text);
    this.exists = true;
  }
}

// Short hint to tell keys apart without exposing them.
export function mask(value) {
  if (value.length < 12) return '*'.repeat(Math.min(value.length, 8));
  return `${value.slice(0, 3)}***${value.slice(-4)}`;
}
