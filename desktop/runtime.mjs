import { copyFile, mkdir, readFile, rename, rm, chmod, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODEX_VERSION, fileSha256 } from '../scripts/install-codex.mjs';

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

export async function installBundledCodex({ sourceDir, destination, arch = process.arch }) {
  const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== CODEX_VERSION || manifest.arch !== arch || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw Error('Bundled Codex version or architecture is invalid');
  if (await fileSha256(join(sourceDir, 'codex')) !== manifest.sha256) throw Error('Bundled Codex integrity check failed');
  const current = await fileSha256(destination).catch(() => null);
  if (current === manifest.sha256) return destination;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(join(sourceDir, 'codex'), temporary);
    await chmod(temporary, 0o700);
    await rename(temporary, destination);
    return destination;
  } finally { await rm(temporary, { force: true }); }
}
