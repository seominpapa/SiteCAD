import test from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import { createBrowserAccess } from '../lib/browser-access.mjs';
import { createApp } from '../server.mjs';
import { startLocalPage, withOwner, monitorBrowserOwner } from '../public/browser-start.js';

async function setup(t, options = {}) {
  const access = createBrowserAccess(options);
  const desktop = { cancel:async()=>{}, status: async () => ({ desktop: true, oauth: { connected: false } }), authorizeMcp: value => value === 'Bearer private', callCad: async () => ({ connected: true }) };
  const server = createApp({ desktop, browserAccess: access });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launchUrl = access.launchUrl(base);
  const launch = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie')?.split(';')[0];
  const claim=await fetch(base+'/api/browser/claim',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({tabId:'tab-owner-1'})});
  const {data:{ownerToken}}=await claim.json();
  return { access, desktop, base, launchUrl, launch, cookie, ownerToken, request: (path, init = {}) => fetch(base + path, { ...init, headers: { Cookie: cookie, 'X-SiteCAD-Owner':ownerToken, ...init.headers } }) };
}

test('browser launch exchanges a one-use capability for an HttpOnly session and removes it from the URL', async t => {
  const s = await setup(t);
  assert.equal(s.launch.status, 303);
  assert.equal(s.launch.headers.get('location'), '/');
  assert.match(s.launch.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(s.launch.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(s.launchUrl, { redirect: 'manual' })).status, 403);
  assert.equal((await s.request('/')).status, 200);
  assert.equal((await (await s.request('/api/health')).json()).data.browser, true);
});

