import { CadEditor } from './cad.js';
import { desktopRequest, executeDesktopCad, startDesktopBridge } from './desktop.js';
import { appendProvenance, createMcpSettings } from './mcp-settings.js';
import { createSkillMenu } from './skills.js';
import { createChatPanel } from './chat-panel.js';
import { createChatSessionsUI } from './chat-sessions.js';

const $ = (id) => document.getElementById(id);
const iframe = $('editor');
const cad = new CadEditor(iframe);
const history = [];
let ready = false;
let busy = false;
let connected = false;
let polling = false;
let desktop = false;
let browser = false;
let unsaved = false;
let stopBridge;
let authPending = false;
const mcpSettings = createMcpSettings({ isBusy: () => busy, notify: notice });
const skillMenu = createSkillMenu({ isBusy: () => busy, onChange: updateControls });
const chatPanel = createChatPanel();
const chatSessions = createChatSessionsUI({ isBusy: () => busy, isAvailable: () => desktop,
  onError: message => notice(errorMessage(message), true), onChange: updateControls,
  onSelect(chat) {
    history.splice(0); $('messages').replaceChildren(); $('message-input').value = '';
    for (const message of chat.messages ?? []) {
      if (!['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') continue;
      appendMessage(message.role, message.text);
      history.push({ role: message.role, text: message.text.slice(0, 2000) });
    }
    if (history.length > 8) history.splice(0, history.length - 8);
  } });

function updateControls() {
  document.querySelectorAll('[data-action]').forEach((button) => { button.disabled = busy || !ready; });
  document.querySelectorAll('[data-prompt]').forEach((button) => { button.disabled = busy || !ready || !connected; });
  $('message-input').disabled = busy || !ready || !connected || (desktop && chatSessions.isPending());
  $('send-message').disabled = busy || !ready || !connected || (desktop && (!chatSessions.currentId() || chatSessions.isPending())) || !$('message-input').value.trim();
  $('save-name').disabled = busy || !ready;
  $('file-input').disabled = busy || !ready;
  $('refresh-connection').disabled = busy;
  $('login-chatgpt').disabled = busy || authPending;
  $('logout-chatgpt').disabled = busy;
  $('cancel-task').hidden = !desktop || (!busy && !authPending);
  iframe.inert = busy || !ready;
  iframe.style.pointerEvents = busy || !ready ? 'none' : '';
  $('editor-stage').setAttribute('aria-busy', String(busy || !ready));
  mcpSettings.sync();
  skillMenu.sync();
  chatSessions.sync();
}

function overlay(message, working = false) {
  $('editor-overlay').hidden = !message;
  $('editor-overlay').classList.toggle('working', working);
  $('editor-progress-text').textContent = message || '';
  $('retry-editor').hidden = true;
  $('editor-overlay').querySelector('.spinner').hidden = false;
}

function notice(message = '', error = false) {
  $('workspace-notice').textContent = message;
  $('workspace-notice').hidden = !message;
  $('workspace-notice').classList.toggle('error', error);
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /stale|revision|document.*changed/i.test(message)
    ? '요청하는 동안 도면 또는 선택이 바뀌었습니다. 현재 도면을 확인한 뒤 다시 요청해 주세요.'
    : message;
}

async function runAction(label, action) {
  if (busy || !ready) return;
  busy = true;
  updateControls();
  notice();
  overlay(label, true);
  try {
    await action();
    await refreshDocument().catch(() => notice('작업은 완료되었지만 도면 상태 표시를 새로 고치지 못했습니다. 도면을 확인해 주세요.', true));
  } catch (error) {
    notice(errorMessage(error), true);
  } finally {
    busy = false;
    overlay(null);
    updateControls();
  }
}

function describeState(state) {
  const id = state.documentId ?? state.document_id;
  const doc = state.documents?.find((item) => item.id === id);
  const name = state.documentName ?? state.title ?? doc?.path ?? doc?.title ?? '새 도면';
  const units = state.units ?? state.insertion_units;
  const unitNames = { 0: '단위 미지정', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
  const unit = units == null ? '' : (unitNames[units] ?? (typeof units === 'string' ? units : ''));
  unsaved = Boolean(state.dirty ?? doc?.dirty);
  $('document-status').textContent = `${String(name).split(/[\\/]/).pop()}${unit ? ` · ${unit}` : ''}${(state.dirty ?? doc?.dirty) ? ' · 수정됨' : ''}`;
  const selection = state.selection ?? state.selected_handles ?? [];
  const count = Array.isArray(selection) ? selection.length : (selection.handles?.length ?? selection.count ?? 0);
  $('selection-status').textContent = `선택 ${count}개`;
}

async function refreshDocument() {
  if (ready) describeState(await cad.snapshot());
}

async function checkConnection() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || '서버 연결 상태를 확인하지 못했습니다.');
    connected = body.data.oauth?.connected === true;
    browser = body.data.browser === true;
    if (body.data.desktop) {
      desktop = true;
      $('chat-session-controls').hidden = false;
      document.querySelector('.composer-note').textContent = '경기도 광주시 주소만 입력하면 반경 100m의 필지·공개 등고선을 같은 위치·실척으로 넣어 DWG로 저장합니다. 다른 지역은 지형 원본 등록이 필요합니다. 일반 작도 치수는 mm 기준입니다.';
      authPending = body.data.auth?.pending === true;
      $('login-chatgpt').hidden = connected;
      $('logout-chatgpt').hidden = !body.data.auth?.loggedIn;
      $('mcp-status').hidden = false;
      $('mcp-status').textContent = body.data.runtime?.mcp?.contextVerified ? '내부 MCP 연결됨' : '내부 MCP · 첫 요청 시 연결';
      $('mcp-status').className = `status-badge ${body.data.runtime?.connected ? 'connected' : ''}`;
      $('auth-help').querySelector('p').textContent = authPending
        ? '열린 브라우저에서 ChatGPT 로그인과 SiteCAD 사용 동의를 완료해 주세요.'
        : body.data.auth?.error || (body.data.auth?.loggedIn && !body.data.auth?.sharing
          ? 'ChatGPT 요금제 사용 권한에 동의해야 AI 도구를 사용할 수 있습니다. 다시 로그인해 주세요.'
          : '위의 ChatGPT로 계속 버튼을 눌러 로그인하세요. Codex나 터미널을 따로 열 필요가 없습니다.');
      if (!stopBridge) stopBridge = startDesktopBridge(cad, { isReady: () => ready,
        onError: error => { if (!busy) notice(errorMessage(error), true); } });
    }
    $('oauth-status').textContent = connected ? 'OpenAI OAuth 연결됨' : 'OpenAI 로그인 필요';
    $('oauth-status').className = `status-badge ${connected ? 'connected' : 'disconnected'}`;
    if (authPending) $('oauth-status').textContent = 'ChatGPT 로그인 진행 중';
    $('auth-help').hidden = connected;
    mcpSettings.update(body.data);
    skillMenu.update(body.data);
    chatPanel.update(body.data);
    if (desktop) await chatSessions.init();
    if (body.data.editorInstalled === false) notice('OpenCADStudio 파일이 준비되지 않았습니다. 프로젝트 실행 안내를 확인해 주세요.', true);
  } catch (error) {
    connected = false;
    $('oauth-status').textContent = '서버 연결 확인 필요';
    $('oauth-status').className = 'status-badge disconnected';
    notice(errorMessage(error), true);
  }
  updateControls();
}

