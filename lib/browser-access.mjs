import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createBrowserAccess({ now = Date.now } = {}) {
  let token;
  const session = randomBytes(32).toString('hex');
  const cookieName = `sitecad_${randomBytes(8).toString('hex')}`;
  let expiresAt = 0;
  let activated = false;
  const same = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return {
    launchUrl(base) {
      token = randomBytes(32).toString('hex');
      expiresAt = now() + 300000;
      return `${base}/launch?token=${token}`;
    },
    protect(req, res, path) {
      // MCP authenticates separately with its private bearer token, never a browser cookie.
      if (path === '/api/internal/mcp') return true;
      const cookie = (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      // Web Locks share ownership only inside one browser profile; never authorize a second profile.
      if (path === '/launch' && req.method === 'GET' && (!activated || same(cookie, session)) && token && now() <= expiresAt && same(new URL(req.url, 'http://127.0.0.1').searchParams.get('token'), token)) {
        token = undefined;
        activated = true;
        res.setHeader('Set-Cookie', `${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict`);
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(303, { Location: '/' }); res.end(); return false;
      }
      if (path !== '/launch' && same(cookie, session)) return true;
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: activated ? 'SiteCAD가 처음 연결한 브라우저에서만 열립니다. 기존 브라우저에서 도면을 저장하고 실행기를 종료한 뒤 다시 시작해 주세요.' : 'SiteCAD 실행 파일을 다시 열어 이 브라우저에 연결해 주세요.' }));
      return false;
    },
  };
}
