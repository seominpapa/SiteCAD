const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const preferenceKey = 'sitecad.currentChatId';

export function createChatSessionsUI({ isBusy = () => false, isAvailable = () => true, onSelect, onError = () => {}, onChange = () => {} } = {}) {
  const button = document.getElementById('chat-new'), select = document.getElementById('chat-select'), status = document.getElementById('chat-history-status');
  const deleteButton = document.getElementById('chat-delete');
  let selectedId = null, summaries = [], initialized = false, initializing, pending = false, deleteConfirmation;

  function sync() {
    button.disabled = select.disabled = !isAvailable() || isBusy() || pending;
    if (!isAvailable() || isBusy()) deleteConfirmation = undefined;
    deleteButton.disabled = button.disabled || !selectedId;
    deleteButton.textContent = deleteConfirmation === selectedId ? '삭제 확인' : '삭제';
    status.textContent = pending ? '채팅 기록을 불러오고 있습니다.' : deleteConfirmation === selectedId ? '현재 채팅 기록을 삭제하려면 ‘삭제 확인’을 다시 누르세요. 도면 파일은 유지됩니다.' : '채팅 맥락과 기록은 구분되며, 현재 도면은 함께 사용합니다.';
  }
  function setPending(value) { pending = value; sync(); onChange(); }
  async function request(path, body) {
    const response = await fetch(`/api/desktop/chats${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error(result.error || '채팅 기록을 불러오지 못했습니다.');
    return result.data;
  }
  function render() {
    select.replaceChildren();
    for (const chat of summaries) {
      const option = document.createElement('option');
      option.value = chat.id; option.textContent = chat.title;
      select.append(option);
    }
    select.value = selectedId ?? '';
  }
  async function loadList() {
    const result = await request('');
    if (!Array.isArray(result?.chats) || result.chats.some(chat => !ID.test(chat?.id ?? '') || typeof chat.title !== 'string')) throw Error('채팅 목록 형식을 확인해 주세요.');
    summaries = result.chats;
    render();
  }
  async function selectChat(chat) {
    if (!ID.test(chat?.id ?? '') || !Array.isArray(chat.messages)) throw Error('채팅 기록 형식을 확인해 주세요.');
    await onSelect(chat);
    selectedId = chat.id;
    try { globalThis.localStorage?.setItem(preferenceKey, selectedId); } catch { /* Browser preferences can be unavailable; transcripts remain on the server. */ }
    render();
  }
  async function create() {
    if (!isAvailable() || isBusy() || pending) return;
    deleteConfirmation = undefined;
    setPending(true);
    try {
      const { chat } = await request('/new', {});
      await selectChat(chat); await loadList();
    } catch (error) { onError(error); }
    finally { setPending(false); }
  }
  button.addEventListener('click', create);
  deleteButton.addEventListener('click', async () => {
    if (!isAvailable() || isBusy() || pending || !ID.test(selectedId ?? '')) return;
    if (deleteConfirmation !== selectedId) { deleteConfirmation = selectedId; sync(); return; }
    const id = selectedId;
    deleteConfirmation = undefined;
    setPending(true);
    try {
      const result = await request('/delete', { id });
      if (result?.id !== id || result.deleted !== true) throw Error('채팅 삭제 결과를 확인하지 못했습니다.');
      summaries = summaries.filter(chat => chat.id !== id);
      selectedId = null;
      try { globalThis.localStorage?.removeItem(preferenceKey); } catch { /* ID preference is optional. */ }
      render();
      const nextId = summaries[0]?.id;
      const { chat } = nextId ? await request(`/${nextId}`) : await request('/new', {});
      await selectChat(chat); await loadList();
    } catch (error) { onError(error); }
    finally { setPending(false); }
  });
  select.addEventListener('change', async () => {
    const requestedId = select.value;
    if (!isAvailable() || isBusy() || pending || !ID.test(requestedId)) { select.value = selectedId ?? ''; return; }
    deleteConfirmation = undefined;
    setPending(true);
    try { const { chat } = await request(`/${requestedId}`); await selectChat(chat); }
    catch (error) { select.value = selectedId ?? ''; onError(error); }
    finally { setPending(false); }
  });
  async function init() {
    if (initialized || !isAvailable() || isBusy()) return;
    if (initializing) return initializing;
    initializing = (async () => {
      setPending(true);
      try {
        await loadList();
        let stored;
        try { stored = globalThis.localStorage?.getItem(preferenceKey); } catch { /* ID preference is optional. */ }
        const id = summaries.find(chat => chat.id === stored)?.id ?? summaries[0]?.id;
        const { chat } = id ? await request(`/${id}`) : await request('/new', {});
        await selectChat(chat);
        if (!id) await loadList();
        initialized = true;
      } catch (error) { onError(error); }
      finally { setPending(false); initializing = undefined; }
    })();
    return initializing;
  }
  return {
    init, sync, currentId: () => selectedId, isPending: () => pending,
    async refresh() {
      if (!isAvailable() || pending || !initialized) return;
      deleteConfirmation = undefined;
      setPending(true);
      try { await loadList(); } catch (error) { onError(error); }
      finally { setPending(false); }
    },
  };
}
