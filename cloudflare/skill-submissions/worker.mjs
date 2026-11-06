import { createIssue, findIssue, githubHeaders, issueUrl, limitedBytes, requestJson } from './github.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const maximum = 18 * 1024 * 1024;
const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox" };
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const json = (status, value) => Response.json(value, { status, headers: security });

function configured(env) {
  let origin;
  try { const url = new URL(env.PUBLIC_ORIGIN); if (url.protocol === 'https:' && url.origin === env.PUBLIC_ORIGIN) origin = url.origin; } catch { /* An incomplete deployment stays disabled. */ }
  const auth = typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length >= 8 || /^\d+$/.test(env.GITHUB_APP_ID ?? '') && /^\d+$/.test(env.GITHUB_INSTALLATION_ID ?? '') && typeof env.GITHUB_PRIVATE_KEY === 'string' && env.GITHUB_PRIVATE_KEY.includes('-----BEGIN PRIVATE KEY-----');
  return Boolean(origin && auth && env.GITHUB_OWNER === 'seominpapa' && env.GITHUB_REPO === 'SiteCAD' && /^[a-zA-Z0-9_-]{1,100}$/.test(env.TURNSTILE_SITE_KEY ?? '') && env.TURNSTILE_SECRET_KEY && env.ARCHIVES?.put && env.API_LIMITER?.limit && env.UPLOAD_LIMITER?.limit && env.GLOBAL_LIMITER?.limit);
}

function localOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port && url.origin === raw) return raw;
  } catch { /* Invalid parent origins are rejected. */ }
  throw fail('SiteCAD 로컬 창에서 제출 창을 열어 주세요.');
}

function challenge(url, env) {
  const origin = localOrigin(url.searchParams.get('origin'));
  const nonce = url.searchParams.get('nonce');
  if (!uuid.test(nonce ?? '') || [...url.searchParams.keys()].some(key => !['origin', 'nonce'].includes(key))) throw fail('제출 확인 요청을 다시 열어 주세요.');
  const scriptNonce = crypto.randomUUID();
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteCAD 제출 확인</title><style>body{margin:8px;font:14px system-ui;color:#24434a}p{margin:0 0 8px}</style><p id="status" role="status">자동 제출 방지를 위해 연결을 확인합니다.</p><div id="verification"></div><script nonce="${scriptNonce}">
const send=(token,reason)=>parent.postMessage({type:'sitecad-skill-verification',nonce:${JSON.stringify(nonce)},token,...(reason?{reason}:{})},${JSON.stringify(origin)});
const status=text=>{document.getElementById('status').textContent=text};
window.sitecadReady=()=>turnstile.render('#verification',{sitekey:${JSON.stringify(env.TURNSTILE_SITE_KEY)},action:'skill-submit',cData:${JSON.stringify(nonce)},
callback:token=>{status('보안 확인 완료');send(token)},
'expired-callback':()=>{status('보안 확인이 만료됐습니다. 제출 창을 다시 열어 주세요.');send('','expired')},
'error-callback':()=>{status('보안 확인에 실패했습니다. 제출 창을 다시 열거나 ZIP 저장·이메일 공유를 이용해 주세요.');send('','failed');return true}});
</script><script nonce="${scriptNonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=sitecadReady&render=explicit" async defer></script></html>`;
  return new Response(html, { headers: { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; frame-ancestors http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none'` } });
}