async function connectEditor() {
  ready = false;
  overlay('도면 편집기를 준비하고 있습니다.');
  updateControls();
  try {
    describeState(await cad.ready());
    ready = true;
    overlay(null);
    notice();
  } catch (error) {
    overlay(`편집기에 연결하지 못했습니다. ${errorMessage(error)}`);
    $('editor-overlay').querySelector('.spinner').hidden = true;
    $('retry-editor').hidden = false;
    $('document-status').textContent = '편집기 연결 실패';
  }
  updateControls();
}

function appendQuantityTable(article, report) {
  const section = document.createElement('section');
  section.className = 'quantity-report';
  const scroll = document.createElement('div');
  scroll.className = 'quantity-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '레이어별 물량검토 표, 가로 스크롤 가능');
  const table = document.createElement('table');
  const caption = table.createCaption();
  caption.textContent = `${report.documentName} · 레이어별 물량검토`;
  const heading = table.createTHead().insertRow();
  for (const title of ['레이어', '객체 수', '길이 (m)', '면적 (m²)']) {
    const th = document.createElement('th');
    th.scope = 'col'; th.textContent = title; heading.append(th);
  }
  const format = (value, count) => count ? value.toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '—';
  const addRow = (parent, row, name) => {
    const tr = parent.insertRow();
    const th = document.createElement('th');
    th.scope = 'row'; th.textContent = name; tr.append(th);
    tr.insertCell().textContent = row.count.toLocaleString('ko-KR');
    for (const [value, count] of [[row.lengthM, row.lengthCount], [row.areaM2, row.areaCount]]) {
      const cell = tr.insertCell();
      cell.textContent = format(value, count);
      cell.title = `측정 대상 ${count}/${row.count}개`;
      cell.setAttribute('aria-label', `${cell.textContent}, 측정 대상 ${count}/${row.count}개`);
    }
  };
  const body = table.createTBody();
  for (const row of report.rows) addRow(body, row, row.layer);
  addRow(table.createTFoot(), report.totals, '합계');
  scroll.append(table); section.append(scroll);
  const note = document.createElement('p');
  note.className = 'quantity-note';
  note.textContent = `${report.scope}. 길이 측정 ${report.totals.lengthCount}/${report.totals.count}개 · 폐합 면적 측정 ${report.totals.areaCount}/${report.totals.count}개. —는 측정 대상 없음입니다. 셀에 마우스를 올리면 레이어별 측정 대상 수를 확인할 수 있습니다. 집계 시점의 도면 결과이며 변경 후에는 다시 요청해 주세요.`;
  section.append(note);
  if (!report.rows.length) note.textContent = `모형 공간에 집계할 객체가 없습니다. ${note.textContent}`;
  article.append(section);
}

