export async function startLocalPage({ browserMode, locks, start, blocked }) {
  if (!browserMode) return start();
  if (!locks) return blocked('중복 작업 방지를 지원하는 최신 Chrome·Edge·Safari 브라우저로 열어 주세요.');
  return locks.request('sitecad-drawing-owner', { ifAvailable: true }, async lock => {
    if (!lock) return blocked('SiteCAD가 다른 탭에서 열려 있습니다. 기존 탭에서 작업하거나 기존 탭을 닫은 뒤 이 페이지를 새로고침해 주세요.');
    await start();
    // Keep ownership until the page closes; two editors must never consume the same MCP queue.
    await new Promise(() => {});
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const blocked = text => {
    document.getElementById('editor')?.remove();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert'); message.className = 'workspace-notice error'; message.textContent = text;
    document.querySelector('main').replaceChildren(message);
  };
  const boot = async () => {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok) throw Error(body.error || 'SiteCAD 실행 파일을 다시 열어 주세요.');
    await startLocalPage({ browserMode: body.data.browser === true, locks: navigator.locks, blocked,
      start: async () => {
        document.getElementById('editor').src = '/app/';
        if (body.data.browser) {
          document.getElementById('local-actions').hidden = false;
          for (const [id, action] of [['open-saved-folder', 'open-drawings'], ['quit-local', 'quit']]) {
            const button = document.getElementById(id);
            button.addEventListener('click', async () => {
              if (action === 'quit' && !window.confirm('저장하지 않은 도면과 진행 중인 작업이 사라질 수 있습니다. 필요한 DWG를 저장했는지 확인한 뒤 SiteCAD 실행기를 종료할까요?')) return;
              try {
                const res = await fetch(`/api/local/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const value = await res.json(); if (!res.ok || !value.ok) throw Error(value.error || '로컬 실행기를 확인해 주세요.');
                if (action === 'quit') blocked('SiteCAD 실행기를 종료했습니다. 다시 사용하려면 Start SiteCAD.command를 열어 주세요.');
              } catch (error) { window.alert(error.message); }
            });
          }
        }
        await import('./app.js');
      },
    });
  };
  void boot().catch(error => blocked(error.message));
}
