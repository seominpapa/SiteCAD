const MAX_REPLY_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const bounded = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

export async function readChatStream(response, onEvent) {
  if (!response.ok) throw Error('채팅 응답을 받지 못했습니다. 연결 상태를 확인해 주세요.');
  if (!response.body?.getReader) throw Error('채팅 스트림을 읽을 수 없습니다.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', total = 0, replies = 0, events = 0, terminal = false, ended = false, result;
  const line = raw => {
    if (!raw.trim()) return;
    if (encoder.encode(raw).byteLength > 2 * 1024 * 1024) throw Error('채팅 스트림 크기를 초과했습니다.');
    if (terminal) throw Error('완료 뒤 추가 응답이 있는 채팅 스트림입니다.');
    if (++events > 10000) throw Error('채팅 스트림 이벤트 횟수를 초과했습니다.');
    let value;
    try { value = JSON.parse(raw); } catch { throw Error('채팅 스트림 응답 형식을 확인하지 못했습니다.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('채팅 스트림 응답 형식이 올바르지 않습니다.');
    if (value.type === 'result') {
      if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw Error('최종 채팅 응답이 올바르지 않습니다.');
      terminal = true; result = value.data; return;
    }
    if (value.type === 'error') throw Error(bounded(value.message, 2000) || '채팅 스트림이 중단됐습니다.');
    if (value.type === 'delta' && typeof value.text === 'string') {
      replies += encoder.encode(value.text).byteLength;
      if (replies > MAX_REPLY_BYTES) throw Error('답변 크기를 초과했습니다.');
      onEvent({ type: 'delta', text: value.text });
    } else if (value.type === 'tool' && typeof value.name === 'string' && ['running', 'completed', 'failed'].includes(value.status)) {
      onEvent({ type: 'tool', id: bounded(value.id, 160), server: bounded(value.server, 100), name: bounded(value.name, 150), status: value.status });
    } else if (value.type === 'connected' && typeof value.model === 'string') onEvent({ type: 'connected', model: bounded(value.model, 160) });
    else throw Error('알 수 없는 채팅 스트림 응답입니다.');
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { ended = true; buffer += decoder.decode(); break; }
      total += next.value.byteLength;
      if (total > 8 * 1024 * 1024) throw Error('채팅 스트림 크기를 초과했습니다.');
      buffer += decoder.decode(next.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (encoder.encode(buffer).byteLength > 2 * 1024 * 1024) throw Error('채팅 스트림 크기를 초과했습니다.');
    }
    if (buffer) line(buffer);
    if (!terminal) throw Error('최종 응답 전에 채팅 스트림이 중단됐습니다. 도면 상태를 확인해 주세요.');
    return result;
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createChatRuntime({ isBusy, onError = () => {}, onChange = () => {} }) {
  const $ = id => document.getElementById(id);
  let supported = false, connected = false, loading = false, models = [], selected, selectedName, actualModel;
  let streaming = false, replyBytes = 0, tools = new Map();
  const available = () => supported && connected && !isBusy();
  const describe = () => { $('model-description').textContent = models.find(item => item.id === $('model-select').value)?.description ?? ''; };

  function sync() {
    $('model-choice').hidden = !supported;
    $('model-choice').disabled = !available() || loading;
    $('models-refresh').disabled = !available() || loading;
    $('model-select').disabled = !available() || loading || !models.length;
    $('model-apply').disabled = !available() || loading || !models.some(item => item.id === $('model-select').value);
    $('model-choice').textContent = `모델: ${selectedName ?? actualModel ?? '자동 선택'}`;
  }

  async function refresh() {
    if (!available() || loading) return;
    loading = true; $('model-notice').textContent = '모델 카탈로그를 확인하고 있습니다.'; sync();
    try {
      const response = await fetch('/api/desktop/models', { method: 'GET', cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.data?.models)) throw Error();
      const names = new Set();
      const next = result.data.models.slice(0, 500).filter(item => {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 160 || /[\x00-\x20]/.test(item.id) || names.has(item.id)) return false;
        names.add(item.id); return true;
      }).map(item => ({ id: item.id, displayName: bounded(item.displayName, 160) || item.id, description: bounded(item.description, 2000), isDefault: item.isDefault === true }));
      if (!next.length) throw Error();
      models = next;
      $('model-select').replaceChildren(...models.map(item => {
        const option = document.createElement('option'); option.value = item.id; option.textContent = item.displayName; return option;
      }));
      const defaultId = models.find(item => item.id === result.data.defaultModel)?.id ?? models.find(item => item.isDefault)?.id ?? models[0].id;
      const missing = selected !== undefined && !models.some(item => item.id === selected);
      $('model-select').value = missing ? '' : selected ?? defaultId;
      $('model-notice').textContent = missing ? '선택한 모델이 현재 카탈로그에 없습니다. 사용할 모델을 다시 선택해 주세요.' : 'Codex 모델 카탈로그입니다. 선택한 모델은 다음 요청부터 사용하며, 계정의 실행 권한은 요청 시 확인됩니다.';
      describe();
    } catch { $('model-notice').textContent = '모델 카탈로그를 불러오지 못했습니다. 기존 선택은 유지됩니다. 다시 시도해 주세요.'; }
    finally { loading = false; sync(); }
  }

  $('model-choice').addEventListener('click', async () => {
    if (!available() || loading) return;
    if (!$('model-dialog').open) $('model-dialog').showModal();
    await refresh();
  });
  $('models-refresh').addEventListener('click', refresh);
  $('model-select').addEventListener('change', () => { describe(); sync(); });
  $('model-apply').addEventListener('click', () => {
    if (!available() || loading) return;
    const model = models.find(item => item.id === $('model-select').value);
    if (!model) { onError('카탈로그에서 사용할 모델을 선택해 주세요.'); return; }
    selected = model.id; selectedName = model.displayName;
    $('model-dialog').close(); sync(); onChange();
  });

  const toolText = item => `${item.server ? `${item.server} · ` : ''}${item.name} · ${{ running: '실행 중', completed: '완료', failed: '실패', unknown: '실행 상태 확인 필요' }[item.status]}`;
  return {
    update(status) {
      supported = status.desktop === true; connected = status.oauth?.connected === true;
      if (typeof status.runtime?.model === 'string') actualModel = bounded(status.runtime.model, 160);
      sync();
    },
    sync,
    selectedModel: () => selected,
    begin() {
      streaming = true; replyBytes = 0; tools = new Map();
      $('chat-live-text').textContent = ''; $('chat-live-tools').replaceChildren();
      $('chat-live-status').textContent = '답변을 준비하고 있습니다.'; $('chat-live').hidden = false;
    },
    event(value) {
      if (!streaming) return;
      if (value?.type === 'delta' && typeof value.text === 'string') {
        replyBytes += encoder.encode(value.text).byteLength;
        if (replyBytes > MAX_REPLY_BYTES) throw Error('답변 크기를 초과했습니다.');
        $('chat-live-text').textContent += value.text; $('chat-live-status').textContent = '답변 중';
      } else if (value?.type === 'connected') $('chat-live-status').textContent = '모델과 도구가 연결됐습니다.';
      else if (value?.type === 'tool' && typeof value.name === 'string' && ['running', 'completed', 'failed'].includes(value.status)) {
        const server = bounded(value.server, 100), name = bounded(value.name, 150), id = bounded(value.id, 160) || `${server}:${name}`;
        const previous = tools.get(id);
        if (!previous && tools.size >= 128) return;
        const row = previous?.row ?? document.createElement('p'); row.className = 'chat-live-tool';
        const item = { row, server, name, status: value.status };
        row.textContent = toolText(item); if (!previous) $('chat-live-tools').append(row);
        tools = new Map([...tools, [id, item]]);
        $('chat-live-status').textContent = value.status === 'running' ? `${name} 실행 중` : '다음 응답을 확인하고 있습니다.';
      }
    },
    finish() { streaming = false; $('chat-live').hidden = true; },
    fail(message) {
      streaming = false; $('chat-live-status').textContent = bounded(message, 1000) || '응답이 중단됐습니다. 도면 상태를 확인해 주세요.';
      for (const item of tools.values()) if (item.status === 'running') item.row.textContent = toolText({ ...item, status: 'unknown' });
    },
  };
}
