const TIMEOUT_CODE = 'SITECAD_TURN_TIMEOUT';
const TIMEOUT_MESSAGE = '10분 작업 시간 한도에 도달해 응답을 중단했습니다. 미완성 답변은 결과에서 제외했습니다. 이미 적용된 부분 변경과 미저장 상태, 저장된 파일을 확인한 뒤 이어서 요청해 주세요.';
const GENERIC_MESSAGE = '요청을 완료하지 못했습니다. 로그인·연결·도면 상태를 확인해 주세요. 일부 변경이 남아 있을 수 있습니다.';

export const turnTimeoutError = () => Object.assign(Error(TIMEOUT_MESSAGE), { code: TIMEOUT_CODE });

export function publicChatFailure(error) {
  const timeout = error?.code === TIMEOUT_CODE;
  const savedFiles = (Array.isArray(error?.savedFiles) ? error.savedFiles : []).slice(0, 64).filter(item => item &&
    typeof item.name === 'string' && item.name.length <= 240 && Number.isSafeInteger(item.bytes) && item.bytes > 0 &&
    typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) && typeof item.downloadUrl === 'string' &&
    /^\/api\/(?:local\/)?drawings\/[A-Za-z0-9%._-]+$/.test(item.downloadUrl)).map(({name,bytes,sha256,downloadUrl}) => ({name,bytes,sha256,downloadUrl}));
  return { type: 'error', message: timeout ? TIMEOUT_MESSAGE : GENERIC_MESSAGE,
    ...(timeout ? { code: TIMEOUT_CODE } : {}), ...(savedFiles.length ? { savedFiles } : {}) };
}
