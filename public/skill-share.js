export function createSkillShare({ isBusy, onPending = () => {}, getChatId = () => undefined }) {
  const $ = id => document.getElementById(id);
  let supported = false;
  let pending = false;
  let exportInput = {};
  let verification, verificationTimer, token = '', submissionId, submitted = false, attempted = false, generation = 0;
  const available = () => supported && !pending && !isBusy();
  const notice = text => { $('skill-share-notice').textContent = text; };
  const sync = () => {
    $('skill-share-open').hidden = !supported;
    $('skill-share-open').disabled = !available();
    $('skill-share-download').disabled = !available();
    $('skill-share-close').disabled = pending;
    $('skill-share-submit').disabled = !available() || !verification || !token || !$('skill-share-consent').checked || submitted;
    $('skill-share-consent').disabled = pending || submitted;
  };
  const resetChallenge = () => {
    clearTimeout(verificationTimer);
    token = '';
    if (verification) {
      verification = { ...verification, nonce: crypto.randomUUID() };
      const nonce = verification.nonce;
      const url = new URL(verification.challengeUrl);
      url.searchParams.set('origin', window.location.origin);
      url.searchParams.set('nonce', verification.nonce);
      $('skill-share-verification').src = url.href;
      verificationTimer = setTimeout(() => {
        if ($('skill-share-dialog').open && verification?.nonce === nonce && !token && !pending && !submitted)
          notice('보안 확인이 지연되고 있습니다. 창을 닫았다가 다시 열어 주세요. 계속되지 않으면 ZIP 저장이나 이메일 공유를 이용해 주세요.');
      }, 30000);
      verificationTimer.unref?.();
    }
  };
  window.addEventListener('message', event => {
    const value = event.data;
    if (!$('skill-share-dialog').open || submitted || !verification || event.origin !== verification.origin || event.source !== $('skill-share-verification').contentWindow ||
      !value || value.type !== 'sitecad-skill-verification' || value.nonce !== verification.nonce || typeof value.token !== 'string' || value.token.length > 2048 || /[\x00-\x1f]/.test(value.token) ||
      value.reason !== undefined && (!['failed', 'expired'].includes(value.reason) || value.token !== '')) return;
    clearTimeout(verificationTimer);
    token = value.token;
    if (!pending) notice(token ? '보안 확인을 마쳤습니다. 공개 동의 후 GitHub 이슈로 보낼 수 있습니다.'
      : value.reason === 'failed' ? '보안 확인에 실패했습니다. 창을 닫았다가 다시 열어 주세요. 계속되지 않으면 ZIP 저장이나 이메일 공유를 이용해 주세요.'
      : '보안 확인이 만료됐습니다. 창을 닫았다가 다시 열어 주세요. ZIP 저장과 이메일 공유는 계속 이용할 수 있습니다.');
    sync();
  });
  $('skill-share-open').addEventListener('click', async () => {
    if (!available()) return;
    const current = ++generation;
    const recovering = attempted && !submitted;
    if (!recovering) {
      const chatId = getChatId();
      exportInput = chatId ? { chatId } : {};
      submissionId = crypto.randomUUID(); attempted = false;
    }
    verification = undefined; token = ''; submitted = false;
    $('skill-share-consent').checked = false;
    $('skill-share-result').hidden = true;
    $('skill-share-verification').hidden = true;
    $('skill-share-submit').textContent = recovering ? '제출 결과 다시 확인' : 'GitHub 이슈로 보내기';
    notice(recovering ? '완료 여부를 확인하지 못한 이전 제출을 이어서 확인합니다. 이전 제출의 스킬과 설명을 그대로 사용합니다.' : '');
    $('skill-share-dialog').showModal();
    sync();
    try {
      const response = await fetch('/api/desktop/skills/submission-config', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const value = await response.json();
      if (current !== generation || !$('skill-share-dialog').open) return;
      const config = value.data;
      if (!response.ok || !value.ok || config?.enabled !== true) throw Error('제출 서버가 아직 준비되지 않았습니다. ZIP 저장과 이메일 제출을 이용해 주세요.');
      const origin = new URL(config.origin), challenge = new URL(config.challengeUrl);
      if (origin.protocol !== 'https:' || origin.origin !== config.origin || challenge.href !== `${origin.origin}/challenge`) throw Error('제출 서버 주소를 확인해 주세요.');
      verification = { origin: origin.origin, challengeUrl: challenge.href };
      resetChallenge();
      $('skill-share-verification').hidden = false;
    } catch (error) {
      if (current === generation && $('skill-share-dialog').open) notice(error.message || '제출 서버를 확인하지 못했습니다. ZIP을 저장해 이메일로 보내 주세요.');
    } finally { sync(); }
  });
  $('skill-share-close').addEventListener('click', () => { if (!pending) { clearTimeout(verificationTimer); generation++; verification = undefined; token = ''; $('skill-share-verification').src = 'about:blank'; $('skill-share-dialog').close(); } });
  $('skill-share-dialog').addEventListener('cancel', event => {
    if (pending) return event.preventDefault();
    clearTimeout(verificationTimer); generation++; verification = undefined; token = ''; $('skill-share-verification').src = 'about:blank';
  });
  $('skill-share-consent').addEventListener('change', sync);
  $('skill-share-submit').addEventListener('click', async () => {
    if (!available() || !$('skill-share-dialog').open || !verification || !token || !$('skill-share-consent').checked || submitted) return;
    pending = true; attempted = true; onPending(true); sync();
    notice('전체 스킬과 자동 생성한 설명을 제출하고 GitHub 이슈를 확인하고 있습니다.');
    try {
      const response = await fetch('/api/desktop/skills/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...exportInput, submissionId, challengeNonce: verification.nonce, turnstileToken: token, consent: true }), signal: AbortSignal.timeout(110000) });
      const value = await response.json(), data = value.data;
      if (!response.ok || !value.ok || data?.submissionId !== submissionId) throw Error(value.error || '제출 결과를 확인하지 못했습니다. 같은 창에서 다시 확인해 주세요.');
      if (data.state === 'submitted' && /^https:\/\/github\.com\/seominpapa\/SiteCAD\/issues\/[1-9]\d*$/.test(data.issueUrl)) {
        submitted = true;
        $('skill-share-result').href = data.issueUrl;
        $('skill-share-result').hidden = false;
        notice('개선안과 ZIP 다운로드 링크를 GitHub 이슈에 등록했습니다.');
      } else if (data.state === 'pending') notice('제출을 처리 중입니다. 새 제출을 만들지 말고 보안 확인 후 같은 창에서 결과를 다시 확인해 주세요.');
      else throw Error('제출 결과를 확인하지 못했습니다. 같은 창에서 다시 확인해 주세요.');
    } catch (error) { notice(error.message || '제출 결과를 확인하지 못했습니다. 같은 창에서 다시 확인하거나 ZIP을 저장해 이메일로 보내 주세요.'); }
    finally {
      if (!submitted) { $('skill-share-submit').textContent = '제출 결과 다시 확인'; resetChallenge(); }
      pending = false; onPending(false); sync();
    }
  });
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
      notice('ZIP 저장을 요청했습니다. 파일을 직접 공유하거나 seominpapa@gmail.com으로 첨부해 보낼 수 있습니다.');
    } catch (error) { notice(error.message || '스킬을 내보내지 못했습니다. 다시 시도해 주세요.'); }
    finally { pending = false; onPending(false); sync(); }
  });
  return { sync, update(status) { supported = status.desktop === true; sync(); } };
}
