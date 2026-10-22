// Where the credentials file lives.
// Priority: --env-file flag > KEYBOXX_ENV_FILE > `keyboxx use <path>` setting > default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
  if (process.env.KEYBOXX_HOME) return process.env.KEYBOXX_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'keyboxx');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'keyboxx');
}

const configFile = () => path.join(configDir(), 'config.json');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n');
}

export function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function credentialsPath(flag) {
  const p = flag || process.env.KEYBOXX_ENV_FILE || readConfig().file || path.join(configDir(), 'credentials.env');
  return path.resolve(expandHome(p));
}
