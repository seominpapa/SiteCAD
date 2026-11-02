export function parseConnectionCommand(message) {
  const value = message.trim();
  const manage = value.match(/^\/mcp\s+(test|remove|enable|disable)\s+([a-zA-Z][a-zA-Z0-9_-]{0,63})$/i);
  if (manage) return { kind: 'manage', action: manage[1].toLowerCase(), name: manage[2] };
  if (/^\/(?:api|mcp)\s+kcsc$/i.test(value)
    || /^(?:KCSC|국가건설기준센터)\s*(?:API|MCP)(?:\s*키)?\s*(?:를\s*)?(?:추가|등록|연결|설치)(?:해\s*줘|해주세요|하기)?[.!]?$/i.test(value)) return { kind: 'kcsc' };
  const mcp = value.match(/^\/mcp(?:\s+add(?:\s+([\s\S]*))?)?$/i);
  if (mcp) return { kind: 'mcp' };
  if (/^\/api$/i.test(value))return {kind:'api'};
  if (/^\/api\s+vworld$/i.test(value) || /^(?:VWorld|브이월드)\s*API\s*(?:를\s*)?(?:추가|등록|연결)(?:해\s*줘|해주세요|하기)?[.!]?$/i.test(value)) return { kind: 'vworld' };
  if (/^지형\s*원본\s*(?:을\s*)?등록(?:해\s*줘|해주세요|하기)?[.!]?$/.test(value)) return { kind: 'terrain' };
  if (/^설계\s*기준\s*(?:을\s*)?연결(?:해\s*줘|해주세요|하기)?[.!]?$/.test(value)) return { kind: 'standards' };
  return null;
}

