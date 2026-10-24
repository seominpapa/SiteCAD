import { copyFile, mkdir, readFile, rename, rm, chmod, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileSha256, verifyCodexInstallation } from '../scripts/install-codex.mjs';

export function desktopPaths(dataDir) {
  if (!isAbsolute(dataDir)) throw Error('SiteCAD data path must be absolute');
  return {
    codexHome: join(dataDir, 'codex-home'),
    workspace: join(dataDir, 'workspace'),
    runtime: join(dataDir, 'runtime'),
    secrets: join(dataDir, 'credentials.enc'),
  };
}

export function isAllowedAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname);
  } catch { return false; }
}

export function createSecureStore({ file, safeStorage }) {
  function requireKeychain() {
    if (!safeStorage.isEncryptionAvailable()) throw Error('macOS Keychain is unavailable. Unlock the login keychain and restart SiteCAD.');
  }
  return {
    async read() {
      let encrypted;
      try { encrypted = await readFile(file); }
      catch (cause) { if (cause.code === 'ENOENT') return null; throw Error('SiteCAD credentials could not be read'); }
      requireKeychain();
      try { return JSON.parse(safeStorage.decryptString(encrypted)); }
      catch { throw Error('SiteCAD encrypted credentials could not be opened'); }
    },
    async write(value) {
      requireKeychain();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    },
    async remove() { await rm(file, { force: true }); },
  };
}

export async function installBundledCodex({ sourceDir, destination, arch = process.arch, platform = process.platform }) {
  await verifyCodexInstallation(sourceDir, { arch, platform });
  const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8'));
  const root = dirname(destination);
  const files = manifest.files || { codex: manifest.sha256 };
  // Install the entrypoint last so a failed helper copy leaves the existing runtime executable intact.
  const entrypoint = manifest.entrypoint || 'codex';
  const names = [...Object.keys(files).filter(name => name !== entrypoint), entrypoint];
  for (const name of names) {
    const target = platform === 'win32' ? join(root, name) : destination;
    if (await fileSha256(target).catch(() => null) === files[name]) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(join(sourceDir, name), temporary);
      await chmod(temporary, 0o700);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return platform === 'win32' ? join(root, entrypoint) : destination;
}
