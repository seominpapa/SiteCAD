export function parseConnectionCommand(message) {
  const value = message.trim();
  const manage = value.match(/^\/mcp\s+(test|remove|enable|disable)\s+([a-zA-Z][a-zA-Z0-9_-]{0,63})$/i);
  if (manage) return { kind: 'manage', action: manage[1].toLowerCase(), name: manage[2] };
  if (/^\/(?:api|mcp)\s+kcsc$/i.test(value)
    || /^(?:KCSC|국가건설기준센터)\s*(?:API|MCP)(?:\s*키)?\s*(?:를\s*)?(?:추가|등록|연결|설치)(?:해\s*줘|해주세요|하기)?[.!]?$/i.test(value)
    || /^https:\/\/github\.com\/lhs1152-lgtm\/kcsc-design-mcp(?:\.git)?\/?(?:\s+(?:이\s*)?(?:MCP(?:를)?\s*)?(?:설치|등록|연결)(?:해\s*줘|해주세요|하기)?)?[.!]?$/i.test(value)) return { kind: 'kcsc' };
  const mcp = value.match(/^\/mcp(?:\s+add(?:\s+([\s\S]*))?)?$/i);
  if (mcp) return { kind: 'mcp', config: mcp[1] ?? '' };
  if (/^\/api(?:\s+vworld)?$/i.test(value) || /^(?:(?:VWorld|브이월드)\s*)?API\s*(?:를\s*)?(?:추가|등록|연결)(?:해\s*줘|해주세요|하기)?[.!]?$/i.test(value)) return { kind: 'vworld' };
  if (/^지형\s*원본\s*(?:을\s*)?등록(?:해\s*줘|해주세요|하기)?[.!]?$/.test(value)) return { kind: 'terrain' };
  if (/^설계\s*기준\s*(?:을\s*)?연결(?:해\s*줘|해주세요|하기)?[.!]?$/.test(value)) return { kind: 'standards' };
  return null;
}

