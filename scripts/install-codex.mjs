import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile, readFile, lstat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const CODEX_VERSION = '0.163.0';
const hashes = {
  darwin: {
    arm64: '61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10',
    x64: '562a1aea0e5686283a467687d268ae33705f02fd4d40f1bc4110a415c5c1c7b1',
  },
  win32: {
    x64: '901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522',
    arm64: '6bbada389cd1ce26783e837fd9ba4711fb4542f432044f7955139e27e27acfde',
  },
};
export const windowsCodexFiles = Object.freeze([
  'bin/codex.exe', 'bin/codex-code-mode-host.exe', 'codex-package.json', 'codex-path/rg.exe',
  'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe',
  'codex-resources/voice/NOTICE.md', 'codex-resources/voice/bin/codex-voice-host.exe',
  ...['gio-2.0-0', 'glib-2.0-0', 'gmodule-2.0-0', 'gobject-2.0-0', 'gstapp-1.0-0', 'gstapp', 'gstaudio-1.0-0', 'gstaudioconvert', 'gstaudioresample', 'gstbase-1.0-0', 'gstcoreelements', 'gstnet-1.0-0', 'gstopus', 'gstpbutils-1.0-0', 'gstreamer-1.0-0', 'gstrtp-1.0-0', 'gstrtp', 'gstrtpmanager', 'gsttag-1.0-0', 'gstvideo-1.0-0', 'intl-8', 'libffi-8', 'opus', 'pcre2-8', 'vcruntime140', 'z'].map(name => `codex-resources/voice/bin/${name}.dll`),
  ...['LGPL-2.1.txt', 'Opus.txt', 'PCRE2.md', 'libffi.txt', 'proxy-libintl.txt', 'sljit.txt', 'zlib.txt'].map(name => `codex-resources/voice/licenses/${name}`),
  ...['manifest.json', 'runtime.json', 'sources.json', 'windows-crt.json'].map(name => `codex-resources/voice/${name}`),
]);
const execute = promisify(execFile);
const maxArchive = 200 * 1024 * 1024;
const maxBinary = 450 * 1024 * 1024;

export function codexTarget(arch = process.arch, platform = process.platform) {
  if (!hashes[platform]) throw Error('Unsupported Codex platform');
  if (!hashes[platform][arch]) throw Error('Unsupported Codex architecture');
  const machine = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const member = platform === 'win32' ? 'bin/codex.exe' : `codex-${machine}-apple-darwin`;
  const triple = `${machine}-${platform === 'win32' ? 'pc-windows-msvc' : 'apple-darwin'}`;
  const asset = platform === 'win32' ? `codex-package-${triple}` : member;
  return { member, platform, machine: triple, sha256: hashes[platform][arch], url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}.tar.gz` };
}

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function limitBytes(limit) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    done(bytes > limit ? Error('Codex download exceeded size limit') : null, chunk);
  } });
}

async function extractMember({ archive, destination, member, remaining = maxBinary }) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const child = spawn(tar, ['-xOzf', archive, member], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const completion = new Promise((resolveChild, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveChild() : reject(Error('Codex extraction failed')));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    await Promise.all([pipeline(child.stdout, limitBytes(Math.min(maxBinary, remaining)), createWriteStream(temporary, { flags: 'wx', mode: 0o700 })), completion]);
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    clearTimeout(timer);
    child.kill();
    await rm(temporary, { force: true });
  }
}

export async function extractCodexArchive({ archive, destination, member, sha256, platform = 'darwin' }) {
  if (platform !== 'win32' && (platform !== 'darwin' || !/^codex-(aarch64|x86_64)-apple-darwin$/.test(member))) throw Error('Invalid Codex archive member');
  if (platform === 'win32' && (member !== 'bin/codex.exe' || !destination.endsWith(join('bin', 'codex.exe')))) throw Error('Invalid Codex archive destination');
  if (await fileSha256(archive) !== sha256) throw Error('Codex archive integrity check failed');
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const { stdout } = await execute(tar, ['-tzf', archive], { timeout: 30000, maxBuffer: 16384, windowsHide: true });
  const members = platform === 'win32' ? windowsCodexFiles : [member];
  const directories = new Set(members.flatMap(name => name.split('/').slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`)));
  const listed = stdout.trim().split(/\r?\n/);
  const files = listed.filter(name => !directories.has(name));
  const { stdout: types } = await execute(tar, ['-tvzf', archive], { timeout: 30000, maxBuffer: 32768, windowsHide: true });
  if (types.trim().split(/\r?\n/).some(line => !/^[-d]/.test(line))) throw Error('Unexpected Codex archive member types');
  if (files.length !== members.length || new Set(files).size !== members.length || files.some(name => !members.includes(name))) throw Error('Unexpected Codex archive members');
  const root = platform === 'win32' ? dirname(dirname(destination)) : dirname(destination);
  // Only fixed official members stream to files; tar never writes paths, links, or scripts.
  let remaining = 600 * 1024 * 1024;
  for (const name of members) {
    const file = platform === 'win32' ? join(root, name) : destination;
    await extractMember({ archive, destination: file, member: name, remaining });
    remaining -= (await lstat(file)).size;
  }
}