async function submissionInput(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/form-data;') || type.length > 200) throw fail('제출 파일 형식을 확인해 주세요.', 415);
  const bytes = await limitedBytes(request, maximum + 32768).catch(() => { throw fail('제출 용량은 18MB 이하여야 합니다.', 413); });
  let form;
  try { form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); } catch { throw fail('제출 파일을 읽지 못했습니다.'); }
  const fields = [...form.keys()];
  if (fields.length !== 5 || new Set(fields).size !== 5 || fields.some(key => !['archive', 'metadata', 'turnstileToken', 'challengeNonce', 'consent'].includes(key))) throw fail('제출 항목을 확인해 주세요.');
  if (form.get('consent') !== 'true') throw fail('공개 제출 동의를 확인해 주세요.');
  const metadataText = form.get('metadata'); let metadata;
  if (typeof metadataText !== 'string' || new TextEncoder().encode(metadataText).length > 16384) throw fail('제출 설명 용량을 확인해 주세요.');
  try { metadata = JSON.parse(metadataText); } catch { throw fail('제출 설명 형식을 확인해 주세요.'); }
  if (!metadata || Array.isArray(metadata) || Object.keys(metadata).some(key => !['submissionId', 'version', 'summary'].includes(key)) || !uuid.test(metadata.submissionId ?? '') || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(metadata.version) || metadata.version.length > 64 || metadata.summary !== undefined && (typeof metadata.summary !== 'string' || metadata.summary.length > 8000 || metadata.summary.includes('\0'))) throw fail('제출 설명을 확인해 주세요.');
  const token = form.get('turnstileToken'), nonce = form.get('challengeNonce'), archive = form.get('archive');
  if (typeof token !== 'string' || !token || token.length > 2048 || !uuid.test(nonce ?? '')) throw fail('제출 확인을 다시 진행해 주세요.');
  if (!archive || typeof archive === 'string' || !/^SiteCAD-skills-[\d.-]+\.zip$/.test(archive.name) || archive.name.length > 120 || archive.size < 22 || archive.size > maximum) throw fail('SiteCAD 스킬 ZIP 파일을 확인해 주세요.');
  const archiveBytes = new Uint8Array(await archive.arrayBuffer());
  if (archiveBytes[0] !== 80 || archiveBytes[1] !== 75 || archiveBytes[2] !== 3 || archiveBytes[3] !== 4) throw fail('SiteCAD 스킬 ZIP 파일을 확인해 주세요.');
  let ended = false;
  for (let i = archiveBytes.length - 22; i >= Math.max(0, archiveBytes.length - 65557); i--) {
    if (archiveBytes[i] === 80 && archiveBytes[i + 1] === 75 && archiveBytes[i + 2] === 5 && archiveBytes[i + 3] === 6 && i + 22 + archiveBytes[i + 20] + archiveBytes[i + 21] * 256 === archiveBytes.length) { ended = true; break; }
  }
  if (!ended) throw fail('완전한 스킬 ZIP 파일을 다시 생성해 주세요.');
  return { metadata: { submissionId: metadata.submissionId.toLowerCase(), version: metadata.version, summary: metadata.summary || '세부 내용은 ZIP의 개선안 설명.md와 개선배경 폴더를 참고하세요.' }, token, nonce, archiveBytes, filename: archive.name };
}

async function verify(input, env, fetcher) {
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: input.token });
  const result = await requestJson(fetcher, 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body }, 16384);
  if (result.success !== true || result.hostname !== new URL(env.PUBLIC_ORIGIN).hostname || result.action !== 'skill-submit' || result.cdata !== input.nonce) throw fail('제출 확인이 만료됐습니다. 다시 확인해 주세요.', 403);
}

const recordKey = id => `receipts/${id}.json`;
const completedKey = id => `completed/${id}.json`;
const archiveKey = id => `archives/${id}.zip`;
const receipt = record => ({ submissionId: record.submissionId, state: record.state === 'submitted' ? 'submitted' : 'pending', ...(record.issueUrl ? { issueUrl: record.issueUrl, downloadUrl: record.downloadUrl } : {}) });
const marker = id => `<!-- sitecad-submission:${id} -->`;

