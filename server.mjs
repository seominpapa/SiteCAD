import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChat, validatePlan } from './lib/plan.mjs';
import { oauthStatus, planWithCodex } from './lib/planner.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.dwg': 'application/acad', '.bin': 'application/octet-stream' };
const loginMessage = 'OpenAI OAuth 연결이 필요합니다. 터미널에서 codex login을 실행하고 ChatGPT 계정으로 로그인해 주세요.';
const error = (message, status = 400) => Object.assign(Error(message), { status });

function respond(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function localHost(req, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
}

async function readBytes(req, limit, timeoutMs = 10000) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw error('요청이 너무 큽니다.', 413); }
  const body = await new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(error('요청 시간이 초과되었습니다.', 408)), timeoutMs);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { clearTimeout(timer); reject(error('요청이 너무 큽니다.', 413)); }
      else chunks.push(chunk);
    });
    req.on('end', () => { clearTimeout(timer); resolveBody(Buffer.concat(chunks)); });
    req.on('error', () => { clearTimeout(timer); reject(error('요청을 읽을 수 없습니다.')); });
    req.on('aborted', () => { clearTimeout(timer); reject(error('요청이 중단되었습니다.')); });
  });
  return body;
}

async function readBody(req, limit = 128 * 1024) {
  const body = await readBytes(req, limit);
  try { return JSON.parse(body.toString('utf8')); } catch { throw error('JSON 요청을 확인해 주세요.'); }
}

