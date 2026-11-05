function requestExcerpt(text) {
  return text
    .replace(/(?:api[ _-]?key|access[ _-]?token|token|password|secret|api\s*키|비밀번호)\s*[:=]\s*["']?[^\s"']+/gi, '[비공개 값 제거]')
    .replace(/\bBearer\s+[^\s]+|\bsk-[A-Za-z0-9_-]+|[A-Za-z0-9_+/.=-]{32,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[비공개 값 제거]');
}

export function automaticSkillBackground({ messages = [], name = '전체 스킬', description = '등록된 스킬과 생성·수정 배경 공유', updating = false } = {}) {
  const requests = messages.filter(item => item?.role === 'user' && typeof item.text === 'string').slice(-3).map(item => requestExcerpt(item.text.trim())).filter(Boolean);
  const request = requests.join('\n\n').slice(0, 3000) || '관련 사용자 요청은 미기록입니다.';
  return {
    situation: `사용자 요청을 참고해 앱이 자동 작성했습니다.\n\n${request}`,
    problem: `사용자가 전달한 요구·문제:\n${request}\n\n기술적 원인과 오류 재현 결과는 별도 근거가 없어 미확인입니다.`,
    changeReason: `${name} — ${description}\n${updating ? '기존 스킬 수정' : '스킬 생성·공유'} 내용을 검토하기 위해 기록했습니다.`,
    examplePrompt: requests.at(-1)?.slice(0, 4000) || '과거 입력 예시는 미기록입니다.',
    expectedResult: `${description}\n스킬 저장·내보내기와 실제 도면에서의 실행 검증은 구분합니다. 실제 실행 검증 결과는 미확인입니다.`,
  };
}