async function finish(env, record, issue) {
  const url = issueUrl(env, issue);
  if (!url) throw Error('GitHub 접수 결과를 확인하지 못했습니다.');
  const updated = { ...record, state: 'submitted', issueUrl: url, downloadUrl: `${env.PUBLIC_ORIGIN}/downloads/${record.submissionId}` };
  // R2 permits one write per object per second: reserve and complete in separate immutable keys.
  await env.ARCHIVES.put(completedKey(record.submissionId), JSON.stringify(updated), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  return updated;
}

async function submit(request, env, fetcher) {
  const input = await submissionInput(request);
  await verify(input, env, fetcher);
  const { metadata, archiveBytes, filename } = input, key = recordKey(metadata.submissionId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', archiveBytes));
  const fingerprint = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') + JSON.stringify(metadata);
  const existing = await env.ARCHIVES.get(key);
  if (existing) {
    const record = await existing.json();
    if (record.fingerprint !== fingerprint) throw fail('같은 제출 번호의 내용이 변경됐습니다. 기존 접수 상태를 확인해 주세요.', 409);
    const completed = await env.ARCHIVES.get(completedKey(metadata.submissionId));
    if (completed) return json(200, { ok: true, data: receipt(await completed.json()) });
    try {
      const headers = await githubHeaders(env, fetcher), issue = await findIssue(env, fetcher, headers, marker(metadata.submissionId));
      if (issue) return json(200, { ok: true, data: receipt(await finish(env, record, issue)) });
    } catch { /* Unknown outcomes remain reserved, never create a second issue. */ }
    return json(202, { ok: true, data: receipt(record) });
  }
  const record = { submissionId: metadata.submissionId, version: metadata.version, filename, fingerprint, state: 'pending', createdAt: new Date().toISOString() };
  const lock = await env.ARCHIVES.put(key, JSON.stringify(record), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  if (!lock) return json(202, { ok: true, data: receipt(record) });
  try {
    await env.ARCHIVES.put(archiveKey(metadata.submissionId), archiveBytes, { httpMetadata: { contentType: 'application/zip' } });
    const headers = await githubHeaders(env, fetcher);
    const issue = await createIssue(env, fetcher, headers, record, metadata.summary);
    return json(201, { ok: true, data: receipt(await finish(env, record, issue)) });
  } catch { return json(202, { ok: true, data: receipt(record) }); }
}

async function download(id, env, method) {
  const existing = await env.ARCHIVES.get(completedKey(id));
  if (!existing) throw fail('다운로드할 제출 파일이 없습니다.', 404);
  const record = await existing.json();
  if (record.state !== 'submitted') throw fail('아직 접수 확인이 완료되지 않았습니다.', 404);
  const archive = await env.ARCHIVES.get(archiveKey(id));
  if (!archive) throw fail('다운로드할 제출 파일이 없습니다.', 404);
  return new Response(method === 'HEAD' ? null : archive.body, { headers: { ...security, 'Content-Type': 'application/zip', 'Content-Length': String(archive.size), 'Content-Disposition': `attachment; filename="${record.filename}"` } });
}

export function createWorker({ fetcher = fetch } = {}) {
  return { async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!env.API_LIMITER?.limit) return url.pathname === '/health' ? json(200, { ok: true, data: { configured: false } }) : json(503, { ok: false, error: '제출 서버 설정을 준비하고 있습니다.' });
      if (!(await env.API_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) throw fail('잠시 후 다시 시도해 주세요.', 429);
      if (url.pathname === '/health' && request.method === 'GET') return json(200, { ok: true, data: { configured: configured(env) } });
      if (!configured(env)) throw fail('제출 서버 설정을 준비하고 있습니다.', 503);
      if (url.origin !== env.PUBLIC_ORIGIN) throw fail('제출 서버 주소를 확인해 주세요.', 403);
      if (url.pathname === '/challenge' && request.method === 'GET') return challenge(url, env);
      const match = /^\/downloads\/([a-f0-9-]{36})$/i.exec(url.pathname);
      if (match && uuid.test(match[1]) && ['GET', 'HEAD'].includes(request.method)) return await download(match[1], env, request.method);
      if (url.pathname !== '/submissions' || request.method !== 'POST') throw fail('경로를 찾을 수 없습니다.', 404);
      const actor = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await env.UPLOAD_LIMITER.limit({ key: actor })).success || !(await env.GLOBAL_LIMITER.limit({ key: 'skill-submissions' })).success) throw fail('제출이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
      return await submit(request, env, fetcher);
    } catch (error) {
      return json(error.status || 503, { ok: false, error: error.status ? error.message : '제출 서버 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  } };
}

export default createWorker();
