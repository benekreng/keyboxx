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

// Find a key by its name, or by service when only one key has that service.
// Errors list names and purposes so an agent can pick, but never values.
function findKey(creds, query) {
  const exact = creds.get(query);
  if (exact) return exact;
  const q = query.toLowerCase();
  const matches = creds.entries.filter((e) => e.name.toLowerCase() === q || (e.meta.service || '').toLowerCase() === q);
  if (matches.length === 1) return matches[0];
  const describe = (list) => list.map((e) => `  ${e.name}  ${[e.meta.service, e.meta.purpose].filter(Boolean).join(' - ')}`).join('\n');
  if (matches.length > 1) throw new UsageError(`"${query}" matches several keys, use a name:\n${describe(matches)}`);
  throw new UsageError(
    `no key matches "${query}"\navailable:\n${describe(creds.entries) || '  (none)'}\nIf it's missing, ask the user to run: keyboxx add`
  );
}

// Targets look like "KEY" or "VAR=KEY" (write KEY under the variable VAR).
function resolve(creds, targets, as) {
  if (!creds.exists) throw new UsageError(`no credentials file at ${tilde(creds.file)} yet. Add a key with: keyboxx add`);
  if (as && targets.length > 1) throw new UsageError('--as works with a single key only. For several, use VAR=KEY');
  return targets.map((t) => {
    const eq = t.indexOf('=');
    const [varName, query] = eq > 0 ? [t.slice(0, eq), t.slice(eq + 1)] : [as, t];
    const entry = findKey(creds, query);
    const v = varName || entry.name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new UsageError(`"${v}" is not a valid variable name`);
    return { entry, varName: v };
  });
}

function uniqueName(creds, base) {
  let name = base;
  for (let i = 2; creds.get(name); i++) name = `${base}_${i}`;
  return name;
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

  let service = flags.service, purpose = flags.purpose;
  if (interactive) {
    if (!creds.exists) err(`Creating your credentials file at ${tilde(creds.file)}\n`);
    service ??= await ask('Service (e.g. OpenAI)');
    if (!service) throw new UsageError('service is required');
    purpose ??= await ask('Purpose (optional)');
  } else if (!service) {
    throw new UsageError('not a terminal: use --service and pipe the key on stdin, e.g.\n  pbpaste | keyboxx add --service OpenAI --purpose work');
  }
  purpose ||= '';

  // Same service and purpose means replacing that key; anything else is a new key.
  const same = creds.entries.find((e) =>
    (e.meta.service || '').toLowerCase() === service.toLowerCase() && (e.meta.purpose || '').toLowerCase() === purpose.toLowerCase());
  let name = flags.name ?? pos[0];
  if (same && !name) {
    const what = `${service}${purpose ? ` (${purpose})` : ''}`;
    if (!flags.yes) {
      if (!interactive) throw new UsageError(`a key for ${what} already exists. Use --yes to replace it.`);
      if (!(await confirm(`A key for ${what} already exists. Replace it?`, false))) return err('Nothing changed.');
    }
    name = same.name;
  }
  name ??= uniqueName(creds, defaultVarName(service));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError(`"${name}" is not a valid name`);

  const value = interactive ? await askHidden('Key (input hidden): ') : await readStdin();
  if (!value.trim()) throw new UsageError('empty key, nothing saved');

  creds.set(name, value.trim(), { service, purpose });
  creds.save();
  err(`Saved ${service} key (${mask(value.trim())}) as ${name}`);
}

function cmdList({ flags }) {
  const creds = openCredentials(flags);
  const rows = creds.entries.map((e) => ({
    name: e.name, service: e.meta.service || '', purpose: e.meta.purpose || '', preview: mask(e.value),
  }));
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log(`No keys yet in ${tilde(creds.file)}. Add one with: keyboxx add`);
  const cols = ['service', 'purpose', 'preview', 'name'];
  const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => r[c].length))]));
  const fmt = (r) => cols.map((c) => r[c].padEnd(w[c])).join('  ').trimEnd();
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))));
  rows.forEach((r) => console.log(fmt(r)));
  console.log("\nUse: keyboxx pull <service or name> --as <VARIABLE>   (details: keyboxx --help)");
}

