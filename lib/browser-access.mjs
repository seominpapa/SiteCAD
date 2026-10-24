import { randomBytes, timingSafeEqual } from 'node:crypto';

const fresh = () => randomBytes(32).toString('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (message, status = 403) => Object.assign(Error(message), { status });
const connectionPage = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SiteCAD 연결</title><style>body{font:16px system-ui;max-width:38rem;margin:12vh auto;padding:24px;color:#193b40}button{font:inherit;padding:12px 20px;cursor:pointer}p{line-height:1.6}</style><main><h1>SiteCAD</h1><p>이 브라우저에서 도면 작업을 시작하거나 기존 브라우저의 연결을 전환할 수 있습니다. 기존 도면은 먼저 DWG로 저장해 주세요.</p><button id="connect">이 브라우저로 연결</button><p id="status" role="status"></p></main><script>const button=document.getElementById('connect'),status=document.getElementById('status');let timer,recovery=false;async function show(response){const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error||'연결을 확인해 주세요.');if(value.data.state==='connected'){location.replace('/');return;}status.textContent=value.data.message||'기존 브라우저에서 도면 저장 여부를 확인하고 있습니다.';if(value.data.state==='waiting')timer=setTimeout(check,1500);else{recovery=value.data.state==='recovery';button.textContent=recovery?'이 브라우저로 연결 복구':'이 브라우저로 연결';button.disabled=false;}}async function check(){try{await show(await fetch('/api/browser/state',{cache:'no-store'}));}catch(error){status.textContent=error.message;button.disabled=false;}}button.onclick=async()=>{if(recovery&&!confirm('기존 탭의 저장하지 않은 변경은 이동되지 않습니다. 저장한 DWG를 기준으로 이 브라우저에 연결을 복구할까요?'))return;clearTimeout(timer);button.disabled=true;try{await show(await fetch('/api/browser/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recovery?{recover:true}:{})}));}catch(error){status.textContent=error.message;button.disabled=false;}};</script></html>`;

export function createBrowserAccess({ now = Date.now } = {}) {
  let token;
  let session = fresh();
  let activated = false;
  let expiresAt = 0;
  let owner;
  let pending;
  let transferring = false;
  const mcpOwners = new WeakMap();
  const cookieName = `sitecad_${randomBytes(8).toString('hex')}`;
  const cookie = req => (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const setCookie = (res, value) => res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, data })); return false; };
  const current = req => activated && same(cookie(req), session);
  const ownsToken = req => current(req) && owner && !transferring && same(req.headers['x-sitecad-owner'], owner.token);
  const validOwner = req => ownsToken(req) && !expired();
  const expired = () => owner && now() - owner.seenAt > 15000;
  const candidate = req => pending && same(cookie(req), pending.session);
  async function reset(desktop) { await desktop?.cancel?.(); owner = undefined; }
  async function connect(req, res, desktop, recover = false) {
    if (transferring) throw fail('연결을 전환 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    if (current(req)) return json(res, 200, { state: 'connected' });
    if (pending && now() > pending.expiresAt) pending = undefined;
    const next = candidate(req) ? pending.session : fresh();
    setCookie(res, next);
    if (recover && !expired()) throw fail('기존 연결이 아직 유효합니다. 기존 브라우저에서 저장 후 전환해 주세요.', 409);
    if (!owner || recover) {
      transferring = true;
      try { await reset(desktop); session = next; activated = true; pending = undefined; }
      finally { transferring = false; }
      return json(res, 200, { state: 'connected' });
    }
    if (pending && !candidate(req) && pending.state === 'waiting') throw fail('다른 브라우저의 연결 전환을 확인 중입니다. 잠시 후 다시 시도해 주세요.', 409);
    pending = { session: next, id: fresh(), state: 'waiting', expiresAt: now() + 60000 };
    return json(res, 200, { state: 'waiting', message: '기존 브라우저에서 저장되지 않은 변경과 진행 중인 작업을 확인하고 있습니다. 기존 브라우저를 열어 주세요.' });
  }
  return {
    assertOwner(req) { if (!validOwner(req)) throw fail('도면 작업 연결이 만료되었습니다. 다시 연결해 주세요.'); },
    assertMcpOwner(req) { if (!owner || transferring || expired() || !same(mcpOwners.get(req), owner.token)) throw fail('이전 도면 연결 요청이 만료되었습니다.'); },
    launchUrl(base) { token = fresh(); expiresAt = now() + 300000; return `${base}/launch?token=${token}`; },
    async protect(req, res, path, { readBody, desktop, isBusy = () => false } = {}) {
      res.setHeader('Cache-Control', 'no-store');
      if (path === '/api/internal/mcp') {
        if (!owner || transferring || expired()) throw fail('도면 작업 탭을 먼저 연결해 주세요.', 409);
        mcpOwners.set(req, owner.token);
        return true;
      }
      if (path === '/launch' && req.method === 'GET' && token && now() <= expiresAt && same(new URL(req.url, 'http://127.0.0.1').searchParams.get('token'), token)) {
        token = undefined;
        if (!activated) { activated = true; setCookie(res, session); }
        else if (current(req)) setCookie(res, session);
        else { setCookie(res, fresh()); }
        res.writeHead(303, { Location: '/' }); res.end(); return false;
      }
      if (path.startsWith('/api/browser/')) {
        if (path === '/api/browser/state' && req.method === 'GET') {
          if (current(req)) return json(res, 200, { state: 'connected', recoveryAvailable: Boolean(expired()) });
          if (candidate(req)) {
            if (now() > pending.expiresAt) return json(res, 200, { state: 'rejected', message: '연결 요청 시간이 지났습니다. 다시 연결해 주세요.' });
            if (pending.state === 'waiting' && expired()) return json(res, 200, { state: 'recovery', message: '기존 브라우저가 응답하지 않습니다. 연결을 복구하면 저장한 DWG만 이어서 열 수 있으며, 기존 탭의 저장하지 않은 변경은 이동되지 않습니다.' });
            return json(res, 200, { state: pending.state, ...(pending.message ? { message: pending.message } : {}) });
          }
          throw fail('이 브라우저로 연결 버튼을 눌러 주세요.');
        }
        if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}`) throw fail('이 로컬 앱에서만 연결할 수 있습니다.');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw fail('JSON 요청만 지원합니다.', 415);
        const body = await readBody(req, 2048);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('연결 요청을 확인해 주세요.', 400);
        if (path === '/api/browser/connect') {
          if (Object.keys(body).some(key => key !== 'recover') || (body.recover !== undefined && typeof body.recover !== 'boolean')) throw fail('연결 요청을 확인해 주세요.', 400);
          return connect(req, res, desktop, body.recover === true);
        }
        if (transferring) throw fail('연결을 전환 중입니다. 잠시 후 다시 시도해 주세요.', 409);
        if (!current(req)) throw fail('연결이 다른 브라우저로 전환되었습니다.');
        if (path === '/api/browser/claim') {
          if (Object.keys(body).some(key => !['tabId', 'recover'].includes(key)) || (body.recover !== undefined && typeof body.recover !== 'boolean') || typeof body.tabId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(body.tabId)) throw fail('도면 탭 정보를 확인해 주세요.', 400);
          if (owner && body.recover === true) {
            if (!expired()) throw fail('기존 탭의 연결이 아직 유효합니다. 기존 탭을 닫고 잠시 후 다시 연결해 주세요.', 409);
            transferring = true;
            try { await reset(desktop); } finally { transferring = false; }
          }
          if (owner && owner.tabId !== body.tabId) throw fail('SiteCAD가 다른 탭에서 열려 있습니다. 기존 탭을 닫아 주세요. 탭이 이미 닫혔다면 15초 후 연결 복구를 선택해 주세요.', 409);
          if (!owner) owner = { tabId: body.tabId, token: fresh(), seenAt: now(), safe: false };
          return json(res, 200, { ownerToken: owner.token });
        }
        if (!(path === '/api/browser/heartbeat' ? ownsToken(req) : validOwner(req))) throw fail('도면 작업 연결이 만료되었습니다. 다시 연결해 주세요.');
        if (path === '/api/browser/heartbeat') {
          if (Object.keys(body).some(key => key !== 'safe') || typeof body.safe !== 'boolean') throw fail('도면 상태를 확인해 주세요.', 400);
          owner = { ...owner, seenAt: now(), safe: body.safe };
          const request = pending?.state === 'waiting' && now() <= pending.expiresAt ? { state: 'transfer-requested', requestId: pending.id } : { state: 'owned' };
          return json(res, 200, request);
        }
        if (path === '/api/browser/transfer') {
          if (Object.keys(body).some(key => !['safe', 'requestId'].includes(key)) || typeof body.safe !== 'boolean' || !pending || !same(body.requestId, pending.id) || pending.state !== 'waiting' || now() > pending.expiresAt) throw fail('연결 전환 요청이 만료되었습니다.', 409);
          transferring = true;
          try {
            const state = await desktop?.status?.();
            if (!body.safe || isBusy() || state?.active || state?.auth?.pending) {
              pending = { ...pending, state: 'rejected', message: '기존 브라우저에서 작업을 마치고 DWG를 저장한 뒤 다시 연결해 주세요.' };
              return json(res, 200, { state: 'rejected' });
            }
            await reset(desktop); session = pending.session; pending = undefined;
          } finally { transferring = false; }
          return json(res, 200, { state: 'transferred' });
        }
        if (path === '/api/browser/release') {
          if (Object.keys(body).length) throw fail('연결 종료 요청을 확인해 주세요.', 400);
          transferring = true;
          try { await reset(desktop); } finally { transferring = false; }
          return json(res, 200, { state: 'released' });
        }
        throw fail('경로를 찾을 수 없습니다.', 404);
      }
      if (path === '/' && ['GET', 'HEAD'].includes(req.method) && !current(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? '' : connectionPage); return false;
      }
      if (!current(req)) throw fail('SiteCAD 주소를 다시 열고 이 브라우저로 연결해 주세요.');
      if (path.startsWith('/api/') && !['/api/health', '/api/cad-font'].includes(path) && !path.startsWith('/api/local/drawings/') && !validOwner(req)) throw fail('도면 작업 탭을 먼저 연결해 주세요.');
      if (path.startsWith('/api/local/drawings/') && req.method !== 'GET' && !validOwner(req)) throw fail('도면 작업 탭을 먼저 연결해 주세요.');
      return true;
    },
  };
}