async function verifyWindowsMachine(path, arch) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw Error('Codex Windows binary architecture is invalid');
    const offset = header.readUInt32LE(60);
    const pe = Buffer.alloc(6);
    if (offset > 1024 * 1024 || (await file.read(pe, 0, pe.length, offset)).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== (arch === 'arm64' ? 0xaa64 : 0x8664)) throw Error('Codex Windows binary architecture is invalid');
  } finally { await file.close(); }
}

export async function verifyCodexInstallation(destination, { arch = process.arch, platform = process.platform } = {}) {
  const target = codexTarget(arch, platform);
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
  const entrypoint = platform === 'win32' ? 'bin/codex.exe' : 'codex';
  if (manifest.version !== CODEX_VERSION || manifest.arch !== arch || (manifest.platform || 'darwin') !== platform || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw Error('Bundled Codex version, platform or architecture is invalid');
  const members = platform === 'win32' ? windowsCodexFiles : ['codex'];
  const files = manifest.files || (platform === 'darwin' ? { codex: manifest.sha256 } : {});
  if ((manifest.entrypoint || 'codex') !== entrypoint || Object.keys(files).length !== members.length || members.some(name => !/^[a-f0-9]{64}$/.test(files[name] || '')) || files[entrypoint] !== manifest.sha256) throw Error('Bundled Codex files are invalid');
  if (platform === 'win32') {
    if (manifest.machine !== target.machine) throw Error('Bundled Codex machine is invalid');
    const metadata = JSON.parse(await readFile(join(destination, 'codex-package.json'), 'utf8'));
    if (metadata.layoutVersion !== 1 || metadata.version !== CODEX_VERSION || metadata.target !== target.machine || metadata.variant !== 'codex' || metadata.entrypoint !== entrypoint || metadata.resourcesDir !== 'codex-resources' || metadata.pathDir !== 'codex-path') throw Error('Bundled Codex package metadata is invalid');
  }
  for (const name of members) {
    const file = join(destination, name);
    if (!(await lstat(file)).isFile() || await fileSha256(file) !== files[name]) throw Error('Bundled Codex integrity check failed');
    if (platform === 'win32' && /\.(exe|dll)$/.test(name)) await verifyWindowsMachine(file, arch);
  }
  return join(destination, entrypoint);
}

export async function installCodex({ destination, arch = process.arch, platform = process.platform, archivePath, fetchImpl = fetch } = {}) {
  const target = codexTarget(arch, platform);
  const temporary = await mkdtemp(join(tmpdir(), 'sitecad-codex-'));
  try {
    const archive = archivePath || join(temporary, 'codex.tar.gz');
    if (!archivePath) {
      const response = await fetchImpl(target.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw Error('Official Codex download failed');
      if (Number(response.headers.get('content-length')) > maxArchive) throw Error('Codex download exceeded size limit');
      await pipeline(Readable.fromWeb(response.body), limitBytes(maxArchive), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    }
    const binary = join(destination, platform === 'win32' ? 'bin/codex.exe' : 'codex');
    await extractCodexArchive({ archive, destination: binary, ...target });
    // Digests above are published by GitHub for this exact official OpenAI release asset.
    const members = platform === 'win32' ? windowsCodexFiles : ['codex'];
    const files = Object.fromEntries(await Promise.all(members.map(async name => [name, await fileSha256(join(destination, name))])));
    const manifest = { version: CODEX_VERSION, arch, platform, machine: target.machine, entrypoint: platform === 'win32' ? 'bin/codex.exe' : 'codex', sha256: await fileSha256(binary), files, archiveSha256: target.sha256, source: target.url };
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    await verifyCodexInstallation(destination, { arch, platform });
    return binary;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2] || 'desktop/runtime');
  console.log(await installCodex({ destination, arch: process.argv[3] || process.arch, archivePath: process.argv[4] || undefined, platform: process.argv[5] || process.platform }));
}
