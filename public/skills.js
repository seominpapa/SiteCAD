export function createSkillMenu({ isBusy, onChange = () => {} }) {
  const $ = id => document.getElementById(id);
  let supported = false;
  let loaded = false;
  let loading;
  let error = false;
  let skills = [];
  let open = false;
  const available = () => supported && !isBusy() && !$('message-input').disabled;

  function sync() {
    $('skill-toggle').hidden = !supported;
    $('skill-toggle').disabled = !available();
    $('skill-toggle').setAttribute('aria-expanded', String(open && supported));
    $('skill-menu').hidden = !open || !supported;
    const prefix = $('message-input').value.match(/^\/([^\s]*)/u)?.[1]?.toLowerCase();
    const matches = prefix ? skills.filter(skill => skill.name.startsWith(prefix)) : skills;
    $('skill-list').replaceChildren();
    for (const skill of matches) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'skill-choice';
      const name = document.createElement('strong'); name.textContent = `/${skill.name}${skill.builtin ? ' · 기본' : ''}`;
      const description = document.createElement('span'); description.textContent = skill.description;
      button.disabled = !available();
      button.append(name, description);
      button.addEventListener('click', () => {
        if (!available()) return;
        const args = $('message-input').value.match(/^\/\S+\s+([\s\S]*)$/u)?.[1] ?? '';
        $('message-input').value = `/${skill.name} ${args}`;
        open = false; sync(); onChange(); $('message-input').focus();
      });
      $('skill-list').append(button);
    }
    $('skill-status').textContent = error ? '슬래시 목록을 불러오지 못했습니다. 슬래시 버튼으로 다시 시도해 주세요.'
      : loading ? '스킬 목록을 확인하고 있습니다.'
      : !skills.length ? '채팅에 “자주 쓰는 작업을 스킬로 만들어줘”라고 요청해 보세요. 스킬 만들기를 사용할 수 있습니다.'
      : !matches.length ? '일치하는 스킬이 없습니다. 설치된 명령 이름을 확인해 주세요.'
      : '스킬을 선택하고 요청 내용을 덧붙인 뒤 전송하세요.';
  }

  async function refresh() {
    if (!supported || loading) return loading;
    loading = (async () => {
      try {
        const response = await fetch('/api/desktop/skills', { method: 'GET', cache: 'no-store' });
        const body = await response.json();
        if (!response.ok || !body.ok || !Array.isArray(body.data?.skills)) throw Error('Invalid skill list');
        const names = new Set();
        skills = body.data.skills.slice(0, 128).filter(skill => {
          if (!skill || typeof skill.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(skill.name) || names.has(skill.name)) return false;
          names.add(skill.name); return true;
        }).map(skill => ({ name: skill.name, description: String(skill.description ?? '').slice(0, 1024), builtin: skill.builtin === true }));
        error = false;
      } catch { error = true; skills = []; }
      finally { loaded = true; loading = undefined; sync(); }
    })();
    sync(); return loading;
  }

  $('skill-toggle').addEventListener('click', async () => {
    if (!available()) return;
    open = !open;
    if (open && (!loaded || error)) await refresh();
    sync();
  });
  $('message-input').addEventListener('input', () => {
    const value = $('message-input').value;
    open = /^\/[^\s]*$/u.test(value) && !/^\/(?:mcp|api)$/i.test(value);
    sync();
  });
  $('message-input').addEventListener('keydown', event => { if (event.key === 'Escape') { open = false; sync(); } });
  return { sync, refresh, update(status) {
    supported = status.desktop === true;
    if (supported && !loaded && !loading) void refresh();
    sync();
  } };
}
