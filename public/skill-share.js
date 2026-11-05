const fields = ['situation', 'problem', 'changeReason', 'examplePrompt', 'expectedResult'];

export function createSkillShare({ isBusy, onPending = () => {}, getChatId = () => undefined }) {
  const $ = id => document.getElementById(id);
  let supported = false;
  let pending = false;
  let loading = false;
  let contextReady = false;
  let contextInput = {};
  let contextRequest = 0;
  const available = () => supported && !pending && !loading && !isBusy();
  const notice = text => { $('skill-share-notice').textContent = text; };
  const sync = () => {
    $('skill-share-open').hidden = !supported;
    $('skill-share-open').disabled = !available();
    $('skill-share-download').disabled = !available() || !contextReady;
    $('skill-share-close').disabled = pending;
  };
  $('skill-share-open').addEventListener('click', async () => {
    if (!available()) return;
    const request = ++contextRequest;
    const chatId = getChatId();
    contextInput = chatId ? { chatId } : {};
    contextReady = false;
    loading = true; sync();
    for (const key of fields) $('skill-share-' + key).textContent = '자동 생성 중…';
    $('skill-share-email').hidden = true;
    notice('스킬과 대화에서 개선 배경 문서를 자동 생성하고 있습니다.');
    $('skill-share-dialog').showModal();
    try {
      const response = await fetch('/api/desktop/skills/export-context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contextInput), cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok || fields.some(key => typeof result.data?.background?.[key] !== 'string' || !result.data.background[key].trim())) throw Error();
      if (request !== contextRequest) return;
      for (const key of fields) $('skill-share-' + key).textContent = result.data.background[key].slice(0, 4000);
      contextReady = true;
      notice('설명 문서를 자동 생성했습니다. 내용을 확인한 뒤 ZIP을 다운로드하세요.');
    } catch {
      if (request === contextRequest) {
        for (const key of fields) $('skill-share-' + key).textContent = '자동 생성하지 못했습니다.';
        notice('개선 배경 문서를 자동 생성하지 못했습니다. 창을 닫은 뒤 다시 시도해 주세요.');
      }
    }
    finally { if (request === contextRequest) { loading = false; sync(); } }
  });
  const cancelContext = () => { contextRequest++; loading = false; contextReady = false; sync(); };
  $('skill-share-close').addEventListener('click', () => { if (!pending) { cancelContext(); $('skill-share-dialog').close(); } });
  $('skill-share-dialog').addEventListener('cancel', event => { if (pending) event.preventDefault(); else cancelContext(); });
  $('skill-share-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!available() || !contextReady) return;
    pending = true; onPending(true); sync();
    $('skill-share-email').hidden = true;
    notice('전체 스킬 폴더와 설명 문서를 ZIP으로 묶고 있습니다.');
    try {
      const response = await fetch('/api/desktop/skills/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contextInput) });
      if (!response.ok) { const result = await response.json(); throw Error(result.error || '스킬 ZIP을 만들지 못했습니다.'); }
      const name = response.headers.get('Content-Disposition')?.match(/filename="(SiteCAD-skills-[\d.-]+\.zip)"/)?.[1];
      if (!name) throw Error('ZIP 다운로드 이름을 확인하지 못했습니다. 다시 시도해 주세요.');
      if (Number(response.headers.get('Content-Length')) > 18 * 1024 * 1024) throw Error('ZIP 다운로드 용량이 너무 큽니다. 다시 시도해 주세요.');
      const blob = await response.blob();
      if (blob.size > 18 * 1024 * 1024) throw Error('ZIP 다운로드 용량이 너무 큽니다. 다시 시도해 주세요.');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000).unref?.();
      $('skill-share-email').href = 'mailto:seominpapa@gmail.com?subject=' + encodeURIComponent('SiteCAD 스킬 개선안') + '&body=' + encodeURIComponent('다운로드한 스킬 ZIP을 첨부해 주세요. ZIP에 사용 상황, 문제와 개선 내용을 자동 작성한 설명 문서가 포함되어 있습니다.');
      $('skill-share-email').hidden = false;
      notice('ZIP 저장을 요청했습니다. 저장된 파일과 설명 문서를 확인한 뒤 seominpapa@gmail.com으로 직접 첨부해 보내 주세요. 이메일이 자동 발송되거나 ZIP이 자동 첨부되지는 않습니다.');
    } catch (error) { notice(error.message || '스킬을 내보내지 못했습니다. 다시 시도해 주세요.'); }
    finally { pending = false; onPending(false); sync(); }
  });
  return { sync, update(status) { supported = status.desktop === true; sync(); } };
}
