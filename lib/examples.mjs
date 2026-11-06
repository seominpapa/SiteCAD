export const drawingExamples = Object.freeze([
  { file: 'retaining-wall-3m-normal.dwg', name: '옹벽 · 기본형', description: '높이 3m 옹벽. 물량 산출·철근 수량표 대조·기성 작업을 시작하는 원본입니다.' },
  { file: 'retaining-wall-3m-noncompliant.dwg', name: '옹벽 · 설계오류 검토', description: '피복·뒤채움·겹이음·철근 단중에 의도적 오류가 있는 검토용 도면입니다.' },
  { file: 'retaining-wall-3m-foundation-progress.dwg', name: '옹벽 · 기초 타설 기성 예시', description: '터파기·린·기초 해칭과 벽체 수직근 강조선이 표시된 결과 비교용 도면입니다.' },
  { file: 'box-culvert-2x3-normal-corrected.dwg', name: '통로박스 · 기본형 (권장)', description: '내공 2×3m 통로박스. 지수재 시공 시점을 정정한 물량·기성 작업용 원본입니다.' },
  { file: 'box-culvert-2x3-noncompliant.dwg', name: '통로박스 · 설계오류 검토', description: '의도적 설계 오류와 철근 단중 불일치를 확인하는 검토용 도면입니다.' },
  { file: 'box-culvert-2x3-foundation-progress.dwg', name: '통로박스 · 기초 타설 기성 예시', description: '기초콘크리트 타설 단계의 기성 표시 결과를 비교하는 도면입니다.' },
  { file: 'box-culvert-2x3-normal.dwg', name: '통로박스 · 이전 기본형', description: '지수재 시공 시점 정정 전의 비교용 원본입니다. 새 작업에는 권장 기본형을 사용하세요.' },
].map(example => Object.freeze({ ...example, url: `/api/examples/${example.file}` })));
