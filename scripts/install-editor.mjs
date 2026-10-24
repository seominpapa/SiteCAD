import { mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const origin = 'https://www.opencadstudio.com';
const destination = fileURLToPath(new URL('../vendor/editor/', import.meta.url));
export function adaptEditorHtml(html, changedAt) {
  return html.replace(/<script>\s*\/\/ Offline support:[\s\S]*?<\/script>/, '')
    .replace(/<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, '')
    .replace('<head>', `<head><!-- Modified by SiteCAD contributors on ${changedAt}: startup and caching adapted for local hosting; engine files unchanged. --><script>localStorage.setItem("opencadstudio.automation","1");</script>`);
}

export async function installEditor() {
  const files = new Map();
  const integrity = new Map();
  const queue = ['/app/index.html', '/app/ocs-control.js', '/app/locale-labels.json',
    '/app/ocs-parse-worker.js', '/app/fonts/korean.ttf', '/app/supporters.json', '/app/videos.json', '/app/discussions.json'];
  const modifications = [];

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
      const changedAt = new Date().toISOString();
      localBytes = Buffer.from(adaptEditorHtml(html, changedAt));
      modifications.push({ path: relative, by: 'SiteCAD contributors', changedAt,
        changes: ['Removed upstream offline service-worker registration and manifest/icon links.', 'Enabled the published automation control API for local hosting.'],
        localSha256: createHash('sha256').update(localBytes).digest('hex') });
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
  const licenseSources = [
    ['LICENSE', 'HakanSeven12/OpenCADStudio/b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0/LICENSE'],
    ['licenses/Phosphor-LICENSE.txt', 'HakanSeven12/OpenCADStudio/b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0/assets/icons/ui/LICENSE-phosphor.txt'],
    ['licenses/Iced-LICENSE.txt', 'iced-rs/iced/23604ff22ab0aad9e00b9327cb7b8546ed84db39/LICENSE'],
    ['licenses/Druid-LICENSE.txt', 'iced-rs/iced/23604ff22ab0aad9e00b9327cb7b8546ed84db39/core/src/layout/DRUID_LICENSE'],
    ['licenses/Iced-AW-LICENSE.txt', 'HakanSeven12/iced_aw/9bff59df71c215abe91710870634886967fc9f1c/LICENSE'],
    ['licenses/Fira-OFL.txt', 'mozilla/Fira/fd8c8c0a3d353cd99e8ca1662942d165e6961407/LICENSE'],
  ];
  for (const [name, source] of licenseSources) {
    const license = await fetch(`https://raw.githubusercontent.com/${source}`, { signal: AbortSignal.timeout(30_000) });
    if (!license.ok) throw new Error(`Could not preserve upstream license: ${license.status}`);
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await writeFile(path.join(destination, name), Buffer.from(await license.arrayBuffer()));
  }
  await writeFile(path.join(destination, 'manifest.local.json'), JSON.stringify({
    source: `${origin}/app/`, fetchedAt: new Date().toISOString(),
    note: 'Published distribution snapshot. HTML startup and caching adapted for local hosting; engine files unchanged.',
    modifications,
    files: [...files.values()]
  }, null, 2) + '\n');
  console.log('OpenCADStudio installed locally. OAuth is handled by the existing Codex CLI.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await installEditor();
