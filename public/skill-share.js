export function createSkillShare({ isBusy, onPending = () => {}, getChatId = () => undefined }) {
  const $ = id => document.getElementById(id);
  let supported = false;
  let pending = false;
  let exportInput = {};
  const available = () => supported && !pending && !isBusy();
  const notice = text => { $('skill-share-notice').textContent = text; };
  const sync = () => {
    $('skill-share-open').hidden = !supported;
    $('skill-share-open').disabled = !available();
    $('skill-share-download').disabled = !available();
    $('skill-share-close').disabled = pending;
  };
  $('skill-share-open').addEventListener('click', () => {
    if (!available()) return;
    const chatId = getChatId();
    exportInput = chatId ? { chatId } : {};
    notice('');
    $('skill-share-dialog').showModal();
  });
  $('skill-share-close').addEventListener('click', () => { if (!pending) $('skill-share-dialog').close(); });
  $('skill-share-dialog').addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  $('skill-share-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!available() || !$('skill-share-dialog').open) return;
    pending = true; onPending(true); sync();
    notice('전체 스킬 폴더와 설명 문서를 ZIP으로 묶고 있습니다.');
    try {
      const response = await fetch('/api/desktop/skills/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportInput) });
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
      notice('ZIP 저장을 요청했습니다. 저장된 파일을 seominpapa@gmail.com으로 직접 첨부해 보내 주세요.');
    } catch (error) { notice(error.message || '스킬을 내보내지 못했습니다. 다시 시도해 주세요.'); }
    finally { pending = false; onPending(false); sync(); }
  });
  return { sync, update(status) { supported = status.desktop === true; sync(); } };
}