function appendMessage(role, text, { error = false, details, reports = [], sources = [], design, savedFiles = [] } = {}) {
  const article = document.createElement('article');
  article.className = `message ${role}${error ? ' error' : ''}`;
  const author = document.createElement('p');
  author.className = 'message-author';
  author.textContent = role === 'user' ? '나' : 'SiteCAD';
  const body = document.createElement('p');
  body.textContent = text;
  article.append(author, body);
  for (const report of reports) appendQuantityTable(article, report);
  appendProvenance(article, { sources, design });
  if (browser) for (const file of savedFiles) {
    if (typeof file.name !== 'string' || file.downloadUrl !== `/api/local/drawings/${encodeURIComponent(file.name)}` || !/^[a-f0-9]{64}$/.test(file.sha256)) continue;
    const link = document.createElement('a');
    link.href = file.downloadUrl; link.download = file.name; link.textContent = `${file.name} 다운로드`;
    const item = document.createElement('p'); item.append(link); article.append(item);
  }
  if (details) {
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    summary.textContent = '실행 내역';
    pre.textContent = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    disclosure.append(summary, pre);
    article.append(disclosure);
  }
  $('messages').append(article);
  if (reports.length) article.scrollIntoView({ block: 'start' });
  else $('messages').scrollTop = $('messages').scrollHeight;
}

