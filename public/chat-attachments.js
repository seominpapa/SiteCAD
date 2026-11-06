const MiB = 1024 * 1024;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sizeLabel = size => size >= MiB ? `${(size / MiB).toFixed(1)}MB` : `${Math.max(1, Math.ceil(size / 1024))}KB`;

export function appendAttachmentSummary(article, attachments = []) {
  const values = attachments.filter(item => item && typeof item.name === 'string' && item.name.length <= 255 && Number.isFinite(item.size) && item.size >= 0).slice(0, 4);
  if (!values.length) return;
  const list = document.createElement('ul'); list.className = 'message-attachments'; list.setAttribute('aria-label', '첨부 파일');
  for (const item of values) {
    const row = document.createElement('li'); row.textContent = `첨부 · ${item.name} · ${sizeLabel(item.size)}`;
    if (typeof item.warning === 'string' && item.warning) { const warning = document.createElement('span'); warning.textContent = item.warning.slice(0, 1000); row.append(warning); }
    list.append(row);
  }
  article.append(list);
}

export function createChatAttachments({ isBusy, getChatId, onChange = () => {}, onPending = () => {}, notify = () => {} }) {
  const $ = id => document.getElementById(id);
  let supported = false, pending = false, generation = 0, serial = 0, request;
  let items = [];
  const available = () => supported && !pending && !isBusy() && Boolean(getChatId());
  const status = message => { $('chat-attachment-status').textContent = message; };
  const metadata = () => items.filter(item => item.status === 'ready').map(item => item.metadata);
  const announce = message => { status(message); notify(message, true); };

  function sync() {
    const unlocked = available();
    $('chat-attach').disabled = !unlocked || items.length >= 4;
    $('chat-attachment-input').disabled = !unlocked;
    $('chat-attachment-list').hidden = !items.length;
    $('chat-attachment-list').replaceChildren();
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'chat-attachment';
      if (item.preview) { const image = document.createElement('img'); image.src = item.preview; image.alt = `${item.file.name} 미리보기`; row.append(image); }
      const description = document.createElement('span'); description.className = 'chat-attachment-name';
      description.textContent = `${item.file.name} · ${sizeLabel(item.file.size)}${item.status === 'uploading' ? ' · 올리는 중…' : item.status === 'failed' ? ' · 업로드 실패' : ''}`;
      if (item.metadata?.warning) { const warning = document.createElement('small'); warning.textContent = item.metadata.warning; description.append(warning); }
      row.append(description);
      if (item.status === 'failed') {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '다시 올리기'; retry.disabled = !unlocked;
        retry.addEventListener('click', () => { if (available()) return upload([item]); }); row.append(retry);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.disabled = !unlocked; remove.setAttribute('aria-label', `${item.file.name} 첨부 제거`);
      remove.addEventListener('click', () => {
        if (!available()) return;
        if (item.preview) URL.revokeObjectURL(item.preview);
        items = items.filter(value => value.key !== item.key); status(items.length ? `${items.length}개 파일이 첨부되어 있습니다.` : ''); sync(); onChange();
      });
      row.append(remove); $('chat-attachment-list').append(row);
    }
  }

  function validate(files) {
    if (files.length + items.length > 4) throw Error('한 번에 최대 4개 파일을 첨부할 수 있습니다.');
    if (files.reduce((sum, file) => sum + file.size, items.reduce((sum, item) => sum + item.file.size, 0)) > 20 * MiB) throw Error('첨부 파일의 합계는 20MB 이하여야 합니다.');
    for (const file of files) {
      const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
      const limit = ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? 5 : extension === 'pdf' ? 10 : ['txt', 'md', 'csv', 'json'].includes(extension) ? 1 : 0;
      if (!limit) throw Error('PNG·JPG·WEBP·PDF·TXT·MD·CSV·JSON 파일을 지원합니다. DWG·DXF는 상단 ‘열기’로 도면을 열어 주세요.');
      if (!file.size || file.size > limit * MiB) throw Error(`${file.name}: 파일은 비어 있지 않은 ${limit}MB 이하 파일이어야 합니다.`);
    }
  }

  async function upload(selected) {
    if (!available()) return;
    const current = generation, chatId = getChatId(), keys = new Set(selected.map(item => item.key));
    items = items.map(item => keys.has(item.key) ? { ...item, status: 'uploading' } : item);
    pending = true; onPending(true); sync(); onChange(); status('첨부 파일을 로컬에 저장하고 있습니다.');
    request = new AbortController();
    try {
      const form = new FormData(); form.set('chatId', chatId); for (const item of selected) form.append('files', item.file, item.file.name);
      const response = await fetch('/api/desktop/chat/attachments', { method: 'POST', body: form, signal: AbortSignal.any([request.signal, AbortSignal.timeout(90000)]) });
      const body = await response.json();
      if (current !== generation || chatId !== getChatId()) return;
      const uploaded = body.data?.attachments;
      if (!response.ok || !body.ok) throw Error(body.error || '첨부 파일을 저장하지 못했습니다.');
      if (!Array.isArray(uploaded) || uploaded.length !== selected.length || uploaded.some((item, index) => !item || !idPattern.test(item.id) || typeof item.name !== 'string' || item.name.length > 255 || item.size !== selected[index].file.size || !['image', 'text', 'pdf'].includes(item.kind))) throw Error('첨부 파일 저장 결과를 확인하지 못했습니다.');
      const results = new Map(selected.map((item, index) => [item.key, { id: uploaded[index].id, name: uploaded[index].name, mimeType: String(uploaded[index].mimeType ?? ''), size: uploaded[index].size, kind: uploaded[index].kind,
        ...(typeof uploaded[index].warning === 'string' ? { warning: uploaded[index].warning.slice(0, 1000) } : {}) }]));
      items = items.map(item => results.has(item.key) ? { ...item, status: 'ready', metadata: results.get(item.key) } : item);
      status(`${items.length}개 첨부 준비 완료. 전송하면 선택한 AI 서비스에 전달됩니다.`);
    } catch (error) {
      if (current !== generation) return;
      items = items.map(item => keys.has(item.key) ? { ...item, status: 'failed' } : item);
      announce(error.name === 'TimeoutError' ? '첨부 저장 시간이 초과됐습니다. 다시 올리기를 눌러 주세요.' : error.message || '첨부 파일을 저장하지 못했습니다. 다시 올리기를 눌러 주세요.');
    } finally {
      if (current === generation) { pending = false; request = undefined; onPending(false); sync(); onChange(); }
    }
  }

  async function add(files) {
    if (!files.length) return;
    if (!available()) { announce('현재 작업이 끝난 뒤 파일을 첨부해 주세요.'); return; }
    try { validate(files); } catch (error) { announce(error.message); return; }
    const selected = files.map(file => ({ key: ++serial, file, status: 'queued', preview: /^image\/(png|jpeg|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined }));
    items = [...items, ...selected]; return upload(selected);
  }

  $('chat-attach').addEventListener('click', () => { if (available()) $('chat-attachment-input').click(); });
  $('chat-attachment-input').addEventListener('change', event => { const input = event?.target ?? $('chat-attachment-input'); const files = Array.from(input.files ?? []); input.value = ''; return add(files); });
  $('message-input').addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files ?? []); if (!files.length) return;
    event.preventDefault(); return add(files);
  });
  const panel = $('sitecad-chat-panel');
  for (const name of ['dragenter', 'dragover']) panel.addEventListener(name, event => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault(); panel.classList.toggle('attachment-dragover', true); if (event.dataTransfer) event.dataTransfer.dropEffect = available() ? 'copy' : 'none';
  });
  panel.addEventListener('dragleave', event => { if (!panel.contains?.(event.relatedTarget)) panel.classList.toggle('attachment-dragover', false); });
  panel.addEventListener('drop', event => { const files = Array.from(event.dataTransfer?.files ?? []); if (!files.length) return; event.preventDefault(); panel.classList.toggle('attachment-dragover', false); return add(files); });

  return {
    sync, metadata, ids: () => metadata().map(item => item.id), hasFiles: () => items.length > 0, ready: () => !pending && items.every(item => item.status === 'ready'),
    clear() { generation++; request?.abort(); request = undefined; for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview); items = []; pending = false; onPending(false); status(''); sync(); },
    update(value) { supported = value.desktop === true; sync(); },
  };
}
