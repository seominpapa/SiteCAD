import { boundedJson } from './api-mcp-client.mjs';

export const SKILL_SUBMISSION_ORIGIN = 'https://sitecad-skill-submissions.sjkwak300.workers.dev';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const failure = () => Error('개선안 제출 결과를 확인하지 못했습니다. 같은 창에서 다시 확인하거나 ZIP을 저장해 이메일로 보내 주세요.');
const issueLink = value => typeof value === 'string' && /^https:\/\/github\.com\/seominpapa\/SiteCAD\/issues\/[1-9]\d*$/.test(value);

function checkedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['chatId', 'submissionId', 'turnstileToken', 'challengeNonce', 'consent'].includes(key)) ||
    input.consent !== true || !uuid(input.submissionId) || !uuid(input.challengeNonce) || input.chatId !== undefined && !uuid(input.chatId) ||
    typeof input.turnstileToken !== 'string' || !input.turnstileToken.trim() || input.turnstileToken.length > 2048 || /[\x00-\x1f]/.test(input.turnstileToken)) throw Error('공개 제출 동의와 보안 확인을 완료해 주세요.');
}

export function createSkillSubmission({ desktop, origin = SKILL_SUBMISSION_ORIGIN, fetcher = fetch, now = Date.now } = {}) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw Error('개선안 제출 서버 주소를 확인해 주세요.');
  let pending = false, attempts = [], health;
  const archives = new Map();
  return {
    async config() {
      if (!desktop) return { enabled: false };
      if (health && now() - health.at < 10000) return health.value;
      let enabled = false;
      try {
        const response = await fetcher(`${origin}/health`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (response.ok) { const value = await boundedJson(response, 16384); enabled = value.ok === true && value.data?.configured === true; }
      } catch { /* ZIP download remains available when the submission service is offline. */ }
      const value = enabled ? { enabled: true, origin, challengeUrl: `${origin}/challenge` } : { enabled: false };
      health = { at: now(), value };
      return value;
    },
    async submit(input) {
      checkedInput(input);
      if (!desktop) throw failure();
      if (pending) throw Error('개선안 제출을 처리 중입니다. 잠시 기다려 주세요.');
      attempts = attempts.filter(at => now() - at < 60000);
      if (attempts.length >= 6) throw Error('제출 요청이 많습니다. 잠시 후 같은 창에서 다시 확인해 주세요.');
      const previous = archives.get(input.submissionId);
      if (previous && previous.chatId !== input.chatId) throw Error('같은 제출의 채팅을 변경할 수 없습니다.');
      if (previous?.result?.state === 'submitted') return previous.result;
      pending = true;
      attempts = [...attempts, now()];
      try {
        let saved = previous;
        if (!saved) {
          const archive = await desktop.skillsExport(input.chatId ? { chatId: input.chatId } : {});
          const version = archive.name?.match(/^SiteCAD-skills-(\d+\.\d+\.\d+)-\d{8}\.zip$/)?.[1];
          if (!version || !Buffer.isBuffer(archive.bytes) || archive.bytes.length > 18 * 1024 * 1024 || archive.bytes.length < 4 || archive.bytes.readUInt32LE(0) !== 0x04034b50) throw Error('제출할 ZIP 파일의 이름·내용·용량을 확인해 주세요.');
          const summary = typeof archive.summary === 'string' ? archive.summary.slice(0, 8000) : '전체 스킬과 자동 생성한 개선 배경은 첨부 ZIP에 포함되어 있습니다.';
          saved = { archive, version, summary, chatId: input.chatId };
          if (archives.size >= 3) archives.delete(archives.keys().next().value);
          archives.set(input.submissionId, saved);
        }
        const form = new FormData();
        form.set('archive', new File([saved.archive.bytes], saved.archive.name, { type: 'application/zip' }));
        form.set('metadata', JSON.stringify({ submissionId: input.submissionId, version: saved.version, summary: saved.summary }));
        form.set('turnstileToken', input.turnstileToken);
        form.set('challengeNonce', input.challengeNonce);
        form.set('consent', 'true');
        try {
          const response = await fetcher(`${origin}/submissions`, { method: 'POST', body: form, signal: AbortSignal.timeout(90000), redirect: 'error' });
          if (!response.ok) throw failure();
          const value = await boundedJson(response, 16384), data = value.data;
          if (value.ok !== true || data?.submissionId !== input.submissionId || !['submitted', 'pending'].includes(data.state) || data.state === 'submitted' && !issueLink(data.issueUrl)) throw failure();
          const result = { submissionId: data.submissionId, state: data.state, ...(data.state === 'submitted' ? { issueUrl: data.issueUrl } : {}) };
          archives.set(input.submissionId, { ...saved, result });
          return result;
        } catch { throw failure(); }
      } finally { pending = false; }
    },
  };
}