async function submitMessage(event) {
  event.preventDefault();
  const message = $('message-input').value.trim();
  if (!message || busy) return;
  if (mcpSettings.handleCommand(message)) { $('message-input').value = ''; updateControls(); return; }
  if (!ready || !connected || (desktop && (!chatSessions.currentId() || chatSessions.isPending()))) return;
  const previousHistory = history.slice(-8);
  appendMessage('user', message);
  $('message-input').value = '';
  busy = true;
  updateControls();
  notice();
  overlay('자연어 요청을 처리하고 있습니다.', true);
  $('chat-progress-text').textContent = '도면을 확인하고 요청을 해석하고 있습니다.';
  $('chat-progress').hidden = false;
  try {
    const context = await cad.context();
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context, history: previousHistory, ...(desktop ? { chatId: chatSessions.currentId() } : {}) }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || '요청을 처리하지 못했습니다.');
    $('chat-progress-text').textContent = '도면에 적용하고 실행 결과를 확인하고 있습니다.';
    overlay('도면에 적용하고 결과를 확인하고 있습니다.', true);
    const result = body.data.executed ? { message: body.data.reply, details: body.data.details,
      reports: body.data.reports ?? [] } : await cad.executePlan(body.data);
    const reply = result.message || body.data.reply || '요청을 처리했습니다.';
    appendMessage('assistant', reply, { details: result.reports?.length ? { operations: result.details, reports: result.reports } : result.details, reports: result.reports,
      sources: body.data.sources, design: body.data.design, savedFiles: body.data.savedFiles });
    history.push({ role: 'user', text: message }, { role: 'assistant', text: reply.slice(0, 2000) });
    if (history.length > 8) history.splice(0, history.length - 8);
    await refreshDocument().catch(() => notice('작업은 완료되었지만 도면 상태 표시를 새로 고치지 못했습니다. 도면을 확인해 주세요.', true));
  } catch (error) {
    appendMessage('assistant', errorMessage(error), { error: true });
    $('message-input').value = message;
  } finally {
    if (desktop) {
      try { const result = await stopBridge?.cancel(); if (result?.cancelled) notice('미완료 명령의 입력 대기를 정리했습니다. 이미 반영된 객체는 도면에 남아 있을 수 있습니다.'); }
      catch (error) { notice(errorMessage(error), true); }
    }
    busy = false;
    if (desktop) await Promise.allSettled([skillMenu.refresh(), chatSessions.refresh(), mcpSettings.refresh()]);
    $('chat-progress').hidden = true;
    overlay(null);
    updateControls();
    $('message-input').focus();
  }
}