async function staticFile(res, file, allowedRoot, method) {
  const [actual, allowed] = await Promise.all([realpath(file), realpath(allowedRoot)]);
  const rel = relative(allowed, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).some(part => part.startsWith('.'))) throw error('파일을 찾을 수 없습니다.', 404);
  const info = await stat(actual);
  if (!info.isFile() || !types[extname(actual)]) throw error('파일을 찾을 수 없습니다.', 404);
  res.writeHead(200, { 'Content-Type': types[extname(actual)], 'Content-Length': info.size, 'Cache-Control': 'no-store' });
  if (method === 'HEAD') return res.end();
  const stream = createReadStream(actual);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function createApp({ plan = planWithCodex, authStatus = oauthStatus, desktop, browserAccess, browserActions, publicRoot = join(root, 'public'), editorRoot = join(root, 'vendor/editor'), fixturePath = join(root, 'fixtures/retaining-wall.dwg'), now = Date.now } = {}) {
  let active = false;
  let recent = [];
  let authCache;
  let authAt = 0;
  async function currentAuth() {
    if (!authCache || now() - authAt > 3000) {
      try { authCache = { connected: (await authStatus()).connected === true, method: 'chatgpt' }; }
      catch { authCache = { connected: false, method: 'chatgpt' }; }
      authAt = now();
    }
    return authCache;
  }
  async function chat(req, res) {
    if (req.headers.origin !== `http://${req.headers.host}`) throw error('이 로컬 앱에서만 요청할 수 있습니다.', 403);
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw error('JSON 요청만 지원합니다.', 415);
    const input = validateChat(await readBody(req));
    recent = recent.filter(time => now() - time < 60000);
    if (active || recent.length >= 20) throw error('진행 중인 요청이 끝난 뒤 잠시 후 다시 시도해 주세요.', 429);
    active = true;
    recent = [...recent, now()];
    try {
      if (desktop) {
        const status = await desktop.status();
        if (!status.oauth?.connected) throw error('SiteCAD의 ChatGPT 로그인 버튼으로 로그인해 주세요.', 503);
        return respond(res, 200, { ok: true, data: await desktop.chat(input) });
      }
      if (!(await currentAuth()).connected) throw error(loginMessage, 503);
      let result;
      try { result = validatePlan(await plan(input)); }
      catch { throw error('AI 계획을 생성하지 못했습니다. OAuth 연결과 네트워크를 확인한 뒤 다시 시도해 주세요.', 502); }
      if (input.context.units === 0 && result.operations.some(op => !['undo', 'measure'].includes(op.type))) result = { reply: '현재 도면의 단위를 확인할 수 없습니다. 편집기의 도면 단위를 먼저 지정해 주세요.', operations: [] };
      const { documentId, revision, units, selection } = input.context;
      respond(res, 200, { ok: true, data: { ...result, base: { documentId, revision, units, selection } } });
    } finally { active = false; }
  }
  async function desktopRoute(req, res, path) {
    if (!desktop) throw error('경로를 찾을 수 없습니다.', 404);
    if (path === '/api/internal/mcp') {
      if (req.method !== 'POST' || !desktop.authorizeMcp(req.headers.authorization)) throw error('허용되지 않은 연결입니다.', 403);
      const { method, payload } = await readBody(req);
      return respond(res, 200, { ok: true, data: await desktop.callCad(method, payload) });
    }
    if (path === '/api/desktop/status' && req.method === 'GET') return respond(res, 200, { ok: true, data: await desktop.status() });
    if (path === '/api/desktop/mcp' && req.method === 'GET') return respond(res, 200, { ok: true, data: await desktop.mcpList() });
    if (path === '/api/desktop/references' && req.method === 'GET') return respond(res, 200, { ok: true, data: await desktop.referencesStatus() });
    if (path === '/api/desktop/terrain' && req.method === 'GET') return respond(res, 200, { ok: true, data: await desktop.terrainStatus() });
    if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}`) throw error('이 로컬 앱에서만 요청할 수 있습니다.', 403);
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw error('JSON 요청만 지원합니다.', 415);
    const body = await readBody(req, path === '/api/desktop/cad/result' ? 42 * 1024 * 1024 : 128 * 1024);
    let data;
    if (path === '/api/desktop/login') data = await desktop.login();
    else if (path === '/api/desktop/logout') data = await desktop.logout();
    else if (path === '/api/desktop/cancel') data = await desktop.cancel();
    else if (path === '/api/desktop/cad/poll') data = await desktop.pollCad();
    else if (path === '/api/desktop/cad/claim') data = desktop.claimCad(body.id);
    else if (path === '/api/desktop/cad/result') data = desktop.completeCad(body.id, body.result, body.error);
    else if (path === '/api/desktop/mcp/save') data = await desktop.mcpSave(body);
    else if (path === '/api/desktop/mcp/toggle') data = await desktop.mcpToggle(body);
    else if (path === '/api/desktop/mcp/remove') data = await desktop.mcpRemove(body);
    else if (path === '/api/desktop/mcp/test') data = await desktop.mcpTest(body);
    else if (path === '/api/desktop/references/save') data = await desktop.referencesSave(body);
    else if (path === '/api/desktop/references/remove') data = await desktop.referencesRemove();
    else if (path === '/api/desktop/references/test') data = await desktop.referencesTest();
    else if (path === '/api/desktop/terrain/import') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw error('파일 선택 창에서 지형 원본을 선택해 주세요.');
      data = await desktop.terrainImport();
    }
    else if (path === '/api/desktop/approvals/resolve') data = await desktop.resolveApproval(body);
    else throw error('경로를 찾을 수 없습니다.', 404);
    return respond(res, 200, { ok: true, data: data ?? null });
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    try {
      if (!localHost(req, server.address()?.port)) throw error('로컬 주소만 지원합니다.', 403);
      const rawPath = decodeURIComponent(req.url.split('?')[0]);
      if (rawPath.includes('\\') || rawPath.includes('\0') || rawPath.split('/').some(part => part.startsWith('.'))) throw error('파일을 찾을 수 없습니다.', 404);
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (browserAccess && !browserAccess.protect(req, res, path)) return;
      if (browserAccess && path.startsWith('/api/local/')) {
        if (req.method === 'GET' && path.startsWith('/api/local/drawings/')) {
          const file = await desktop.readDrawing(decodeURIComponent(path.slice('/api/local/drawings/'.length)));
          res.writeHead(200, { 'Content-Type': 'application/acad', 'Content-Length': file.bytes.length, 'Content-Disposition': `attachment; filename="drawing.dwg"; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-SHA256': file.sha256, 'Cache-Control': 'no-store' });
          return res.end(file.bytes);
        }
        if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}`) throw error('이 로컬 앱에서만 요청할 수 있습니다.', 403);
        if (path === '/api/local/terrain/import') {
          if (!req.headers['content-type']?.startsWith('multipart/form-data;')) throw error('파일 업로드 요청을 확인해 주세요.', 415);
          const bytes = await readBytes(req, 128 * 1024 * 1024 + 65536, 60000);
          const form = await new Request('http://127.0.0.1', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: bytes }).formData();
          const entries = [...form.entries()];
          if (!entries.length || entries.length > 3 || entries.some(([key, value]) => key !== 'files' || typeof value === 'string')) throw error('GeoJSON 또는 SHP·DBF·PRJ 파일을 선택해 주세요.');
          const files = await Promise.all(entries.map(async ([, file]) => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })));
          return respond(res, 200, { ok: true, data: await desktop.terrainImport(files) });
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw error('JSON 요청만 지원합니다.', 415);
        const input = await readBody(req, path === '/api/local/drawings/save' ? 42 * 1024 * 1024 : 128 * 1024);
        if (path === '/api/local/drawings/save') {
          if (!input || Object.keys(input).some(key => !['name', 'result', 'expectedContext'].includes(key))) throw error('저장 요청을 확인해 주세요.');
          return respond(res, 200, { ok: true, data: await desktop.saveDrawing(input.result, input.name, input.expectedContext) });
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw error('요청을 확인해 주세요.');
        if (path === '/api/local/open-drawings') await browserActions.openDrawings();
        else if (path === '/api/local/quit') await browserActions.quit();
        else throw error('경로를 찾을 수 없습니다.', 404);
        return respond(res, 200, { ok: true });
      }
      if (path.startsWith('/api/desktop/') || path === '/api/internal/mcp') return await desktopRoute(req, res, path);
      if (req.method === 'POST' && path === '/api/chat') return await chat(req, res);
      if (!['GET', 'HEAD'].includes(req.method)) throw error('지원하지 않는 요청입니다.', 405);
      if (path === '/api/health') {
        const status = desktop ? await desktop.status() : undefined;
        const oauth = status?.oauth ?? await currentAuth();
        const editorInstalled = await stat(join(editorRoot, 'index.html')).then(info => info.isFile()).catch(() => false);
        return respond(res, 200, { ok: true, data: { oauth, editorInstalled, ...(status ?? {}), ...(browserAccess ? { browser: true } : {}) } });
      }
      if (path === '/api/cad-font') return await staticFile(res, '/System/Library/Fonts/Supplemental/AppleGothic.ttf', '/System/Library/Fonts/Supplemental', req.method);
      if (path.startsWith('/api/')) throw error('경로를 찾을 수 없습니다.', 404);
      if (path === '/fixtures/retaining-wall.dwg') return await staticFile(res, fixturePath, dirname(fixturePath), req.method);
      if (path.startsWith('/app/')) return await staticFile(res, join(editorRoot, decodeURIComponent(path.slice(5)) || 'index.html'), editorRoot, req.method);
      return await staticFile(res, join(publicRoot, decodeURIComponent(path.slice(1)) || 'index.html'), publicRoot, req.method);
    } catch (cause) {
      const status = cause.status ?? (['ENOENT', 'ENOTDIR', 'EACCES'].includes(cause.code) || cause instanceof URIError ? 404 : 400);
      respond(res, status, { ok: false, error: cause.status ? cause.message : status === 404 ? '파일을 찾을 수 없습니다.' : '요청을 확인해 주세요.' });
    }
  });
  // The runtime has a ten minute turn budget; allow its result and cancellation cleanup to reach the browser.
  server.requestTimeout = desktop ? 660000 : 150000;
  server.headersTimeout = 15000;
  server.timeout = desktop ? 660000 : 135000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PORT must be 1024..65535');
  createApp().listen(port, '127.0.0.1', () => console.log(`SiteCAD: http://127.0.0.1:${port}`));
}
