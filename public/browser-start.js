export async function startLocalPage({ browserMode, locks, start, blocked }) {
  if (!browserMode) return start();
  if (!locks) return blocked('중복 작업 방지를 지원하는 최신 Chrome·Edge·Safari 브라우저로 열어 주세요.');
  return locks.request('sitecad-drawing-owner', { ifAvailable: true }, async lock => {
    if (!lock) return blocked('SiteCAD가 다른 탭에서 열려 있습니다. 기존 탭에서 작업하거나 기존 탭을 닫은 뒤 다시 연결해 주세요.');
    await start();
    await new Promise(() => {});
  });
}

export function withOwner(fetcher, base, ownerToken) {
  return (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith('/api/')) return fetcher(input, init);
    const headers = new Headers(init.headers ?? input.headers);
    headers.set('X-SiteCAD-Owner', ownerToken);
    return fetcher(input, { ...init, headers });
  };
}

export function monitorBrowserOwner({ request, hooks, suspended, transferred, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false; let timer; let running = false; let needsResume = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true; cancel(timer);
    try {
      const state = await request('heartbeat', { safe: false });
      if (stopped) return;
      if (needsResume && state.state === 'owned') { await hooks()?.resume(); needsResume = false; }
      suspended(false);
      if (state.state === 'transfer-requested' && hooks()) {
        const current = hooks();
        let safe = false;
        try { safe = await current.isSafeToTransfer(); needsResume = safe; if (safe) await current.freeze(); }
        catch { safe = false; }
        const response = await request('transfer', { requestId: state.requestId, safe });
        if (response.state === 'transferred') { stopped = true; transferred(); return; }
        await current.resume(); needsResume = false;
      }
    } catch (error) {
      if (!stopped) suspended(true, error.message);
    } finally { running = false; if (!stopped) timer = schedule(tick, 2000); }
  };
  void tick();
  const stop = () => { stopped = true; cancel(timer); };
  stop.check = tick;
  return stop;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const blocked = (text, recoverable = false) => {
    document.getElementById('editor')?.remove();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert'); message.className = 'workspace-notice error'; message.textContent = text;
    const retry = document.createElement('button'); retry.textContent = '다시 연결'; retry.addEventListener('click', () => location.reload());
    const children = [message, retry];
    if (recoverable) {
      const recover = document.createElement('button'); recover.textContent = '이 탭으로 연결 복구';
      recover.addEventListener('click', () => {
        if (window.confirm('이전 탭의 저장하지 않은 변경은 이동되지 않습니다. 저장한 DWG를 기준으로 이 탭에 연결을 복구할까요?')) location.assign('/?recover=1');
      });
      children.push(recover);
    }
    document.querySelector('main').replaceChildren(...children);
  };
  const boot = async () => {
    const recover = new URL(location.href).searchParams.get('recover') === '1';
    if (recover) history.replaceState(null, '', '/');
    const response = await fetch('/api/health', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok) throw Error(body.error || 'SiteCAD 주소를 다시 열어 연결해 주세요.');
    await startLocalPage({ browserMode: body.data.browser === true, locks: navigator.locks, blocked,
      start: async () => {
        let stopMonitoring; let app;
        if (body.data.browser) {
          const claim = await fetch('/api/browser/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: crypto.randomUUID(), ...(recover ? {recover:true} : {}) }) });
          const value = await claim.json();
          if (!claim.ok || !value.ok) {
            const state = await (await fetch('/api/browser/state')).json();
            throw Object.assign(Error(value.error || '다른 탭에서 도면을 작업하고 있습니다.'), {recoverable:state.data?.recoveryAvailable === true});
          }
          window.fetch = withOwner(window.fetch.bind(window), location.href, value.data.ownerToken);
          const request = async (action, data) => {
            const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
            try {
              const res = await fetch(`/api/browser/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: controller.signal });
              const result = await res.json(); if (!res.ok || !result.ok) throw Error(result.error || '도면 연결을 확인해 주세요.');
              return result.data;
            } finally { clearTimeout(timeout); }
          };
          stopMonitoring = monitorBrowserOwner({ request, hooks: () => app?.browserSessionHooks,
            suspended: (state, message) => {
              const main = document.querySelector('main'); main.inert = state || document.hidden || !document.hasFocus();
              const badge = document.getElementById('oauth-status');
              if (state && badge) badge.textContent = message || '도면 연결 확인 중 · 편집 일시 중지';
            }, transferred: () => { location.replace('/'); } });
          const pause = () => { document.querySelector('main').inert = true; };
          addEventListener('blur', () => { if (!document.hasFocus()) pause(); });
          addEventListener('focus', () => { pause(); void stopMonitoring.check(); });
          document.addEventListener('visibilitychange', () => { pause(); if (!document.hidden) void stopMonitoring.check(); });
          addEventListener('pagehide', () => {
            stopMonitoring?.();
            void fetch('/api/browser/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
          }, { once: true });
          document.getElementById('local-actions').hidden = false;
          for (const [id, action] of [['open-saved-folder', 'open-drawings'], ['quit-local', 'quit']]) {
            document.getElementById(id).addEventListener('click', async () => {
              if (action === 'quit' && !window.confirm('저장하지 않은 도면과 진행 중인 작업이 사라질 수 있습니다. 필요한 DWG를 저장했는지 확인한 뒤 SiteCAD 실행기를 종료할까요?')) return;
              try {
                const res = await fetch(`/api/local/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const value = await res.json(); if (!res.ok || !value.ok) throw Error(value.error || '로컬 실행기를 확인해 주세요.');
                if (action === 'quit') blocked('SiteCAD 실행기를 종료했습니다. 다시 사용하려면 Start SiteCAD.command를 열어 주세요.');
              } catch (error) { window.alert(error.message); }
            });
          }
        }
        document.getElementById('editor').src = '/app/';
        app = await import('./app.js');
      },
    });
  };
  void boot().catch(error => blocked(error.message, error.recoverable));
}