export function createChatConnections({ isBusy, onPending = () => {}, onChange = () => {}, notify = () => {}, onOpenSettings = () => {} }) {
  let supported = false, browser = false, pending = false, card;
  const element = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  async function request(path, body) {
    const response = await fetch(`/api/desktop/${path}`, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error('연결 요청 실패');
    return result.data;
  }
  function clear() {
    if (!card) return;
    for (const node of card.root.querySelectorAll('input, textarea')) { node.value = ''; node.checked = false; }
    card.root.remove(); card = undefined;
  }
  function sync() {
    if (!card) return;
    for (const node of card.root.querySelectorAll('input, textarea, button')) node.disabled = pending || isBusy() || card.loading === true || node.dataset.unavailable === 'true';
    card.sync?.();
  }
  function open(title, hint) {
    clear();
    const root = element('article'); root.className = 'message assistant connection-card';
    const author = element('p', 'SiteCAD'); author.className = 'message-author';
    const message = element('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    root.append(author, element('strong', title), element('p', hint));
    document.getElementById('messages').append(root);
    card = { root, message };
    return card;
  }
  function field(parent, name, label, type = 'text') {
    const wrap = element('label', label), input = element(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.dataset.field = name; input.autocomplete = 'off'; input.spellcheck = false;
    if (type === 'checkbox') wrap.className = 'mcp-trust-label';
    wrap.append(input); parent.append(wrap); return input;
  }
  function button(parent, name, label, listener) {
    const node = element('button', label); node.type = 'button'; node.dataset.field = name;
    node.addEventListener('click', listener); parent.append(node); return node;
  }
  function finishForm(view, form) {
    button(form, 'cancel', '닫기', () => { if (!pending) clear(); });
    view.root.append(form, view.message); sync();
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  }
  async function action(view, task, failure = '요청 실패. 설정과 연결 상태를 확인한 뒤 다시 시도해 주세요.') {
    if (pending || isBusy()) return;
    pending = true; sync(); onPending(true); view.message.textContent = '';
    try { await task(); }
    catch { view.message.textContent = failure; }
    finally { pending = false; sync(); onPending(false); }
  }
  async function changed() { try { await onChange(); } catch { notify('설정은 반영했지만 연결 목록 새로 고침에 실패했습니다.'); } }
  function settingsGuide(kind, details = {}) {
    const known={kcsc:{name:'KCSC · 국가건설기준센터',issuanceUrl:'https://kcsc.re.kr/support/api'},vworld:{name:'VWorld',issuanceUrl:'https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do'}};
    const info=known[kind]??details;
    const credentials=kind==='mcp'&&typeof details.apiId==='string';
    const api=kind!=='mcp'||credentials,id=known[kind]?kind:credentials?`mcp-${details.apiId}`:details.apiId;
    const view=open(api?`${info.name||'API'} 연결 안내`:'MCP 설치·관리',api?'공식 사이트에서 API 키를 발급받은 뒤 설정 → API에 등록하세요. 채팅에는 API 키를 입력하지 마세요. 등록 결과와 연결 상태는 설정에서 확인할 수 있습니다.':'MCP를 설치하려면 채팅에 공식 주소와 “설치해 줘”를 입력하세요. 설치 결과는 설정 → MCP에 기록됩니다. 환경 변수·HTTP Bearer 인증 키는 설정 → API에 등록하세요. 다른 인증 방식은 제공자별 지원 확인이 필요합니다.');
    if(credentials)view.root.append(element('p','이 MCP가 요청한 환경 변수 또는 HTTP Bearer 토큰만 설정 → API에서 등록할 수 있습니다. OAuth 등 다른 인증 방식은 제공자의 지원 절차를 확인해야 합니다.'));
    if(api&&info.issuanceUrl){
      try{const url=new URL(info.issuanceUrl);if(url.protocol==='https:'&&!url.username&&!url.password){const link=element('a',kind==='kcsc'?'국가건설기준센터 로그인 → 인증키 발급신청':'공식 API 키 발급 사이트');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';view.root.append(link);}}catch{}
    }
    const actions=element('div');actions.className='connection-card-actions';
    button(actions,'open-settings',api?'설정에서 API 키 등록':'설정에서 MCP 확인',()=>{if(!pending&&!isBusy())return onOpenSettings(api?'api':'mcp',id);});
    finishForm(view,actions);
  }
  function manageCard({ action: operation, name }) {
    const labels = { test: '연결 확인', remove: '등록 해제', enable: '활성화', disable: '사용 중지' };
    const view = open(`${name} · ${labels[operation]}`, '아래 버튼으로 이 작업을 확인하세요. 등록 상태와 실제 연결 상태는 다를 수 있습니다.');
    const form = element('div'); form.className = 'connection-card-actions';
    const confirm = button(form, 'confirm', labels[operation], () => action(view, async () => {
      const path = ['enable', 'disable'].includes(operation) ? 'toggle' : operation;
      const result = await request(`mcp/${path}`, { name, ...(path === 'toggle' ? { enabled: operation === 'enable' } : {}) });
      confirm.dataset.unavailable = 'true'; await changed();
      view.message.textContent = operation !== 'test' ? `${name}: ${labels[operation]}했습니다.`
        : result?.tested === true || result?.connected === true ? `${name}: 실제 연결을 확인했습니다.` : `${name}: 연결을 확인하지 못했습니다.`;
    }));
    finishForm(view, form);
  }
  function terrainCard() {
    const view = open('지형 원본 등록', '별도의 외부 연결이 아닌 지형 자료 등록입니다. GeoJSON 또는 같은 이름의 SHP·DBF·PRJ를 선택하세요. 좌표계와 표고 속성을 확인하며 등록 후 채팅에서 삽입을 요청할 수 있습니다.');
    const form = element('div');
    const imported = () => { view.message.textContent = '지형 원본을 등록했습니다. 채팅에서 도면 삽입을 요청하세요.'; };
    if (browser) {
      const files = field(form, 'files', '지형 파일', 'file'); files.multiple = true; files.accept = '.geojson,.json,.shp,.dbf,.prj';
      files.addEventListener('change', () => {
        const selected = [...(files.files || [])]; files.value = '';
        if (!selected.length) return;
        if (selected.length > 3 || selected.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024) { view.message.textContent = '최대 3개, 합계 128MiB 이하로 선택해 주세요.'; return; }
        return action(view, async () => {
          const data = new FormData(); for (const file of selected) data.append('files', file);
          const response = await fetch('/api/local/terrain/import', { method: 'POST', body: data });
          const result = await response.json(); if (!response.ok || !result.ok) throw Error(); imported();
        });
      });
    } else button(form, 'import', '파일 선택', () => action(view, async () => {
      const result = await request('terrain/import', {});
      if (result?.cancelled) { view.message.textContent = '원본 파일 선택을 취소했습니다.'; return; } imported();
    }));
    finishForm(view, form);
  }
  let credentialRequest;
  return {
    update(status) {
      supported = status.desktop === true; browser = status.browser === true;
      const request = status.credentialRequest;
      if (supported && !status.active && !isBusy() && !pending && ['vworld','kcsc','api','mcp'].includes(request?.provider) && typeof request.id === 'string' && request.id !== credentialRequest) {
        credentialRequest = request.id; settingsGuide(request.provider,request);
      }
      sync();
    },
    sync, clear,
    handleCommand(message) {
      const command = parseConnectionCommand(message);
      if (!command) return false;
      if (!supported || pending || isBusy()) { notify('연결 등록은 로컬 SiteCAD에서 현재 작업이 끝난 뒤 사용할 수 있습니다.'); return true; }
      if (['mcp','api','vworld','kcsc'].includes(command.kind))settingsGuide(command.kind);
      else if (command.kind === 'manage') manageCard(command);
      else if (command.kind === 'terrain') terrainCard();
      else {
        const view = open('설계 기준 참고', 'KDS·KCS를 웹검색으로 참고할 때는 별도 MCP나 API 등록이 필요하지 않습니다. 일반 채팅에서 필요한 기준의 원문·개정일을 검색해 달라고 요청하세요. 공식 API로 조회하려면 /api kcsc 에서 본인의 KCSC 키를 등록할 수 있습니다. 접근 가능한 실제 원문을 확인한 범위만 사용합니다.');
        finishForm(view, element('div'));
      }
      return true;
    },
  };
}
