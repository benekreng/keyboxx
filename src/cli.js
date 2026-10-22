import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EnvFile, mask } from './dotenv.js';
import { credentialsPath, readConfig, writeConfig, expandHome } from './config.js';
import { ask, askHidden, confirm } from './prompt.js';

const VALUE_FLAGS = new Set(['--into', '--as', '--env-file', '--service', '--purpose', '--name']);
const BOOL_FLAGS = new Set(['--raw', '--json', '--yes', '-y', '--help', '-h']);

class UsageError extends Error {}

function parseArgs(argv) {
  const pos = [], flags = {};
  let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    const [k, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (VALUE_FLAGS.has(k)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${k} needs a value`);
      flags[k.slice(2)] = v;
    } else if (BOOL_FLAGS.has(k)) {
      flags[{ '-y': 'yes', '-h': 'help' }[k] ?? k.slice(2)] = true;
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`unknown option ${a}`);
    } else {
      pos.push(a);
    }
  }
  return { pos, flags, rest };
}

const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
const err = (msg) => process.stderr.write(msg + '\n');

function openCredentials(flags) {
  return new EnvFile(credentialsPath(flags['env-file']));
}

// Look up keys and fail with a helpful message that lists names, never values.
function lookup(creds, names) {
  if (!creds.exists) throw new UsageError(`no credentials file at ${tilde(creds.file)} yet. Add a key with: keyboxx add`);
  const missing = names.filter((n) => !creds.get(n));
  if (missing.length) {
    const have = [...new Set(creds.entries.map((e) => e.name))].join(', ') || '(none)';
    throw new UsageError(`unknown key: ${missing.join(', ')}\navailable: ${have}\nIf it's missing, ask the user to run: keyboxx add`);
  }
  return names.map((n) => creds.get(n));
}

function defaultVarName(service) {
  const base = service.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET';
  const name = /^[0-9]/.test(base) ? `_${base}` : base;
  return /(KEY|TOKEN|SECRET)$/.test(name) ? name : `${name}_API_KEY`;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

// ---------- commands ----------

async function cmdAdd({ pos, flags }) {
  const creds = openCredentials(flags);
  const interactive = process.stdin.isTTY;
  const firstTime = !creds.exists;

  let service = flags.service, purpose = flags.purpose, name = flags.name ?? pos[0];
  if (interactive) {
    if (firstTime) err(`Creating your credentials file at ${tilde(creds.file)}\n`);
    service ??= await ask('Service (e.g. OpenAI)');
    if (!service) throw new UsageError('service is required');
    purpose ??= await ask('Purpose (optional)');
    name ??= await ask('Variable name', defaultVarName(service));
  } else if (!service) {
    throw new UsageError('not a terminal: use --service and pipe the key on stdin, e.g.\n  pbpaste | keyboxx add --service OpenAI --purpose work');
  }
  name ??= defaultVarName(service);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError(`"${name}" is not a valid variable name`);

  const existing = creds.get(name);
  if (existing && !flags.yes) {
    const what = existing.meta.service ? ` (${existing.meta.service})` : '';
    if (!interactive) throw new UsageError(`${name} already exists${what}. Use --yes to replace it.`);
    if (!(await confirm(`${name} already exists${what}. Replace it?`, false))) return err('Nothing changed.');
  }

  const value = interactive ? await askHidden('Key (input hidden): ') : await readStdin();
  if (!value.trim()) throw new UsageError('empty key, nothing saved');

  creds.set(name, value.trim(), { service, purpose });
  creds.save();
  err(`Saved ${name} (${mask(value.trim())}) to ${tilde(creds.file)}`);
}

function cmdList({ flags }) {
  const creds = openCredentials(flags);
  const rows = creds.entries.map((e) => ({
    name: e.name, service: e.meta.service || '', purpose: e.meta.purpose || '', preview: mask(e.value),
  }));
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(`No keys yet in ${tilde(creds.file)}. Add one with: keyboxx add`);
  const cols = ['name', 'service', 'purpose', 'preview'];
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => r[c].length))]));
  const fmt = (r) => cols.map((c) => r[c].padEnd(w[c])).join('  ').trimEnd();
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))));
  rows.forEach((r) => console.log(fmt(r)));
}

function cmdPull({ pos, flags }) {
  if (!pos.length) throw new UsageError('usage: keyboxx pull NAME... [--into FILE] [--as VAR]');
  if (flags.as && pos.length > 1) throw new UsageError('--as works with a single key only');
  const entries = lookup(openCredentials(flags), pos);
  const target = new EnvFile(expandHome(flags.into || '.env'));
  for (const e of entries) {
    const varName = flags.as || e.name;
    const how = target.set(varName, e.value);
    const label = varName === e.name ? varName : `${e.name} as ${varName}`;
    console.log(`${how} ${label} (${mask(e.value)}) in ${tilde(target.file)}`);
  }
  target.save();
  const r = spawnSync('git', ['check-ignore', '-q', target.file], { cwd: path.dirname(target.file), stdio: 'ignore' });
  if (r.status === 1) err(`warning: ${path.basename(target.file)} is not gitignored and could be committed`);
}