function cmdPull({ pos, flags }) {
  if (!pos.length) throw new UsageError('usage: keyboxx pull KEY [--as VAR] [--into FILE]   or   keyboxx pull VAR=KEY...');
  const picks = resolve(openCredentials(flags), pos, flags.as);
  const target = new EnvFile(expandHome(flags.into || '.env'));
  for (const { entry, varName } of picks) {
    const how = target.set(varName, entry.value);
    const from = [entry.meta.service, entry.meta.purpose].filter(Boolean).join(', ') || entry.name;
    console.log(`${how} ${varName} (${from}, ${mask(entry.value)}) in ${tilde(target.file)}`);
  }
  target.save();
  const r = spawnSync('git', ['check-ignore', '-q', target.file], { cwd: path.dirname(target.file), stdio: 'ignore' });
  if (r.status === 1) err(`warning: ${path.basename(target.file)} is not gitignored and could be committed`);
}

function cmdRun({ pos, flags, rest }) {
  if (!pos.length || !rest?.length) throw new UsageError('usage: keyboxx run KEY|VAR=KEY... -- COMMAND [ARGS...]');
  const picks = resolve(openCredentials(flags), pos, flags.as);
  const env = { ...process.env };
  for (const { entry, varName } of picks) env[varName] = entry.value;
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
  const [{ entry: e }] = resolve(openCredentials(flags), pos);
  process.stdout.write(e.value + (process.stdout.isTTY ? '\n' : ''));
}

async function cmdRm({ pos, flags }) {
  if (pos.length !== 1) throw new UsageError('usage: keyboxx rm NAME');
  const creds = openCredentials(flags);
  const [{ entry: e }] = resolve(creds, pos);
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

The user's API keys are in \`keyboxx\`. Never print, echo, cat or grep key values,
and never read .env files or the keyboxx credentials file directly.

When a project needs a key:
1. Find the variable name the project expects (code, README, .env.example).
2. Run \`keyboxx list\` and pick the key by service and purpose.
   If it's unclear which key fits, ask the user.
3. Run \`keyboxx pull <service or name> --as <VARIABLE> --into .env\`
   Several at once: \`keyboxx pull OPENAI_KEY=openai STRIPE_SECRET=stripe\`
4. Or skip the file: \`keyboxx run OPENAI_KEY=openai -- <command>\`

If no key fits, ask the user to add one with \`keyboxx add\`. Never use \`keyboxx get --raw\`.
`;

const HELP = `keyboxx - copy the user's API keys into place without seeing them

AGENTS: how to give a project an API key
  1. Find the variable name the project expects (code, README, .env.example).
  2. keyboxx list
       Shows service, purpose, a masked preview and a name for each key.
       Pick by service and purpose. If it's unclear which key fits, ask the user.
  3. keyboxx pull <KEY> --as <VARIABLE>
       Writes VARIABLE=<value> into ./.env. Prints only a masked preview.
     or: keyboxx run <VARIABLE>=<KEY> -- <command>
       Runs the command with the key set, without writing a file.

  <KEY> is a service like "openai". If one service has several keys,
  use the name from keyboxx list instead.

  Rules: never print, cat or grep key values, .env files or the credentials
  file. Don't use get --raw. If no key fits, ask the user to run: keyboxx add

Examples
  keyboxx pull openai --as OPENAI_KEY
  keyboxx pull OPENAI_KEY=openai STRIPE_SECRET=stripe --into .env.local
  keyboxx run DATABASE_URL=neon -- npm run migrate

All commands
  list [--json]                  keys with service, purpose, masked preview
  pull KEY --as VAR              write a key into ./.env as VAR
  pull VAR=KEY...                same, several keys at once
    --into FILE                  write to FILE instead of ./.env
  run VAR=KEY... -- CMD          run CMD with the keys as env vars
  get KEY --raw                  print a key value (humans only)
  add                            add a key, asks for service, purpose, key (humans only)
  rm KEY                         remove a key
  use PATH                       use an existing dotenv file as the credentials file
  path                           print the credentials file location
  agents                         print instructions for AGENTS.md / CLAUDE.md

Options
  --env-file PATH                use this credentials file for one command
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
