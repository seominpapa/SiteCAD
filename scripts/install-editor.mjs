import { mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'https://www.opencadstudio.com';
const destination = fileURLToPath(new URL('../vendor/editor/', import.meta.url));
const files = new Map();
const integrity = new Map();
const queue = ['/app/index.html', '/app/ocs-control.js', '/app/locale-labels.json',
  '/app/ocs-parse-worker.js', '/app/fonts/korean.ttf', '/app/supporters.json', '/app/videos.json', '/app/discussions.json'];

async function download(remote) {
  const url = new URL(remote, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/app/')) throw new Error('Unexpected asset origin');
  const relative = path.posix.relative('/app', url.pathname);
  if (!relative || relative.startsWith('..')) throw new Error('Invalid asset path');
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Editor asset ${url.pathname}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = integrity.get(url.pathname);
  if (expected && createHash('sha384').update(bytes).digest('base64') !== expected) {
    throw new Error(`Integrity mismatch: ${url.pathname}`);
  }
  return { url, relative, bytes };
}

await mkdir(destination, { recursive: true });
try {
  await access(path.join(destination, 'manifest.local.json'));
  throw new Error('Editor is already installed. Keep the verified snapshot; remove it explicitly to refresh.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
while (queue.length) {
  const remote = queue.shift();
  if (files.has(remote)) continue;
  const { url, relative, bytes } = await download(remote);
  files.set(url.pathname, { path: relative, source: url.href, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  let localBytes = bytes;
  if (relative === 'index.html') {
    const html = bytes.toString('utf8');
    for (const match of html.matchAll(/<(?:link|script)\b[^>]*>/g)) {
      const asset = match[0].match(/(?:href|src)="([^"]+)"/)?.[1];
      const sri = match[0].match(/integrity="sha384-([^"]+)"/)?.[1];
      if (asset?.startsWith('/app/')) {
        queue.push(asset);
        if (sri) integrity.set(asset, sri);
      }
    }
    for (const match of html.matchAll(/['"](\/app\/[^'"]+\.(?:js|wasm))['"]/g)) queue.push(match[1]);
    // Local prototype owns caching and startup; keep upstream engine and control API unchanged.
    localBytes = Buffer.from(html.replace(/<script>\s*\/\/ Offline support:[\s\S]*?<\/script>/, '')
      .replace(/<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, '')
      .replace('<head>', '<head><script>localStorage.setItem("opencadstudio.automation","1");</script>'));
  }
  if (relative.endsWith('.js')) {
    for (const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) queue.push(new URL(match[1], url).pathname);
    }
    for (const match of bytes.toString('utf8').matchAll(/new URL\(\s*['"]([^'"]+\.(?:js|wasm)(?:\?[^'"]*)?)['"]/g)) {
      queue.push(new URL(match[1], url).pathname);
    }
  }
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, localBytes);
  console.log(`Installed ${relative} (${bytes.length.toLocaleString()} bytes)`);
}
const licenseUrl = 'https://raw.githubusercontent.com/HakanSeven12/OpenCADStudio/86bf75f5016e56597b988871c12938e39e159ca7/LICENSE';
const license = await fetch(licenseUrl, { signal: AbortSignal.timeout(30_000) });
if (!license.ok) throw new Error(`Could not preserve upstream license: ${license.status}`);
await writeFile(path.join(destination, 'LICENSE'), await license.text());
await writeFile(path.join(destination, 'manifest.local.json'), JSON.stringify({
  source: `${origin}/app/`, fetchedAt: new Date().toISOString(),
  note: 'Published distribution snapshot. HTML startup and caching adapted for local hosting; engine files unchanged.',
  files: [...files.values()]
}, null, 2) + '\n');
console.log('OpenCADStudio installed locally. OAuth is handled by the existing Codex CLI.');