function cmdRun({ pos, flags, rest }) {
  if (!pos.length || !rest?.length) throw new UsageError('usage: keyboxx run NAME... -- COMMAND [ARGS...]');
  const entries = lookup(openCredentials(flags), pos);
  const env = { ...process.env };
  for (const e of entries) env[e.name] = e.value;
  const child = spawn(rest[0], rest.slice(1), { stdio: 'inherit', env });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => { err(`keyboxx: could not start ${rest[0]}: ${e.message}`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)));
}

function cmdGet({ pos, flags }) {
  if (pos.length !== 1) throw new UsageError('usage: keyboxx get NAME --raw');
  if (!flags.raw) {
    throw new UsageError(
      'refusing to print a key without --raw.\n' +
      'To put it in a file:   keyboxx pull NAME --into .env\n' +
      'To run a command:      keyboxx run NAME -- your-command'
    );
  }
  const [e] = lookup(openCredentials(flags), pos);
  process.stdout.write(e.value + (process.stdout.isTTY ? '\n' : ''));
}

async function cmdRm({ pos, flags }) {
  if (pos.length !== 1) throw new UsageError('usage: keyboxx rm NAME');
  const creds = openCredentials(flags);
  const [e] = lookup(creds, pos);
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new UsageError('use --yes to confirm removal');
    if (!(await confirm(`Remove ${e.name} (${e.meta.service || 'no service'})?`, false))) return err('Nothing changed.');
  }
  creds.remove(e.name);
  creds.save();
  err(`Removed ${e.name}`);
}

function cmdPath({ flags }) {
  console.log(credentialsPath(flags['env-file']));
}

function cmdUse({ pos }) {
  if (pos.length !== 1) throw new UsageError('usage: keyboxx use PATH ');
  const cfg = readConfig();
  const p = path.resolve(expandHome(pos[0]));
  cfg.file = p;
  writeConfig(cfg);
  err(`keyboxx now uses ${tilde(p)}${fs.existsSync(p) ? '' : ' (will be created on first add)'}`);
}

const AGENT_SNIPPET = `## API keys

API keys are managed with \`keyboxx\`. Never print, echo, cat or grep key values,
and never read .env files or the keyboxx credentials file directly.

- \`keyboxx list\` shows which keys exist (values are masked)
- \`keyboxx pull NAME --into .env\` writes a key into an env file
- \`keyboxx pull NAME --as OTHER_VAR --into .env\` writes it under a different variable name
- \`keyboxx run NAME -- <command>\` runs a command with the key in its environment

Do not use \`keyboxx get --raw\`. If a key is missing, ask the user to add it with \`keyboxx add\`.
`;

const HELP = `keyboxx - hand API keys to agents without them ever seeing the value

Your keys live in one plain dotenv file (see \`keyboxx path\`), so tools like
\`uv run --env-file\` and \`docker compose --env-file\` can read it directly.

For you:
  keyboxx add [NAME]                 add a key (asks for service, purpose, key)
  keyboxx rm NAME                    remove a key
  keyboxx use PATH                   use an existing credentials file
  keyboxx path                       print the credentials file location

For agents (and you):
  keyboxx list [--json]              list keys with masked previews
  keyboxx pull NAME... [--into FILE] [--as VAR]
                                    write keys into an env file (default ./.env)
  keyboxx run NAME... -- CMD         run CMD with the keys set as env vars
  keyboxx get NAME --raw             print a key (only when you really need it)
  keyboxx agents                     print instructions to paste into AGENTS.md / CLAUDE.md

Options:
  --env-file PATH                   use this credentials file for one command
                                    (or set KEYBOXX_ENV_FILE)
`;

const COMMANDS = {
  add: cmdAdd, list: cmdList, ls: cmdList, pull: cmdPull, run: cmdRun, get: cmdGet,
  rm: cmdRm, remove: cmdRm, path: cmdPath, use: cmdUse,
  agents: () => process.stdout.write(AGENT_SNIPPET),
  help: () => process.stdout.write(HELP),
};

export async function main(argv) {
  try {
    const [cmd, ...args] = argv;
    if (!cmd || cmd === '--help' || cmd === '-h') return process.stdout.write(HELP);
    const fn = COMMANDS[cmd];
    if (!fn) throw new UsageError(`unknown command "${cmd}". Run: keyboxx help`);
    const parsed = parseArgs(args);
    if (parsed.flags.help) return process.stdout.write(HELP);
    await fn(parsed);
  } catch (e) {
    if (e.message === 'cancelled') { err('Cancelled.'); process.exit(130); }
    err(`keyboxx: ${e.message}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}