export function createChatConnections({ isBusy, onPending = () => {}, onChange = () => {}, notify = () => {} }) {
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
    card.dialog?.close();
    (card.dialog ?? card.root).remove(); card = undefined;
  }
  function sync() {
    if (!card) return;
    for (const node of card.root.querySelectorAll('input, textarea, button')) node.disabled = pending || isBusy() || card.loading === true || node.dataset.unavailable === 'true';
    card.sync?.();
  }
  function open(title, hint, modal = false) {
    clear();
    const root = element('article'); root.className = 'message assistant connection-card';
    const author = element('p', 'SiteCAD'); author.className = 'message-author';
    const message = element('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    root.append(author, element('strong', title), element('p', hint));
    const dialog = modal ? element('dialog') : undefined;
    if (dialog) {
      dialog.className = 'connection-dialog'; dialog.setAttribute('aria-label', title);
      dialog.append(root); document.body.append(dialog);
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending) clear(); });
    } else document.getElementById('messages').append(root);
    card = { root, message, dialog };
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
    view.root.append(form, view.message); view.dialog?.showModal(); sync();
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
  function mcpCard(config) {
    const view = open('MCP 등록', 'GitHub URL과 설치 요청은 일반 채팅에 입력하세요. 인증값이 포함된 JSON은 아래에 입력하면 채팅 기록과 AI에 전달되지 않습니다. 한 서버씩 등록합니다.');
    const form = element('form');
    const input = field(form, 'config', 'MCP JSON 설정', 'textarea'); input.value = config; input.maxLength = 65536;
    const trust = field(form, 'trusted', '이 실행 파일·인수·연결 주소를 확인하고 등록·실행을 신뢰합니다. 외부 MCP는 운영체제 사용자 권한으로 실행됩니다.', 'checkbox');
    const save = button(form, 'save', '등록', () => {}); save.type = 'submit';
    input.addEventListener('input', () => { trust.checked = false; sync(); }); trust.addEventListener('change', sync);
    view.sync = () => { save.disabled = pending || isBusy() || !trust.checked || !input.value.trim(); };
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (pending || isBusy()) return;
      if (!trust.checked) { view.message.textContent = '실행 설정을 확인한 뒤 신뢰 확인란에 체크해 주세요.'; return; }
      let value;
      try { value = JSON.parse(input.value); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); }
      catch { view.message.textContent = '설정은 올바른 JSON 객체여야 합니다.'; return; }
      input.value = ''; trust.checked = false;
      await action(view, async () => {
        await request('mcp/save', { config: value, trusted: true }); await changed();
        view.message.textContent = '서버를 등록했습니다. 실제 연결은 /mcp test 서버이름 으로 확인해 주세요.';
      });
    });
    finishForm(view, form); input.focus();
  }
  function vworldCard() {
    const view = open('VWorld API 등록', '주소·필지 조회에는 VWorld API 키가 필요합니다. 이 입력값은 채팅 기록과 AI에 전달되지 않습니다. 저장된 키는 표시하지 않습니다. 등록 후 원래 요청을 다시 전송해 주세요.', true);
    view.loading = true;
    const form = element('form'), status = element('p', '등록 상태 확인 중'); form.append(status);
    const key = field(form, 'apiKey', 'VWorld API 키', 'password'); key.maxLength = 256;
    const domain = field(form, 'domain', '등록 도메인 (선택)'); domain.maxLength = 500;
    const saveConsent = field(form, 'saveConsent', '키를 이 SiteCAD의 보안 저장소에 저장하는 데 동의합니다. 키는 VWorld 공식 서버에만 전송합니다.', 'checkbox');
    const save = button(form, 'save', '키 저장', () => {}); save.type = 'submit';
    const testConsent = field(form, 'testConsent', '연결 확인을 위해 저장된 키와 “서울특별시 중구 세종대로 110” 주소를 VWorld에 한 번 전송하는 데 동의합니다.', 'checkbox');
    let configured = false;
    const render = state => {
      configured = state?.configured === true;
      status.textContent = !configured ? '키 미등록' : state.lastCheck?.ok === true ? '연결 확인됨' : state.lastCheck?.ok === false ? '연결 확인 실패' : '등록됨 · 연결 미확인';
      if (typeof state?.domain === 'string') domain.value = state.domain;
      sync();
    };
    const test = button(form, 'test', '연결 확인', () => {
      if (view.loading || !configured || !testConsent.checked || pending || isBusy()) return;
      testConsent.checked = false;
      return action(view, async () => {
        const result = await request('references/test', {});
        render({ configured: true, lastCheck: { ok: result?.ok === true } }); await changed();
        view.message.textContent = result?.ok === true ? 'VWorld 실제 연결을 확인했습니다.' : 'VWorld 연결 확인 실패. 키 권한과 등록 도메인을 확인해 주세요.';
      });
    });
    const remove = button(form, 'remove', '키 연결 해제', () => {
      if (view.loading || !configured) return;
      return action(view, async () => {
        key.value = ''; saveConsent.checked = testConsent.checked = false;
        await request('references/remove', {}); render({ configured: false }); await changed(); view.message.textContent = 'VWorld 키 연결을 해제했습니다.';
      });
    });
    view.sync = () => {
      save.disabled = view.loading || pending || isBusy() || !saveConsent.checked || !key.value.trim();
      test.disabled = view.loading || pending || isBusy() || !configured || !testConsent.checked;
      remove.disabled = view.loading || pending || isBusy() || !configured;
    };
    for (const node of [key, domain]) node.addEventListener('input', () => { saveConsent.checked = testConsent.checked = false; sync(); });
    for (const node of [saveConsent, testConsent]) node.addEventListener('change', sync);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (view.loading || pending || isBusy()) return;
      if (!saveConsent.checked) { view.message.textContent = '키 저장 범위를 확인한 뒤 동의해 주세요.'; return; }
      const apiKey = key.value.trim(), registeredDomain = domain.value.trim();
      if (!/^[A-Za-z0-9_-]{8,256}$/.test(apiKey)) { view.message.textContent = 'API 키의 형식과 길이를 확인해 주세요.'; return; }
      if (/[\s\x00-\x1f]/.test(registeredDomain)) { view.message.textContent = '등록 도메인을 확인해 주세요.'; return; }
      key.value = ''; saveConsent.checked = testConsent.checked = false;
      await action(view, async () => {
        await request('references/save', { apiKey, ...(registeredDomain ? { domain: registeredDomain } : {}) });
        render({ configured: true }); await changed(); view.message.textContent = 'API 키를 저장했습니다. 실제 연결은 별도 동의 후 확인해 주세요.';
      });
    });
    finishForm(view, form); key.focus();
    void request('references').then(data => { if (card === view) render(data?.vworld); })
      .catch(() => { if (card === view) status.textContent = '등록 상태 조회 실패. 다시 열어확인해 주세요.'; })
      .finally(() => { if (card === view) { view.loading = false; sync(); } });
  }
  function kcscCard() {
    const view = open('KCSC 기준 조회 MCP 등록', '국가건설기준센터 API 키를 아래에 입력하세요. 입력값은 채팅 기록과 AI에 전달되지 않습니다. 저장된 키는 다시 표시하지 않습니다.', true);
    view.loading = true;
    const form = element('form'), status = element('p', '등록 상태 확인 중');
    const link = element('a', '국가건설기준센터 로그인 → 인증키 발급신청');
    link.href = 'https://kcsc.re.kr/support/api'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    form.append(status, link, element('p', 'kcsc-design-mcp==0.3.1을 SiteCAD 전용으로 설치합니다. 처음 등록할 때 Python 실행 환경을 내려받아 수분이 걸릴 수 있습니다. 기준 조회 도구만 연결하며 실행 시 기존 도구 승인 정책을 적용합니다.'));
    const key = field(form, 'apiKey', 'KCSC API 키', 'password'); key.maxLength = 1024;
    const trust = field(form, 'trusted', '이 MCP와 Python 실행 환경의 설치·실행 및 키의 로컬 암호화 저장에 동의합니다. 키는 기준 조회를 위해 국가건설기준센터에 전송됩니다.', 'checkbox');
    let configured = false, installed = false;
    const save = button(form, 'save', '설치·키 등록·연결', () => {}); save.type = 'submit';
    const render = state => {
      configured = state?.configured === true; installed = state?.installed === true;
      const connected = configured && state?.connected === true;
      status.textContent = !configured ? '키 미등록' : connected ? '키 등록됨 · 연결 확인됨' : state.lastCheck?.ok === false ? '키 등록됨 · 연결 확인 실패' : '키 등록됨 · 연결 미확인';
      save.textContent = configured ? '키 변경·재연결' : '설치·키 등록·연결'; sync();
    };
    const perform = async (path, body) => {
      try { return await request(path, body); }
      catch {
        render({ configured, installed, connected: false, lastCheck: { ok: false } });
        await changed(); throw Error('KCSC 연결 요청 실패');
      }
    };
    const test = button(form, 'test', '연결 확인', () => {
      if (view.loading || !configured || pending || isBusy()) return;
      return action(view, async () => {
        const state = await perform('kcsc/test', {}); render(state); await changed();
        view.message.textContent = state?.connected === true ? 'KCSC MCP 실제 연결을 확인했습니다.' : '연결 확인 실패. 키와 API 사용 권한을 확인한 뒤 키를 다시 등록해 주세요.';
      }, '연결 확인 실패. 키와 API 사용 권한을 확인한 뒤 다시 시도해 주세요.');
    });
    const remove = button(form, 'remove', '키·연결 삭제', () => {
      if (view.loading || (!configured && !installed)) return;
      return action(view, async () => {
        key.value = ''; trust.checked = false;
        const state = await perform('kcsc/remove', {}); render(state); await changed();
        view.message.textContent = 'KCSC 키와 MCP 연결을 삭제했습니다.';
      }, '삭제 실패. 연결 상태를 새로 확인한 뒤 다시 시도해 주세요.');
    });
    view.sync = () => {
      save.disabled = view.loading || pending || isBusy() || !trust.checked || !key.value.trim();
      test.disabled = view.loading || pending || isBusy() || !configured;
      remove.disabled = view.loading || pending || isBusy() || (!configured && !installed);
    };
    key.addEventListener('input', () => { trust.checked = false; sync(); }); trust.addEventListener('change', sync);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (view.loading || pending || isBusy()) return;
      if (!trust.checked) { view.message.textContent = '설치·실행 및 키 저장 범위를 확인한 뒤 동의해 주세요.'; return; }
      const apiKey = key.value.trim();
      if (!/^[\x21-\x7e]{8,1024}$/.test(apiKey)) { view.message.textContent = 'API 키의 형식과 길이를 확인해 주세요.'; return; }
      key.value = ''; trust.checked = false;
      await action(view, async () => {
        view.message.textContent = '실행 환경 준비·MCP 설치·연결 확인 중입니다. 처음에는 수분이 걸릴 수 있습니다.';
        const state = await perform('kcsc/save', { apiKey, trusted: true }); render(state); await changed();
        view.message.textContent = state?.connected === true ? 'KCSC 키를 등록하고 MCP 실제 연결을 확인했습니다. 원래 요청을 다시 전송해 주세요.' : '키를 저장했지만 연결은 확인하지 못했습니다. 키와 API 사용 권한을 확인한 뒤 연결 확인을 실행해 주세요.';
      }, '등록·연결 실패. 네트워크와 키의 API 사용 권한을 확인한 뒤 다시 시도해 주세요.');
    });
    finishForm(view, form); key.focus();
    void request('kcsc').then(state => { if (card === view) render(state); })
      .catch(() => { if (card === view) status.textContent = '등록 상태 조회 실패. 다시 열어 확인해 주세요.'; })
      .finally(() => { if (card === view) { view.loading = false; sync(); } });
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
      if (supported && !status.active && !isBusy() && !pending && request?.provider === 'vworld' && typeof request.id === 'string' && request.id !== credentialRequest) {
        credentialRequest = request.id; vworldCard();
      }
      sync();
    },
    sync, clear,
    handleCommand(message) {
      const command = parseConnectionCommand(message);
      if (!command) return false;
      if (!supported || pending || isBusy()) { notify('연결 등록은 로컬 SiteCAD에서 현재 작업이 끝난 뒤 사용할 수 있습니다.'); return true; }
      if (command.kind === 'mcp') mcpCard(command.config);
      else if (command.kind === 'vworld') vworldCard();
      else if (command.kind === 'kcsc') kcscCard();
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
