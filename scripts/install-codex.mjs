import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const CODEX_VERSION = '0.163.0';
const hashes = {
  arm64: '61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10',
  x64: '562a1aea0e5686283a467687d268ae33705f02fd4d40f1bc4110a415c5c1c7b1',
};
const execute = promisify(execFile);
const maxArchive = 160 * 1024 * 1024;
const maxBinary = 450 * 1024 * 1024;

export function codexTarget(arch = process.arch) {
  if (!hashes[arch]) throw Error('Unsupported macOS architecture');
  const member = `codex-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  return { member, sha256: hashes[arch], url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${member}.tar.gz` };
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

export async function extractCodexArchive({ archive, destination, member, sha256 }) {
  if (!/^codex-(aarch64|x86_64)-apple-darwin$/.test(member)) throw Error('Invalid Codex archive member');
  if (await fileSha256(archive) !== sha256) throw Error('Codex archive integrity check failed');
  const { stdout } = await execute('/usr/bin/tar', ['-tzf', archive], { timeout: 30000, maxBuffer: 8192 });
  if (stdout.trim() !== member) throw Error('Unexpected Codex archive members');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const child = spawn('/usr/bin/tar', ['-xOzf', archive, member], { stdio: ['ignore', 'pipe', 'ignore'] });
  const completion = new Promise((resolveChild, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveChild() : reject(Error('Codex extraction failed')));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    await Promise.all([pipeline(child.stdout, limitBytes(maxBinary), createWriteStream(temporary, { flags: 'wx', mode: 0o700 })), completion]);
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    clearTimeout(timer);
    child.kill();
    await rm(temporary, { force: true });
  }
}

export async function installCodex({ destination, arch = process.arch, archivePath, fetchImpl = fetch } = {}) {
  const target = codexTarget(arch);
  const temporary = await mkdtemp(join(tmpdir(), 'sitecad-codex-'));
  try {
    const archive = archivePath || join(temporary, 'codex.tar.gz');
    if (!archivePath) {
      const response = await fetchImpl(target.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw Error('Official Codex download failed');
      if (Number(response.headers.get('content-length')) > maxArchive) throw Error('Codex download exceeded size limit');
      await pipeline(Readable.fromWeb(response.body), limitBytes(maxArchive), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    }
    const binary = join(destination, 'codex');
    await extractCodexArchive({ archive, destination: binary, ...target });
    // Digests above are published by GitHub for this exact official OpenAI release asset.
    const manifest = { version: CODEX_VERSION, arch, sha256: await fileSha256(binary), archiveSha256: target.sha256, source: target.url };
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    return binary;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2] || 'desktop/runtime');
  console.log(await installCodex({ destination, arch: process.argv[3] || process.arch, archivePath: process.argv[4] }));
}
