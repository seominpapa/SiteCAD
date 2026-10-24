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

export function parseMcpCommand(message) {
  const match = message.trim().match(/^\/mcp(?:\s+add(?:\s+([\s\S]*))?)?\s*$/i);
  if (match) return { config: match[1] ?? '' };
  if (/^REA\s*(?:MCP\s*)?(?:를\s*)?(?:추가|등록|연결)(?:해\s*줘|해줘|해주세요|해|하기)?[.!]?$/i.test(message.trim())) return { preset: 'rea' };
  if (/^(?:VWorld|브이월드)\s*(?:API\s*)?(?:를\s*)?(?:추가|등록|연결)(?:해\s*줘|해주세요|하기)?[.!]?$/i.test(message.trim())) return { reference: 'vworld' };
  if (/^설계\s*기준\s*(?:을\s*)?연결(?:해\s*줘|해주세요|하기)?[.!]?$/.test(message.trim())) return { reference: 'standards' };
  if (/^지형\s*원본\s*(?:을\s*)?등록(?:해\s*줘|해주세요|하기)?[.!]?$/.test(message.trim())) return { reference: 'terrain' };
  return null;
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
  let browser = false;
  let pending = false;
  let presets = {};
  let presetDetails = {};
  let vworldConfigured = false;
  let vworldDomain = '';

  function referenceNotice(message = '', error = false) {
    $('vworld-notice').textContent = message;
    $('vworld-notice').hidden = !message;
    $('vworld-notice').classList.toggle('error', error);
  }

  function renderReferences(data) {
    const state = data?.vworld || {};
    vworldConfigured = state.configured === true;
    vworldDomain = typeof state.domain === 'string' ? state.domain : '';
    $('vworld-domain').value = vworldDomain;
    const checkedAt = state.lastCheck?.checkedAt ? ` · ${text(state.lastCheck.checkedAt, 60)}` : '';
    $('vworld-status').textContent = !vworldConfigured ? '키 미등록' : state.lastCheck?.ok === true
      ? `연결 확인됨${checkedAt}` : state.lastCheck?.ok === false ? `키 저장됨 · 연결 확인 실패${checkedAt}` : '키 저장됨 · 실제 연결 미확인';
    controls();
  }

  async function refreshReferences() { renderReferences(await request('references')); }

  function terrainNotice(message = '', error = false) {
    $('terrain-notice').textContent = message;
    $('terrain-notice').hidden = !message;
    $('terrain-notice').classList.toggle('error', error);
  }

  async function refreshTerrain() {
    const { datasets = [] } = await request('terrain');
    $('terrain-datasets').replaceChildren();
    if (!datasets.length) {
      const empty = document.createElement('p'); empty.className = 'mcp-empty';
      empty.textContent = '등록된 지형 원본이 없습니다. 파일을 선택하거나 채팅에 공개 GeoJSON 주소를 입력해 등록·삽입을 요청하세요.';
      $('terrain-datasets').append(empty);
    }
    for (const dataset of datasets) {
      const item = document.createElement('p'); item.className = 'source-meta';
      item.textContent = `${text(dataset.title || dataset.id, 200)} · ${text(dataset.originalCRS, 100)} · ${!dataset.verticalDatum || dataset.verticalDatum === 'unknown' ? '표고 기준 미확인 · 원본 높이 보존' : text(dataset.verticalDatum, 200)}${dataset.sourceKind === 'public-download' ? ` · ${text(dataset.sourceLabel, 200)}` : ''}`;
      $('terrain-datasets').append(item);
    }
  }

  function presetPreview() {
    $('mcp-preset-preview').hidden = true;
    let config;
    try { config = JSON.parse($('mcp-config').value); }
    catch { return; }
    const detail = presetDetails[config?.preset];
    if (!detail?.command) return;
    $('mcp-preset-command').textContent = `실행 파일: ${text(detail.command)}\n인수: ${text(JSON.stringify(detail.args || []))}`;
    $('mcp-preset-preview').hidden = false;
  }

  async function request(path, body) {
    const response = await fetch(`/api/desktop/${path}`, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error(result.error || 'MCP 요청을 처리하지 못했습니다.');
    return result.data;
  }

  function notice(message = '', error = false) {
    $('mcp-notice').textContent = text(message);
    $('mcp-notice').hidden = !message;
    $('mcp-notice').classList.toggle('error', error);
  }

  function controls() {
    $('manage-mcp').hidden = !supported;
    $('manage-mcp').disabled = isBusy();
    for (const control of dialog.querySelectorAll('button:not([type="submit"]), textarea, input')) control.disabled = pending || isBusy() || control.dataset.unavailable === 'true';
    $('mcp-save').disabled = pending || isBusy() || !$('mcp-trusted').checked || !$('mcp-config').value.trim();
    $('vworld-save').disabled = pending || isBusy() || !$('vworld-save-consent').checked || !$('vworld-api-key').value.trim();
    $('vworld-test').disabled = pending || isBusy() || !vworldConfigured || !$('vworld-test-consent').checked;
    $('vworld-remove').disabled = pending || isBusy() || !vworldConfigured;
  }

  async function action(task) {
    if (pending || isBusy()) return;
    pending = true; controls(); notice();
    try { await task(); }
    catch (error) { notice(error.message, true); }
    finally { pending = false; controls(); }
  }

  function serverAction(label, name, task) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.setAttribute('aria-label', `${name} ${label}`);
    button.addEventListener('click', () => action(task));
    return button;
  }

  function renderServers(servers) {
    $('mcp-server-list').replaceChildren();
    const enabled = servers.filter(server => server.enabled);
    const connected = servers.filter(server => server.enabled && server.connected);
    $('external-mcp-status').hidden = !supported;
    $('external-mcp-status').textContent = !servers.length ? '외부 MCP 없음' : `외부 MCP ${connected.length} 연결 · ${enabled.length} 활성`;
    if (!servers.length) {
      const empty = document.createElement('p'); empty.className = 'mcp-empty'; empty.textContent = '등록된 외부 서버가 없습니다. 내부 도면 도구는 그대로 사용할 수 있습니다.'; $('mcp-server-list').append(empty);
    }
    for (const server of servers) {
      const card = document.createElement('article'); card.className = 'mcp-server';
      const header = document.createElement('div'); header.className = 'mcp-server-heading';
      const name = document.createElement('strong'); name.textContent = text(server.name, 100);
      const status = document.createElement('span'); status.className = `mcp-server-state${server.connected ? ' connected' : ''}`;
      status.textContent = !server.enabled ? '사용 안 함' : server.connected ? '연결됨' : server.status === 'authenticationRequired' ? '인증 필요' : server.status === 'failed' ? '연결 실패' : '연결 확인 필요'; header.append(name, status);
      const target = document.createElement('p'); target.className = 'mcp-server-target';
      target.textContent = text(server.command ? [server.command, ...(server.args || [])].join(' ') : server.url || server.transport, 1000);
      const meta = document.createElement('p'); meta.className = 'source-meta';
      const toolCount = Array.isArray(server.tools) ? server.tools.length : null;
      meta.textContent = `${text(server.transport || 'MCP', 30)}${toolCount == null ? '' : ` · 도구 ${toolCount}개`}${server.envKeys?.length ? ` · 환경변수 ${server.envKeys.map(key => text(key, 80)).join(', ')}` : ''}`;
      const actions = document.createElement('div'); actions.className = 'mcp-server-actions';
      const test = serverAction('연결 확인', server.name, async () => {
        const result = await request('mcp/test', { name: server.name });
        const verified = result?.tested === true || (result?.tested !== false && (result?.connected === true || result?.status === 'connected'));
        const count = Array.isArray(result?.tools) ? ` · 도구 ${result.tools.length}개` : ' · 도구 수 미확인';
        const outcome = verified ? '연결됨' : result?.status === 'authenticationRequired' ? '인증이 필요합니다.' : '연결을 확인하지 못했습니다.';
        await refresh();
        notice(`${server.name}: ${outcome}${count}${!verified && result?.message ? ` · ${text(result.message, 500)}` : ''}`, !verified);
      });
      test.disabled = !server.enabled;
      test.dataset.unavailable = String(!server.enabled);
      actions.append(test,
        serverAction(server.enabled ? '사용 중지' : '활성화', server.name, async () => { await request('mcp/toggle', { name: server.name, enabled: !server.enabled }); await refresh(); }),
        serverAction('삭제', server.name, async () => { await request('mcp/remove', { name: server.name }); await refresh(); notice(`${server.name} 등록을 삭제했습니다.`); }));
      card.append(header, target, meta);
      if (server.error) { const error = document.createElement('p'); error.className = 'mcp-inline-error'; error.textContent = text(server.error, 1000); card.append(error); }
      card.append(actions); $('mcp-server-list').append(card);
    }
  }

  async function refresh() {
    const data = await request('mcp'); presets = data.presets || {}; presetDetails = data.presetDetails || {};
    renderServers(data.servers || []); presetPreview();
  }

  async function open(config, preset, reference) {
    if (!supported) { notify('외부 MCP 등록은 SiteCAD 로컬 실행기로 시작한 앱에서 사용할 수 있습니다.', true); return; }
    if (isBusy()) return;
    if (!dialog.open) dialog.showModal();
    $('mcp-trusted').checked = false; notice();
    if (config !== undefined) $('mcp-config').value = config;
    await action(async () => {
      await Promise.all([refresh(), refreshReferences(), refreshTerrain()]);
      if (preset) {
        if (!presets[preset]) throw Error('REA 사전 설정을 찾지 못했습니다. 서버의 REA 설치 상태를 확인해 주세요.');
        $('mcp-config').value = JSON.stringify(presets[preset], null, 2);
        presetPreview();
        notice('REA 사전 설정입니다. 실행 범위를 검토하고 신뢰 확인 후 등록해 주세요.');
      }
    });
    controls();
    if (reference === 'vworld') $('vworld-api-key').focus();
    if (reference === 'standards') $('reference-standards').focus();
    if (reference === 'terrain') $('reference-terrain').focus();
    if (config !== undefined || preset) $('mcp-config').focus();
  }

  function renderApprovals(items = []) {
    const current = new Set(items.map(item => item.id));
    for (const [id, card] of approvals) if (!current.has(id)) { card.remove(); approvals.delete(id); }
    for (const item of items) {
      if (approvals.has(item.id)) continue;
      const card = document.createElement('article'); card.className = 'tool-approval';
      const installing = item.kind === 'mcp-install';
      const replacingSkill = item.kind === 'skill-overwrite';
      const title = document.createElement('strong'); title.textContent = installing ? 'MCP 설치·연결 승인' : replacingSkill ? '스킬 덮어쓰기 승인' : '외부 도구 실행 승인';
      const name = document.createElement('p'); name.textContent = `${text(item.server, 100)} · ${text(item.tool, 150)}`;
      const argumentText = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}, null, 2);
      const reviewLimit = replacingSkill ? MAX_SKILL_REVIEW_TEXT : MAX_TEXT;
      const truncated = argumentText.length > reviewLimit;
      const args = document.createElement('pre'); args.textContent = text(argumentText, reviewLimit);
      const note = document.createElement('p'); note.className = 'source-meta';
      note.textContent = installing
        ? '표시한 패키지를 설치하고 이 SiteCAD 전용 설정에 연결합니다. 로컬 서버는 사용자 권한으로 실행되어 자신의 권한에 따라 파일을 읽거나 네트워크에 접근할 수 있습니다. 내용을 확인한 뒤 승인하거나 거절하세요.'
        : replacingSkill ? '표시된 내용으로 이 SiteCAD의 기존 스킬을 교체합니다. 이후 해당 슬래시 명령에도 변경된 지침이 적용됩니다.'
        : '표시된 입력으로 이 도구를 한 번 실행합니다. 내용을 확인한 뒤 승인하거나 거절하세요.';
      if (truncated) note.textContent = `입력이 길어 앞 ${reviewLimit.toLocaleString('ko-KR')}자만 표시합니다. 전체 입력을 확인할 수 없으므로 이 요청은 거절하고 범위를 줄여 다시 요청해 주세요.`;
      const error = document.createElement('p'); error.className = 'mcp-inline-error'; error.hidden = true;
      const actions = document.createElement('div'); actions.className = 'mcp-server-actions';
      for (const [label, approved] of [[installing ? '설치·연결 승인' : replacingSkill ? '덮어쓰기 승인' : '1회 승인', true], ['거절', false]]) {
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

  $('manage-mcp').addEventListener('click', () => { void open(); });
  $('reference-standards-open').addEventListener('click', () => $('reference-standards').focus());
  $('reference-rea-open').addEventListener('click', () => { void open(undefined, 'rea'); });
  $('reference-vworld-open').addEventListener('click', () => $('vworld-api-key').focus());
  $('reference-terrain-open').addEventListener('click', () => $('reference-terrain').focus());
  $('terrain-import').addEventListener('click', () => {
    if (browser) { $('terrain-files').value = ''; $('terrain-files').click(); return; }
    return action(async () => {
    terrainNotice();
    try {
      const result = await request('terrain/import', {});
      if (result?.cancelled) return terrainNotice('원본 파일 선택을 취소했습니다.');
      await refreshTerrain(); terrainNotice('지형 원본을 등록했습니다. 채팅에서 조회 범위와 도면 삽입을 요청하세요.');
    } catch { terrainNotice('지형 원본을 등록하지 못했습니다. SHP·DBF·PRJ 또는 GeoJSON의 좌표계와 표고 속성을 확인해 주세요.', true); }
    });
  });
  $('terrain-files').addEventListener('change', () => action(async () => {
    const files = [...($('terrain-files').files || [])];
    if (!files.length) return;
    if (files.length > 3 || files.reduce((total, file) => total + file.size, 0) > 128 * 1024 * 1024) throw Error('지형 원본은 최대 3개, 합계 128MiB 이하로 선택해 주세요.');
    const form = new FormData(); for (const file of files) form.append('files', file);
    const response = await fetch('/api/local/terrain/import', { method: 'POST', body: form });
    const value = await response.json();
    if (!response.ok || !value.ok) throw Error(value.error || '지형 원본을 등록하지 못했습니다.');
    await refreshTerrain(); terrainNotice('업로드한 지형 원본을 등록했습니다. 채팅에서 도면 삽입을 요청하세요.');
  }));
  $('mcp-refresh').addEventListener('click', () => action(refresh));
  $('mcp-rea-preset').addEventListener('click', () => { void open(undefined, 'rea'); });
  $('mcp-trusted').addEventListener('change', controls);
  $('mcp-config').addEventListener('input', () => { $('mcp-trusted').checked = false; presetPreview(); controls(); });
  $('mcp-config-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('mcp-trusted').checked) return notice('실행 설정을 확인한 뒤 신뢰 확인란에 체크해 주세요.', true);
    void action(async () => {
      let config;
      try { config = JSON.parse($('mcp-config').value); }
      catch { throw Error('설정이 올바른 JSON인지 확인해 주세요.'); }
      if (!config || Array.isArray(config) || typeof config !== 'object') throw Error('서버 설정은 JSON 객체여야 합니다.');
      await request('mcp/save', { config, trusted: true });
      $('mcp-config').value = ''; $('mcp-trusted').checked = false; await refresh(); notice('서버를 등록했습니다. 연결 확인을 눌러 실제 연결을 확인하세요.');
    });
  });

  for (const id of ['vworld-api-key', 'vworld-domain']) $(id).addEventListener('input', () => {
    $('vworld-save-consent').checked = false; $('vworld-test-consent').checked = false; controls();
  });
  for (const id of ['vworld-save-consent', 'vworld-test-consent']) $(id).addEventListener('change', controls);
  dialog.addEventListener('close', () => {
    $('vworld-api-key').value = ''; $('vworld-save-consent').checked = false; $('vworld-test-consent').checked = false;
  });
  $('vworld-form').addEventListener('submit', event => {
    event.preventDefault();
    if (pending || isBusy()) return;
    if (!$('vworld-save-consent').checked) return referenceNotice('키 저장 범위를 확인한 뒤 동의해 주세요.', true);
    const apiKey = $('vworld-api-key').value.trim();
    const domain = $('vworld-domain').value.trim();
    if (!apiKey || /\s|[\x00-\x1f]/.test(apiKey)) return referenceNotice('API 키를 확인해 주세요. 공백은 사용할 수 없습니다.', true);
    if (/[\x00-\x1f\s]/.test(domain)) return referenceNotice('등록 도메인에는 공백을 사용할 수 없습니다.', true);
    $('vworld-api-key').value = ''; $('vworld-save-consent').checked = false; $('vworld-test-consent').checked = false;
    void action(async () => {
      referenceNotice();
      try {
        const saved = await request('references/save', { apiKey, ...(domain ? { domain } : {}) });
        renderReferences({ vworld: saved?.vworld || saved });
        referenceNotice('API 키를 저장했습니다. 실제 연결은 별도 동의 후 확인해 주세요.');
      } catch { referenceNotice('API 키를 저장하지 못했습니다. 키와 등록 도메인을 확인한 뒤 다시 입력해 주세요.', true); }
    });
  });
  $('vworld-test').addEventListener('click', () => {
    if (pending || isBusy() || !vworldConfigured || !$('vworld-test-consent').checked) return;
    $('vworld-test-consent').checked = false;
    return action(async () => {
      referenceNotice();
      try {
        const result = await request('references/test', {});
        renderReferences({ vworld: { configured: true, domain: vworldDomain, lastCheck: { ok: result?.ok === true, checkedAt: result?.checkedAt } } });
        referenceNotice(result?.ok === true ? 'VWorld 실제 연결을 확인했습니다. 지정한 주소를 한 번 조회했습니다.' : 'VWorld 연결 확인에 실패했습니다. 키 권한과 등록 도메인을 확인해 주세요.', result?.ok !== true);
      } catch { referenceNotice('VWorld 연결을 확인하지 못했습니다. 키 권한과 등록 도메인, 네트워크를 확인해 주세요.', true); }
    });
  });
  $('vworld-remove').addEventListener('click', () => {
    if (pending || isBusy() || !vworldConfigured) return;
    return action(async () => {
      try {
        await request('references/remove', {}); renderReferences({ vworld: { configured: false } });
        $('vworld-api-key').value = ''; $('vworld-save-consent').checked = false; $('vworld-test-consent').checked = false;
        referenceNotice('VWorld 키 연결을 해제했습니다.');
      } catch { referenceNotice('키 연결을 해제하지 못했습니다. 다시 시도해 주세요.', true); }
    });
  });

  return {
    update(status) {
      supported = status.desktop === true;
      browser = status.browser === true;
      if (!supported) $('external-mcp-status').hidden = true;
      if (status.externalMcp?.servers) renderServers(status.externalMcp.servers);
      renderApprovals(status.approvals || []);
      controls();
    },
    sync: controls,
    refresh,
    handleCommand(message) {
      const command = parseMcpCommand(message);
      if (!command) return false;
      void open(command.config, command.preset, command.reference); return true;
    },
  };
}
