const MAX_TEXT = 8000;
// A 64KiB skill can expand to six times its size when displayed as JSON.
const MAX_SKILL_REVIEW_TEXT = 512 * 1024;
const text = (value, max = MAX_TEXT) => String(value ?? '').slice(0, max);

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function appendProvenance(article, { sources = [], design } = {}) {
  const references = Array.isArray(sources) ? sources.filter(source => source && typeof source === 'object') : [];
  if (!references.length && !design) return;
  const section = document.createElement('section');
  section.className = 'drawing-provenance';
  if (design) {
    const heading = document.createElement('p');
    heading.className = 'provenance-heading';
    heading.textContent = `${design.conceptual ? '개념도 · ' : ''}${text(design.title || '도면 작성 근거', 200)}`;
    section.append(heading);
    if (Array.isArray(design.assumptions) && design.assumptions.length) {
      const label = document.createElement('p');
      label.className = 'provenance-label';
      label.textContent = '적용한 가정';
      const list = document.createElement('ul');
      for (const item of design.assumptions.slice(0, 30)) {
        const li = document.createElement('li'); li.textContent = text(item, 1000); list.append(li);
      }
      section.append(label, list);
    }
    if (Array.isArray(design.dimensions) && design.dimensions.length) {
      const label = document.createElement('p'); label.className = 'provenance-label'; label.textContent = '치수와 근거';
      const list = document.createElement('ul');
      for (const dimension of design.dimensions.slice(0, 50)) {
        if (!dimension || typeof dimension !== 'object') continue;
        const li = document.createElement('li');
        li.textContent = `${text(dimension.name, 100)}: ${text(dimension.value, 100)} ${text(dimension.unit, 30)} · ${dimension.basis === 'source' ? `출처 ${text(dimension.sourceId || '확인 필요', 80)}` : '가정값'}`;
        list.append(li);
      }
      section.append(label, list);
    }
    if (Array.isArray(design.sourceIds) && design.sourceIds.length) {
      const ids = document.createElement('p'); ids.className = 'source-meta';
      ids.textContent = `참고 자료: ${design.sourceIds.slice(0, 30).map(id => text(id, 80)).join(', ')}`;
      section.append(ids);
    }
  }
  if (references.length) {
    const heading = document.createElement('p'); heading.className = 'provenance-label'; heading.textContent = '참고 자료와 확인 범위'; section.append(heading);
    for (const source of references.slice(0, 20)) {
      const card = document.createElement('div'); card.className = 'source-card';
      const isSearch = source.kind === 'search';
      const isPdf = source.kind === 'pdf' || source.contentType === 'application/pdf' || Number.isInteger(source.pagesRead);
      const isGeodata = source.kind === 'geodata';
      const scope = document.createElement('p'); scope.className = 'source-kind';
      const pages = Number.isInteger(source.pagesRead) && source.pagesRead >= 0
        ? ` · ${source.pagesRead}${Number.isInteger(source.pages) && source.pages > 0 ? `/${source.pages}` : ''}쪽 읽음` : '';
      scope.textContent = isGeodata ? `공간정보 조회${source.crs ? ` · 좌표계 ${text(source.crs, 80)}` : ''}${Number.isInteger(source.count) && source.count >= 0 ? ` · ${source.count}건` : ''}`
        : source.kind === 'download' ? `파일 다운로드 · ${source.bytes ?? 0}바이트 · 본문 미확인` : isSearch ? '검색 결과 · 본문 미확인' : isPdf ? `PDF 텍스트 추출${pages}` : source.sha256 ? '문서 텍스트 확인' : '참고 링크';
      const url = safeSourceUrl(source.url);
      const title = document.createElement(url ? 'a' : 'span');
      title.textContent = `${text(source.id, 40)} · ${text(source.title || source.url || '참고 자료', 220)}`;
      if (url) { title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
      const meta = document.createElement('p'); meta.className = 'source-meta';
      const hash = source.sha256 || source.sourceSha256;
      meta.textContent = `${url ? new URL(url).hostname : '링크 확인 필요'}${source.retrievedAt ? ` · 확인 ${text(source.retrievedAt, 60)}` : ''}${source.downloadedAt ? ` · 다운로드 ${text(source.downloadedAt, 60)}` : ''}${hash ? ` · SHA256 ${text(hash, 16)}…` : ''}`;
      if (hash) meta.title = `SHA256 ${text(hash, 64)}`;
      card.append(scope, title, meta);
      if (source.sourceKind === 'public-download') {
        const origin = document.createElement('p'); origin.className = 'source-limitation';
        origin.textContent = text(source.sourceLabel, 200); card.append(origin);
      }
      if (isSearch && source.snippet) {
        const snippet = document.createElement('p'); snippet.className = 'source-snippet'; snippet.textContent = `검색 요약: ${text(source.snippet, 500)}`; card.append(snippet);
      }
      if (isPdf || source.truncated || source.limitation) {
        const limitation = document.createElement('p'); limitation.className = 'source-limitation';
        limitation.textContent = [isPdf ? '텍스트만 추출했습니다. OCR 및 CAD 형상·치수 판독은 하지 않았습니다.' : '',
          source.truncated ? '분량 제한으로 일부 내용만 읽었습니다.' : '', text(source.limitation, 1000)].filter(Boolean).join(' ');
        card.append(limitation);
      }
      section.append(card);
    }
  }
  article.append(section);
}

export function createMcpSettings({ isBusy, notify }) {
  const $ = id => document.getElementById(id);
  const dialog = $('mcp-dialog');
  const approvals = new Map();
  let supported = false;
  let pending = false;
  let servers = [];
  let references = {};
  let plugins = [];
  let kcsc = {};

  async function request(path, body) {
    const response = await fetch(`/api/desktop/${path}`, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error(result.error || '연결 요청을 처리하지 못했습니다.');
    return result.data;
  }

  function notice(message = '', error = false) {
    $('mcp-notice').textContent = text(message);
    $('mcp-notice').hidden = !message;
    $('mcp-notice').classList.toggle('error', error);
  }

  function controls() {
    $('manage-mcp').hidden = !supported;
    $('manage-mcp').disabled = pending || isBusy();
    $('mcp-refresh').disabled = !supported || pending || isBusy();
  }

  async function action(task) {
    if (!supported || pending || isBusy()) return;
    pending = true; controls(); notice();
    try { await task(); }
    catch (error) { notice(error.message, true); }
    finally { pending = false; controls(); }
  }

  function connectionCard(name, status, metadata, connected = false) {
    const card = document.createElement('article'); card.className = 'mcp-server';
    const heading = document.createElement('div'); heading.className = 'mcp-server-heading';
    const label = document.createElement('strong'); label.textContent = text(name, 100);
    const state = document.createElement('span'); state.className = `mcp-server-state${connected ? ' connected' : ''}`;
    state.textContent = status;
    heading.append(label, state);
    const meta = document.createElement('p'); meta.className = 'source-meta'; meta.textContent = metadata;
    card.append(heading, meta);
    return card;
  }

  function renderConnections() {
    const list = $('mcp-server-list');
    list.replaceChildren();
    const configuredApi = references?.vworld?.configured === true;
    const apiPresent = configuredApi || references.catalog?.some(item => item.id === 'vworld' && item.kind === 'api');
    $('external-mcp-status').hidden = !supported;
    $('external-mcp-status').textContent = !servers.length && !apiPresent && !plugins.length
      ? '등록된 연결 없음' : `MCP ${servers.length} · API ${apiPresent ? 1 : 0} · 플러그인 ${plugins.length}`;
    if (!servers.length && !apiPresent && !plugins.length) {
      const empty = document.createElement('p'); empty.className = 'mcp-empty';
      empty.textContent = '등록된 연결이 없습니다. MCP·API·플러그인 추가는 채팅에서 요청하세요.';
      list.append(empty);
    }
    for (const server of servers) {
      if (server.name === 'kcsc') {
        const configured = kcsc.configured === true;
        const connected = configured && server.enabled !== false && kcsc.connected === true;
        const status = !configured ? '키 미등록' : server.enabled === false ? '키 등록됨 · 사용 안 함' : connected ? '키 등록됨 · 연결 확인됨' : kcsc.lastCheck?.ok === false ? '키 등록됨 · 연결 확인 실패' : '키 등록됨 · 연결 미확인';
        const count = Number.isSafeInteger(kcsc.count) && kcsc.count >= 0 ? kcsc.count : Array.isArray(server.tools) ? server.tools.length : 0;
        list.append(connectionCard('KCSC · 국가건설기준센터', status, `MCP · 기준 조회 도구 ${count}개${!configured ? ' · 채팅에 /api kcsc 를 입력해 본인의 키를 등록하세요.' : ''}`, connected));
        continue;
      }
      const enabled = server.enabled !== false;
      const connected = enabled && server.connected === true;
      const status = !enabled ? '사용 안 함' : connected ? '연결됨'
        : server.status === 'authenticationRequired' ? '인증 필요'
        : server.status === 'failed' ? '연결 실패' : '연결 확인 필요';
      const count = Array.isArray(server.tools) ? ` · 도구 ${server.tools.length}개` : '';
      list.append(connectionCard(server.name, status, `MCP${server.transport ? ` · ${text(server.transport, 30)}` : ''}${count}`, connected));
    }
    if (apiPresent) {
      const checked = references.vworld?.lastCheck?.ok;
      const status = !configuredApi ? '키 미등록' : checked === true ? '키 등록됨 · 연결 확인됨' : checked === false ? '키 등록됨 · 연결 확인 실패' : '키 등록됨 · 연결 미확인';
      list.append(connectionCard('VWorld', status, configuredApi ? 'API' : 'API · 채팅에 /api vworld 를 입력해 키를 등록하세요.', configuredApi && checked === true));
    }
    for (const plugin of plugins) {
      const status = plugin.status === 'installed' ? '설치됨' : plugin.status === 'modified' ? '수정됨' : '확인 필요';
      list.append(connectionCard(plugin.name, status, `플러그인${plugin.version ? ` · ${text(plugin.version, 50)}` : ''} · 스킬 ${Array.isArray(plugin.skills) ? plugin.skills.length : 0}개`));
    }
  }

  async function refresh() {
    if (!supported) return;
    const [mcp, referenceState, pluginState, kcscState] = await Promise.all([request('mcp'), request('references'), request('plugins'), request('kcsc')]);
    servers = Array.isArray(mcp?.servers) ? mcp.servers : [];
    references = referenceState || {};
    plugins = Array.isArray(pluginState?.plugins) ? pluginState.plugins : [];
    kcsc = kcscState || {};
    renderConnections();
  }

  async function open() {
    if (!supported) {
      notify?.('연결 관리는 SiteCAD 로컬 실행기로 시작한 앱에서 사용할 수 있습니다.', true);
      return;
    }
    if (pending || isBusy()) return;
    if (!dialog.open) dialog.showModal();
    await action(refresh);
  }

  function renderApprovals(items = []) {
    const current = new Set(items.map(item => item.id));
    for (const [id, card] of approvals) if (!current.has(id)) { card.remove(); approvals.delete(id); }
    for (const item of items) {
      if (approvals.has(item.id)) continue;
      const card = document.createElement('article'); card.className = 'tool-approval';
      const installing = item.kind === 'mcp-install';
      const replacingSkill = item.kind === 'skill-overwrite';
      const pluginAction = ['plugin-install', 'plugin-remove'].includes(item.kind);
      const title = document.createElement('strong'); title.textContent = pluginAction ? '플러그인 변경 승인' : installing ? 'MCP 설치·연결 승인' : replacingSkill ? '스킬 덮어쓰기 승인' : '외부 도구 실행 승인';
      const name = document.createElement('p'); name.textContent = `${text(item.server, 100)} · ${text(item.tool, 150)}`;
      const argumentText = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}, null, 2);
      const reviewLimit = replacingSkill || pluginAction ? MAX_SKILL_REVIEW_TEXT : MAX_TEXT;
      const truncated = argumentText.length > reviewLimit;
      const args = document.createElement('pre'); args.textContent = text(argumentText, reviewLimit);
      const note = document.createElement('p'); note.className = 'source-meta';
      note.textContent = pluginAction ? '표시된 플러그인과 포함된 지침을 SiteCAD 전용 공간에 설치하거나 제거합니다. 설치된 작업은 슬래시 명령으로 실행되며 기존 도구 승인과 도면 저장 검증은 유지됩니다.' : installing
        ? '표시한 패키지를 설치하고 이 SiteCAD 전용 설정에 연결합니다. 로컬 서버는 사용자 권한으로 실행되어 자신의 권한에 따라 파일을 읽거나 네트워크에 접근할 수 있습니다. 내용을 확인한 뒤 승인하거나 거절하세요.'
        : replacingSkill ? '표시된 내용으로 이 SiteCAD의 기존 스킬을 교체합니다. 이후 해당 슬래시 명령에도 변경된 지침이 적용됩니다.'
        : '표시된 입력으로 이 도구를 한 번 실행합니다. 내용을 확인한 뒤 승인하거나 거절하세요.';
      if (truncated) note.textContent = `입력이 길어 앞 ${reviewLimit.toLocaleString('ko-KR')}자만 표시합니다. 전체 입력을 확인할 수 없으므로 이 요청은 거절하고 범위를 줄여 다시 요청해 주세요.`;
      const error = document.createElement('p'); error.className = 'mcp-inline-error'; error.hidden = true;
      const actions = document.createElement('div'); actions.className = 'mcp-server-actions';
      for (const [label, approved] of [[pluginAction ? '플러그인 변경 승인' : installing ? '설치·연결 승인' : replacingSkill ? '덮어쓰기 승인' : '1회 승인', true], ['거절', false]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (approved) button.className = 'primary';
        if (approved && truncated) button.disabled = true;
        button.addEventListener('click', async () => {
          if (approved && truncated) return;
          for (const control of actions.children) control.disabled = true;
          try { await request('approvals/resolve', { id: item.id, approved }); card.remove(); approvals.delete(item.id); $('tool-approvals').hidden = !approvals.size; }
          catch (cause) { error.textContent = text(cause.message); error.hidden = false; for (const control of actions.children) control.disabled = false; if (truncated) actions.children[0].disabled = true; }
        });
        actions.append(button);
      }
      card.append(title, name, args, note, error, actions); $('tool-approvals').append(card); approvals.set(item.id, card);
    }
    $('tool-approvals').hidden = !approvals.size;
  }

  $('manage-mcp').addEventListener('click', open);
  $('mcp-refresh').addEventListener('click', () => action(refresh));

  return {
    update(status) {
      supported = status.desktop === true;
      if (Array.isArray(status.externalMcp?.servers)) servers = status.externalMcp.servers;
      if (status.references) references = status.references;
      if (Array.isArray(status.plugins)) plugins = status.plugins;
      if (status.kcsc) kcsc = status.kcsc;
      renderConnections();
      renderApprovals(status.approvals || []);
      controls();
    },
    sync: controls,
    refresh,
  };
}
