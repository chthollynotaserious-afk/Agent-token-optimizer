/**
 * Shared environment detection, DSH probing, backup, and secret-redaction
 * helpers for `uao setup`, `uao doctor`, and `uao uninstall`.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|credential)/i;

/**
 * Redact likely API keys / tokens from strings before printing or logging.
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_KEY]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*(['"]?)[^\s,'";\n]+\2/gi, '$1=[REDACTED]');
}

/**
 * Redact secret-looking environment variable values in an object.
 * @param {Record<string, string | undefined>} env
 */
export function getRedactedEnvPresence(keys = [], env = process.env) {
  const result = {};
  for (const key of keys) {
    const val = env[key];
    result[key] = typeof val === 'string' && val.trim().length > 0 ? 'set' : 'unset';
  }
  return result;
}

/**
 * Execute an external command without shell interpolation.
 * On Windows, `.cmd` / `.bat` wrappers require `cmd.exe /c` or `shell: true`
 * with `spawnSync`, so we only enable `shell` for `.cmd`/`.bat` targets.
 */
export function runCommandSafe(cmd, args = [], { env = process.env, timeout = 15000, cwd = process.cwd() } = {}) {
  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const res = spawnSync(cmd, args, {
    env,
    cwd,
    timeout,
    encoding: 'utf8',
    shell: isWinBatch,
    windowsHide: true,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? res.error.message : null,
  };
}

/**
 * Resolve the DSH CLI executable if available.
 */
export function findDshBinary(explicitBin = null, env = process.env) {
  const candidates = [];
  if (explicitBin) candidates.push(explicitBin);
  if (env.UAO_DSH_BIN) candidates.push(env.UAO_DSH_BIN);
  candidates.push(process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  if (process.platform === 'win32') candidates.push('dsh');

  for (const candidate of candidates) {
    const probe = runCommandSafe(candidate, ['--version'], { env, timeout: 8000 });
    if (probe.status === 0 && probe.stdout) {
      const versionLine = probe.stdout.split(/\r?\n/)[0].trim();
      return {
        found: true,
        bin: candidate,
        version: versionLine,
      };
    }
  }
  return {
    found: false,
    bin: null,
    version: null,
  };
}

/**
 * Probe npm or pnpm version safely.
 */
export function probeToolVersion(name, args = ['--version']) {
  const cmd = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(name) ? `${name}.cmd` : name;
  const res = runCommandSafe(cmd, args, { timeout: 8000 });
  if (res.status === 0 && res.stdout) {
    return { found: true, version: res.stdout.split(/\r?\n/)[0].trim() };
  }
  return { found: false, version: null };
}

/**
 * Resolve DSH home directory without mutating anything.
 */
export function resolveDshHomeDir(explicitHome = null, env = process.env) {
  if (explicitHome) return path.resolve(explicitHome);
  if (env.DSH_HOME && env.DSH_HOME.trim()) return path.resolve(env.DSH_HOME.trim());
  return path.join(os.homedir(), '.dsh');
}

/**
 * List existing DSH profile names under `<dshHome>/profiles` (read-only).
 */
export function listDshProfiles(dshHome) {
  const profilesDir = path.join(dshHome, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];
  try {
    return fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a DSH profile's `package.json` safely.
 */
export function readDshProfileManifest(dshHome, profileName) {
  const pkgPath = path.join(dshHome, 'profiles', profileName, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { exists: false, path: pkgPath, manifest: null, error: null };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { exists: true, path: pkgPath, manifest, error: null };
  } catch (err) {
    return { exists: true, path: pkgPath, manifest: null, error: err.message };
  }
}

/**
 * Validate an HTTP/HTTPS URL.
 */
export function validateHttpUrl(value) {
  if (!value || typeof value !== 'string') return { valid: false, reason: 'empty' };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, reason: `unsupported_protocol:${parsed.protocol}` };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }
}

/**
 * Check if a local TCP host:port is available to bind.
 */
export function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      resolve({ available: false, error: err.code || err.message });
    });
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      server.close(() => resolve({ available: true, port: boundPort }));
    });
  });
}

/**
 * Back up an existing file before modifying or deleting it.
 * @returns {string | null} backup file path, or null if source didn't exist.
 */
export function backupFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.uao-backup-${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Resolve default UAO config path (respects `UAO_CONFIG_PATH`).
 */
export function resolveDefaultConfigPath(explicitPath = null, env = process.env) {
  if (explicitPath) return path.resolve(explicitPath);
  if (env.UAO_CONFIG_PATH && env.UAO_CONFIG_PATH.trim()) return path.resolve(env.UAO_CONFIG_PATH.trim());
  return path.join(os.homedir(), '.uao', 'config.json');
}

export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(key);
}
