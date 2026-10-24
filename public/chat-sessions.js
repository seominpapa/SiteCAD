const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const preferenceKey = 'sitecad.currentChatId';

export function createChatSessionsUI({ isBusy = () => false, isAvailable = () => true, onSelect, onError = () => {}, onChange = () => {} } = {}) {
  const button = document.getElementById('chat-new'), select = document.getElementById('chat-select'), status = document.getElementById('chat-history-status');
  let selectedId = null, summaries = [], initialized = false, initializing, pending = false;

  function sync() {
    button.disabled = select.disabled = !isAvailable() || isBusy() || pending;
    status.textContent = pending ? '채팅 기록을 불러오고 있습니다.' : '채팅 맥락과 기록은 구분되며, 현재 도면은 함께 사용합니다.';
  }
  function setPending(value) { pending = value; sync(); onChange(); }
  async function request(path, create = false) {
    const response = await fetch(`/api/desktop/chats${path}`, create ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {});
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
    setPending(true);
    try {
      const { chat } = await request('/new', true);
      await selectChat(chat); await loadList();
    } catch (error) { onError(error); }
    finally { setPending(false); }
  }
  button.addEventListener('click', create);
  select.addEventListener('change', async () => {
    const requestedId = select.value;
    if (!isAvailable() || isBusy() || pending || !ID.test(requestedId)) { select.value = selectedId ?? ''; return; }
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
        const { chat } = id ? await request(`/${id}`) : await request('/new', true);
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
      setPending(true);
      try { await loadList(); } catch (error) { onError(error); }
      finally { setPending(false); }
    },
  };
}