$('new-drawing').addEventListener('click', () => runAction('새 도면을 만들고 있습니다.', async () => {
  await cad.newDrawing();
  $('save-name').value = 'drawing.dwg';
  history.splice(0);
  notice('새 도면을 만들었습니다.');
}));
$('open-drawing').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) return notice('DWG 또는 DXF 파일을 선택해 주세요.', true);
  if (file.size > 30 * 1024 * 1024) return notice('이 시제품에서는 30MB 이하의 도면을 열 수 있습니다.', true);
  runAction('도면을 열고 있습니다.', async () => {
    await cad.openFile(file);
    $('save-name').value = file.name.replace(/\.(dwg|dxf)$/i, '') + '-edited.dwg';
    history.splice(0);
    notice(`${file.name} 도면을 열었습니다. 원본은 변경하지 않습니다.`);
  });
});
$('open-example').addEventListener('click', () => runAction('옹벽 예제 도면을 열고 있습니다.', async () => {
  const response = await fetch('/fixtures/retaining-wall.dwg');
  if (!response.ok) throw new Error('예제 도면을 불러오지 못했습니다.');
  await cad.openFile(new File([await response.arrayBuffer()], 'retaining-wall.dwg'));
  $('save-name').value = 'retaining-wall-edited.dwg';
  history.splice(0);
  await cad.fit();
  notice('옹벽 예제를 열었습니다. 도면에서 객체를 선택한 뒤 수정 요청을 입력해 보세요.');
}));
$('fit-drawing').addEventListener('click', () => runAction('전체 도면을 표시하고 있습니다.', () => cad.fit()));
$('undo-drawing').addEventListener('click', () => runAction('이전 작업을 되돌리고 있습니다.', async () => {
  await cad.undo();
  notice('실행 취소 요청을 처리했습니다. 도면을 확인해 주세요.');
}));
$('save-drawing').addEventListener('click', () => runAction('DWG 파일을 확인하고 저장하고 있습니다.', async () => {
  let name = $('save-name').value.trim();
  if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('저장할 파일 이름을 확인해 주세요. 경로나 특수문자는 사용할 수 없습니다.');
  if (!/\.dwg$/i.test(name)) name += '.dwg';
  if (browser) {
    const expectedContext = await cad.context();
    const result = await executeDesktopCad(cad, { method: 'save', payload: { name, expectedContext } });
    const response = await fetch('/api/local/drawings/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, result, expectedContext }) });
    const value = await response.json();
    if (!response.ok || !value.ok) throw Error(value.error || 'DWG 보관을 확인하지 못했습니다.');
    const anchor = document.createElement('a'); anchor.href = value.data.downloadUrl; anchor.download = value.data.name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    $('save-name').value = value.data.name;
    notice(`${value.data.name} 파일을 보관하고 동일한 DWG의 다운로드를 시작했습니다.`);
    return;
  }
  const result = await cad.save(name);
  if (!(result.bytes instanceof Blob || result.bytes instanceof ArrayBuffer || ArrayBuffer.isView(result.bytes))) throw new Error('편집기에서 유효한 DWG 파일을 받지 못했습니다.');
  const blob = result.bytes instanceof Blob ? result.bytes : new Blob([result.bytes], { type: 'application/acad' });
  if (!blob.size) throw new Error('저장된 DWG 파일이 비어 있습니다.');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.name || name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('save-name').value = result.name || name;
  notice(`${result.name || name} 파일 다운로드를 시작했습니다.`);
}));
$('chat-form').addEventListener('submit', submitMessage);
$('message-input').addEventListener('input', updateControls);
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  $('message-input').value = button.dataset.prompt;
  updateControls();
  $('message-input').focus();
}));
$('refresh-connection').addEventListener('click', checkConnection);
$('login-chatgpt').addEventListener('click', async () => {
  try {
    await desktopRequest('login');
    notice('브라우저에서 ChatGPT 로그인과 SiteCAD 사용 동의를 완료해 주세요.');
    await checkConnection();
  } catch (error) { notice(errorMessage(error), true); }
});
$('logout-chatgpt').addEventListener('click', async () => {
  try { await desktopRequest('logout'); await checkConnection(); notice('SiteCAD에서 로그아웃했습니다.'); }
  catch (error) { notice(errorMessage(error), true); }
});
$('cancel-task').addEventListener('click', async () => {
  try {
    const cleanup = stopBridge?.cancel();
    await desktopRequest('cancel');
    await cleanup;
    notice('작업을 취소했습니다. 이미 반영된 도면 변경은 실행 취소로 되돌릴 수 있습니다.');
    await checkConnection();
  } catch (error) { notice(errorMessage(error), true); }
});
$('retry-editor').addEventListener('click', connectEditor);
setInterval(async () => {
  if (!ready || busy || polling) return;
  polling = true;
  try { await refreshDocument(); }
  catch { $('document-status').textContent = '도면 상태 확인 지연 · 연결을 확인해 주세요'; }
  finally { polling = false; }
}, 1500);

await Promise.all([checkConnection(), connectEditor()]);
setInterval(() => { if (desktop) void checkConnection(); }, 2000);
addEventListener('pagehide', () => {
  stopBridge?.();
  if (browser && (busy || authPending)) void fetch('/api/desktop/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
});
addEventListener('beforeunload', event => {
  if (browser && (busy || unsaved)) { event.preventDefault(); event.returnValue = ''; }
});