test('all browser pages and API state require the launch session; MCP retains its separate private token', async t => {
  const s = await setup(t);
  for (const path of ['/app/', '/api/health', '/api/desktop/status']) {
    assert.equal((await fetch(s.base + path)).status, 403);
    assert.equal((await s.request(path, { headers: { Cookie: 'wrong=secret' } })).status, 403);
  }
  assert.equal((await s.request('/api/desktop/login', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private' }, body: JSON.stringify({ method: 'context' }) };
  assert.equal((await fetch(s.base + '/api/internal/mcp', init)).status, 200);
  assert.equal((await fetch(s.base + '/api/internal/mcp', { ...init, headers: { 'Content-Type': 'application/json' } })).status, 403);
});

test('expired bootstrap capability cannot establish a new session', async t => {
  let time = 0;
  const s = await setup(t, { now: () => time });
  const other = createBrowserAccess({ now: () => time });
  const expiredUrl = other.launchUrl(s.base);
  time = 300001;
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; }, writeHead: status => { headers.status = status; }, end() {} };
  await assert.rejects(other.protect({ method: 'GET', url: new URL(expiredUrl).pathname + new URL(expiredUrl).search, headers: {} }, res, '/launch'), /다시 열고/);
});

test('browser-only folder and exit actions require the authenticated local origin and JSON', async t => {
  const calls = [];
  const access = createBrowserAccess();
  const server = createApp({ browserAccess: access, browserActions: { openDrawings: async () => calls.push('folder'), quit: async () => calls.push('quit') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = await fetch(access.launchUrl(base), { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  const claim=await fetch(base+'/api/browser/claim',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({tabId:'action-owner'})});
  const {data:{ownerToken}}=await claim.json();
  for (const action of ['open-drawings', 'quit']) {
    for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: base, 'Content-Type': 'text/plain' }]) {
      assert.ok((await fetch(`${base}/api/local/${action}`, { method: 'POST', headers: { Cookie: cookie, 'X-SiteCAD-Owner':ownerToken, ...headers }, body: '{}' })).status >= 400);
    }
    assert.equal((await fetch(`${base}/api/local/${action}`, { method: 'POST', headers: { Cookie: cookie, 'X-SiteCAD-Owner':ownerToken, Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  }
  assert.deepEqual(calls, ['folder', 'quit']);
});

test('only one browser tab starts the CAD bridge and the desktop path remains unchanged', async () => {
  let started = 0; const blocked = [];
  await startLocalPage({ browserMode: false, start: async () => { started++; } });
  assert.equal(started, 1);
  await startLocalPage({ browserMode: true, locks: { request: async (_name, options, fn) => { assert.equal(options.ifAvailable, true); return fn(null); } }, start: async () => { started++; }, blocked: text => blocked.push(text) });
  assert.equal(started, 1); assert.match(blocked[0], /다른 탭/);
  await startLocalPage({ browserMode: true, start: async () => { started++; }, blocked: text => blocked.push(text) });
  assert.equal(started, 1); assert.match(blocked[1], /브라우저/);
  let callback;
  await startLocalPage({ browserMode: true, locks: { request: async (_name, _options, fn) => { callback = fn; } }, start: async () => { started++; }, blocked: text => blocked.push(text) });
  void callback({ name: 'owner' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2);
});

test('HTTP waits longer than the ten minute Codex turn budget so an active turn cannot outlive its chat response', () => {
  const server = createApp({ desktop: {} });
  assert.ok(server.timeout > 600000);
  assert.ok(server.requestTimeout > 600000);
});

 test('repeat activation issues a fresh one-use link while retaining the owner session', async t => {
  const s = await setup(t);
  const next = s.access.launchUrl(s.base);
  const response = await fetch(next, { redirect: 'manual', headers: { Cookie: s.cookie } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('set-cookie').split(';')[0], s.cookie);
  assert.equal((await fetch(next, { redirect: 'manual' })).status, 403);
});

test('browser reentry cookie survives browser restarts and unauthenticated root gives an explicit connection page', async t => {
  const s = await setup(t);
  assert.match(s.launch.headers.get('set-cookie'), /Max-Age=2592000/);
  const landing = await fetch(s.base + '/');
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /이 브라우저로 연결/);
  assert.equal((await fetch(s.base + '/api/desktop/status')).status, 403);
});

test('exclusive tab owner is required for CAD mutations and revoked on a safe browser transfer', async t => {
  const s = await setup(t);
  const post = (path, body, headers = {}) => s.request(path, { method: 'POST', headers: { Origin:s.base, 'Content-Type':'application/json', ...headers }, body:JSON.stringify(body) });
  const claim = await post('/api/browser/claim', {tabId:'tab-owner-1'});
  assert.equal(claim.status, 200);
  const first = (await claim.json()).data;
  assert.match(first.ownerToken, /^[a-f0-9]{64}$/);
  assert.equal((await post('/api/browser/claim',{tabId:'tab-owner-2'})).status,409);
  assert.equal((await post('/api/desktop/cad/poll',{},{'X-SiteCAD-Owner':''})).status,403);
  assert.equal((await post('/api/browser/heartbeat',{safe:true},{'X-SiteCAD-Owner':first.ownerToken})).status,200);
  const connect = await fetch(s.base+'/api/browser/connect',{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:'{}'});
  const candidateCookie = connect.headers.get('set-cookie').split(';')[0];
  assert.equal((await connect.json()).data.state,'waiting');
  assert.equal((await fetch(s.base+'/api/desktop/status',{headers:{Cookie:candidateCookie}})).status,403);
  const heartbeat = await post('/api/browser/heartbeat',{safe:true},{'X-SiteCAD-Owner':first.ownerToken});
  const requestId = (await heartbeat.json()).data.requestId;
  assert.equal(typeof requestId,'string');
  const ack = await post('/api/browser/transfer',{requestId,safe:true},{'X-SiteCAD-Owner':first.ownerToken});
  assert.equal((await ack.json()).data.state,'transferred');
  assert.equal((await s.request('/api/health')).status,403);
  const next = await fetch(s.base+'/api/browser/claim',{method:'POST',headers:{Cookie:candidateCookie,Origin:s.base,'Content-Type':'application/json'},body:JSON.stringify({tabId:'tab-next'})});
  assert.equal(next.status,200);
});

test('a closed browser releases its tab and stale tabs require explicit recovery after lease expiry', async t => {
  let time=0;
  const s=await setup(t,{now:()=>time});
  let cancelled=0; s.desktop.cancel=async()=>{cancelled++;};
  const post=(path,body,headers={})=>s.request(path,{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/browser/claim',{tabId:'reentry-tab',recover:true})).status,409);
  time=15001;
  assert.equal((await post('/api/desktop/cad/poll',{})).status,403);
  assert.equal((await post('/api/browser/claim',{tabId:'reentry-tab'})).status,409);
  assert.equal((await (await s.request('/api/browser/state')).json()).data.recoveryAvailable,true);
  const recovered=await post('/api/browser/claim',{tabId:'reentry-tab',recover:true});
  assert.equal(recovered.status,200);
  const next=(await recovered.json()).data.ownerToken;
  assert.notEqual(next,s.ownerToken); assert.equal(cancelled,1);
  assert.equal((await post('/api/browser/release',{})).status,403);
  assert.equal(cancelled,1,'late pagehide cannot cancel the new owner');
  assert.equal((await post('/api/browser/release',{}, {'X-SiteCAD-Owner':next})).status,200);
  assert.equal((await post('/api/browser/claim',{tabId:'normal-reentry'})).status,200);
});

test('dirty or active browser handoff is rejected and unauthenticated connect cannot skip the handshake', async t => {
  const s=await setup(t);
  const request=(path,body)=>s.request(path,{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const newBrowser=async body=>{
    const response=await fetch(s.base+'/api/browser/connect',{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {response,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  assert.equal((await newBrowser({recover:true})).response.status,409);
  for (const unsafe of [true,false]) {
    const next=await newBrowser({});
    const heartbeat=await request('/api/browser/heartbeat',{safe:false});
    const requestId=(await heartbeat.json()).data.requestId;
    if (!unsafe) s.desktop.status=async()=>({active:true});
    const transfer=await request('/api/browser/transfer',{requestId,safe:!unsafe});
    assert.equal((await transfer.json()).data.state,'rejected');
    assert.equal((await s.request('/api/health')).status,200);
    const state=await fetch(s.base+'/api/browser/state',{headers:{Cookie:next.cookie}});
    assert.equal((await state.json()).data.state,'rejected');
  }
  const evil=await fetch(s.base+'/api/browser/connect',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'});
  assert.equal(evil.status,403);
});

test('cross-browser stale recovery is explicit and invalidates old browser and old queued owner tokens', async t => {
  let time=0; const s=await setup(t,{now:()=>time}); time=16000;
  const connect=await fetch(s.base+'/api/browser/connect',{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:'{}'});
  const cookie=connect.headers.get('set-cookie').split(';')[0];
  assert.equal((await connect.json()).data.state,'waiting');
  const state=await fetch(s.base+'/api/browser/state',{headers:{Cookie:cookie}});
  assert.equal((await state.json()).data.state,'recovery');
  assert.equal((await s.request('/api/health')).status,200,'old session is retained until explicit stale recovery');
  const recover=await fetch(s.base+'/api/browser/connect',{method:'POST',headers:{Cookie:cookie,Origin:s.base,'Content-Type':'application/json'},body:'{"recover":true}'});
  assert.equal((await recover.json()).data.state,'connected');
  assert.equal((await s.request('/api/health')).status,403);
  assert.equal((await fetch(s.base+'/api/desktop/cad/poll',{method:'POST',headers:{Cookie:cookie,Origin:s.base,'Content-Type':'application/json','X-SiteCAD-Owner':s.ownerToken},body:'{}'})).status,403);
});

test('browser owner headers are sent only to this local API and preserve existing request headers', async () => {
  const calls=[];const fetcher=async(input,init)=>{calls.push({input,init});return {};};
  const owned=withOwner(fetcher,'http://127.0.0.1:4317/','owner-secret');
  await owned('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(calls[0].init.headers.get('X-SiteCAD-Owner'),'owner-secret');
  assert.equal(calls[0].init.headers.get('Content-Type'),'application/json');
  await owned('https://example.com/api/test',{headers:{Accept:'application/json'}});
  await owned('/app/',{});
  assert.equal(calls[1].init.headers['X-SiteCAD-Owner'],undefined);
  assert.equal(calls[2].init.headers,undefined);
});

test('failed transfer resumes frozen app only after a successful heartbeat proves ownership', async () => {
  const callbacks=[];const events=[];let heartbeat=0;
  const stop=monitorBrowserOwner({
    request:async action=>{if(action==='transfer')throw Error('request expired');return ++heartbeat===1?{state:'transfer-requested',requestId:'id'}:{state:'owned'};},
    hooks:()=>({isSafeToTransfer:async()=>{events.push('safe');return true;},freeze:async()=>events.push('freeze'),resume:async()=>events.push('resume')}),
    suspended:value=>events.push(value?'suspend':'owned'),transferred:()=>events.push('transfer'),schedule:fn=>{callbacks.push(fn);return callbacks.length;},cancel:()=>{},
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['owned','safe','freeze','suspend']);
  await callbacks.shift()();
  assert.deepEqual(events,['owned','safe','freeze','suspend','resume','owned']);stop();
});

test('a sleeping owner may renew its exact token but cannot mutate before renewal or after another owner recovers', async t => {
  let time=0;const s=await setup(t,{now:()=>time});
  const post=(path,body)=>s.request(path,{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:JSON.stringify(body)});
  time=15001;
  assert.equal((await post('/api/desktop/cad/poll',{})).status,403);
  assert.equal((await post('/api/browser/heartbeat',{safe:false})).status,200);
  assert.equal((await (await s.request('/api/browser/state')).json()).data.recoveryAvailable,false);
  time=30002;
  const recovery=await post('/api/browser/claim',{tabId:'recovered-owner',recover:true});
  assert.equal(recovery.status,200);
  assert.equal((await post('/api/browser/heartbeat',{safe:false})).status,403);
});

test('an old runtime MCP body completing after handoff cannot dispatch into the new owner', async t => {
  const s=await setup(t);let began;let calls=0;
  const authorized=new Promise(resolve=>{began=resolve;});
  s.desktop.authorizeMcp=()=>{began();return true;};s.desktop.callCad=async()=>{calls++;return {};};
  const body=JSON.stringify({method:'context'});
  let request;
  const completed=new Promise((resolve,reject)=>{
    request=httpRequest(s.base+'/api/internal/mcp',{method:'POST',headers:{Authorization:'Bearer private','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    request.on('error',reject);request.write(body.slice(0,1));
  });
  await authorized;
  const connected=await fetch(s.base+'/api/browser/connect',{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:'{}'});
  const cookie=connected.headers.get('set-cookie').split(';')[0];
  const post=(path,input)=>s.request(path,{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const heartbeat=await post('/api/browser/heartbeat',{safe:true});
  const requestId=(await heartbeat.json()).data.requestId;
  assert.equal((await (await post('/api/browser/transfer',{safe:true,requestId})).json()).data.state,'transferred');
  assert.equal((await fetch(s.base+'/api/browser/claim',{method:'POST',headers:{Cookie:cookie,Origin:s.base,'Content-Type':'application/json'},body:'{"tabId":"replacement-tab"}'})).status,200);
  request.end(body.slice(1));
  assert.equal(await completed,403);assert.equal(calls,0);
});
