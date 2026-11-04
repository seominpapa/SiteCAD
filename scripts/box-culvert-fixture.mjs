import assert from 'node:assert/strict';

const mm = value => Number(value.toFixed(6));
const show = (value, digits = 3) => value.toFixed(digits);
const point = (x, y) => [mm(x), mm(y)];
const line = (a, b, layer = 'OUTLINE', color = 7) => ({ type: 'Line', start: a, end: b, layer, color });
const poly = (vertices, layer = 'OUTLINE', closed = false, color = 7) => ({ type: 'LwPolyline', vertices, closed, layer, color });
const text = (value, x, y, layer = 'NOTES', height = 100, color = 7) => ({ type: 'Text', value, position: point(x, y), height, layer, color });
const rectangle = (x, y, width, height, layer = 'OUTLINE', color = 7) => poly([
  point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height),
], layer, true, color);
const shifted = (vertices, x, y) => vertices.map(([px, py]) => point(px + x, py + y));
const length = vertices => vertices.slice(1).reduce((sum, current, index) => sum + Math.hypot(current[0] - vertices[index][0], current[1] - vertices[index][1]), 0);

function conditions(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input));
  assert.ok(Object.keys(input).every(key => ['noncompliant', 'coverMm', 'backfillLayerMm', 'backfillMaterial', 'lapLocation'].includes(key)));
  const { noncompliant = false } = input;
  assert.equal(typeof noncompliant, 'boolean');
  const coverMm = input.coverMm ?? (noncompliant ? 20 : 75);
  const backfillLayerMm = input.backfillLayerMm ?? (noncompliant ? 400 : 150);
  assert.ok(Number.isFinite(coverMm) && coverMm > 0 && coverMm < 120);
  assert.ok(Number.isFinite(backfillLayerMm) && backfillLayerMm > 0 && backfillLayerMm <= 1000);
  const backfillMaterial = input.backfillMaterial ?? (noncompliant ? '유기질토·건설폐기물 혼합토' : '양질의 막자갈 또는 승인 조립재료');
  const lapLocation = input.lapLocation ?? (noncompliant ? '최대인장응력 구간, 동일 단면 전수 겹이음' : 'V1 전장 무이음, 향후 이음은 승인 상세도에 따름');
  assert.ok([backfillMaterial, lapLocation].every(value => typeof value === 'string' && value.length > 0 && value.length < 200 && !/[\x00-\x1f]/.test(value)));
  return { noncompliant, coverMm, backfillLayerMm, backfillMaterial, lapLocation,
    backfillCompactionPercent: noncompliant ? 90 : 95, excavationSlopeHPerV: 1,
    specifiedBackfillSlopeHPerV: 1, drawnBackfillSlopeHPerV: noncompliant ? 0.5 : 1,
    lapLengthMm: noncompliant ? 200 : null, steelGrade: 'SD400, KS D 3504',
    concreteStrengthMPa: 30, waterstop: noncompliant ? '수팽창 지수재 20×10mm, 기초타설 전 선설치'
      : '수팽창 지수재 20×10mm, 기초 양생 후 벽체 타설 전에 시공' };
}

function barDefinitions(c) {
  const short19 = 2600 - 2 * c.coverMm - 19.1;
  const long16 = 6000 - 2 * c.coverMm - 15.9;
  const long13 = 6000 - 2 * c.coverMm - 12.7;
  const lower = c.coverMm + 15.9 / 2;
  const upper = 3600 - lower;
  const row = (tag, diameter, count, vertices, phase) => ({ tag, diameter, count, vertices, phase });
  return [
    row('B1', 'D19', 62, [[0, 0], [short19, 0]], '기초타설'),
    row('B2', 'D16', 28, [[0, 0], [long16, 0]], '기초타설'),
    row('T1', 'D19', 62, [[0, 0], [short19, 0]], '상부슬래브'),
    row('T2', 'D16', 28, [[0, 0], [long16, 0]], '상부슬래브'),
    ...(c.noncompliant ? [
      row('V1A', 'D16', 124, [[0, 0], [0, -600], [1800 - lower, -600]], '기초타설·벽체선조립'),
      row('V1B', 'D16', 124, [[0, 0], [upper - 1600, 0]], '기초타설·벽체선조립'),
    ] : [row('V1', 'D16', 124, [[0, 0], [0, -600], [upper - lower, -600]], '기초타설·벽체선조립')]),
    row('H1', 'D13', 64, [[0, 0], [long13, 0]], '벽체수평근'),
  ].map(bar => {
    const standard = { D13: { nominalDiameterMm: 12.7, unitMassKgM: 0.995 }, D16: { nominalDiameterMm: 15.9, unitMassKgM: 1.56 }, D19: { nominalDiameterMm: 19.1, unitMassKgM: 2.25 } }[bar.diameter];
    const cutLengthMm = mm(length(bar.vertices));
    const totalLengthM = cutLengthMm / 1000 * bar.count;
    const scheduleUnitMassKgM = c.noncompliant && bar.tag === 'H1' ? 1.2 : standard.unitMassKgM;
    return { ...bar, nominalDiameterMm: standard.nominalDiameterMm, cutLengthMm, totalLengthM,
      referenceUnitMassKgM: standard.unitMassKgM, totalMassKg: totalLengthM * standard.unitMassKgM,
      scheduleUnitMassKgM, scheduleMassKg: totalLengthM * scheduleUnitMassKgM };
  });
}

function crossSection(c, x, y, reinforcement = false) {
  const title = reinforcement ? '철근배근 횡단면 — 투영·대표선, 수량은 기호별 본수 적용' : '일반 횡단면 — 내공 2000×3000 / 외곽 2600×3600';
  const basics = [
    rectangle(x, y, 2600, 3600, 'CONCRETE'), rectangle(x + 300, y + 300, 2000, 3000, 'VOID'),
    rectangle(x - 100, y - 100, 2800, 100, 'LEAN_CONCRETE', 4),
    text(title, x - 700, y + 5400, 'VIEW_TITLE', 150),
    text('내공폭 2000mm / 내공높이 3000mm / 벽·상하슬래브 각 300mm', x - 700, y - 700),
    text(`피복 ${c.coverMm}mm: 콘크리트면~최외측 철근 표면, 전 면 동일`, x - 700, y - 1000, 'COVER_NOTE'),
  ];
  return reinforcement ? [...basics, ...crossRebar(c, x, y)] : [...basics,
    poly(shifted([[-600, -100], [3200, -100], [7900, 4600], [-5300, 4600]], x, y), 'EXCAVATION', true, 8),
    line(point(x - 5700, y + 4600), point(x + 8300, y + 4600), 'GROUND', 3),
    ...[-1, 1].map(side => {
      const px = side < 0 ? 0 : 2600;
      return line(point(x + px, y + 300), point(x + px + side * 4300 * c.drawnBackfillSlopeHPerV, y + 4600), 'BACKFILL_BOUNDARY', 2);
    }),
    text('현지반 EL.+4.600 / 외측 지붕 EL.+3.600 / 토피 1000mm', x - 5300, y + 4850),
    text('굴착저면 EL.-0.100 / 굴착깊이 4700mm / 작업폭 양측 600mm', x - 5300, y - 1500),
    text('굴착사면 1V:1H — 시험 설계 가정, 보편 KDS/KCS 요구값 아님', x - 5300, y - 1800),
    text(`뒤채움 구역 실제 경계 1V:${c.drawnBackfillSlopeHPerV}H / 설계 지정 1V:1H`, x - 5300, y - 2100, 'SLOPE_NOTE'),
    ...waterstop(x, y),
  ];
}

function waterstop(x, y) {
  return [
    ...[150, 2450].map(px => rectangle(x + px - 10, y + 295, 20, 10, 'WATERSTOP', 6)),
    line(point(x + 2450, y + 300), point(x + 3700, y + 1000), 'WATERSTOP_LEADER', 6),
    text('수팽창 지수재 20×10mm / 양측 벽체-기초 이음 각 6m = 12m', x + 3750, y + 1000, 'WATERSTOP_NOTE', 85, 6),
  ];
}

function crossRebar(c, x, y) {
  const base = c.coverMm + 19.1 / 2;
  const vertical = c.coverMm + 15.9 / 2;
  const positions = [vertical, 300 - vertical, 2300 + vertical, 2600 - vertical];
  const verticals = positions.flatMap((px, index) => c.noncompliant ? [
    poly(shifted([[px + (index < 2 ? 600 : -600), vertical], [px, vertical], [px, 1800]], x, y), 'BAR_VIEW_V1A', false, 1),
    line(point(x + px + 25, y + 1600), point(x + px + 25, y + 3600 - vertical), 'BAR_VIEW_V1B', 1),
  ] : [poly(shifted([[px + (index < 2 ? 600 : -600), vertical], [px, vertical], [px, 3600 - vertical]], x, y), 'BAR_VIEW_V1', false, 1)]);
  return [
    ...[base, 300 - base, 3300 + base, 3600 - base].map(py => line(point(x + base, y + py), point(x + 2600 - base, y + py), 'BAR_VIEW_B1_T1', 1)),
    ...verticals,
    ...positions.flatMap(px => [450, 1800, 3150].map(py => ({ type: 'Circle', center: point(x + px, y + py), radius: 12.7 / 2, layer: 'BAR_VIEW_H1', color: 2 }))),
    line(point(x + 150, y + 1900), point(x - 1500, y + 2400), 'REBAR_VIEW_LEADER', 1),
    text(c.noncompliant ? 'V1A/V1B D16: 4면×31조 / 중앙 200mm 겹침' : 'V1 D16: 벽체 양측·내외면 4면×31본 = 124본', x - 5000, y + 2600, 'REBAR_VIEW_NOTE', 90, 1),
    text('B1/T1 D19: 각 상·하 2층×31본 = 각 62본', x + 3200, y + 3400, 'REBAR_VIEW_NOTE', 90),
    text('B2/T2 D16: 각 상·하 2층×14본 = 각 28본', x + 3200, y + 3100, 'REBAR_VIEW_NOTE', 90),
    text('H1 D13: 양측벽 내외면×16본 = 64본', x + 3200, y + 2800, 'REBAR_VIEW_NOTE', 90),
    text('벽체 수직근은 기초타설 전 전장 선조립. 벽체 수평근·상부근은 후속 공정.', x - 5000, y - 1400, 'STAGE_NOTE', 90),
  ];
}

function planView() {
  const x = 12500, y = 0;
  return [
    rectangle(x, y, 6000, 2600, 'PLAN_CONCRETE'),
    rectangle(x, y + 300, 6000, 2000, 'PLAN_VOID'),
    rectangle(x - 100, y - 100, 6200, 2800, 'PLAN_LEAN', 4),
    rectangle(x - 600, y - 600, 7200, 3800, 'PLAN_EXCAVATION_BOTTOM', 8),
    ...[150, 2450].map(py => line(point(x, y + py), point(x + 6000, y + py), 'PLAN_WATERSTOP', 6)),
    text('일반 평면도 — 연장 6000mm / 외폭 2600mm', x - 600, y + 3700, 'VIEW_TITLE', 150),
    text('린콘크리트 6200×2800×100mm / 굴착저면 7200×3800mm', x - 600, y - 1000),
    text('개구부 양단 개방. 날개벽·접속도로·단부벽은 시험 범위 제외.', x - 600, y - 1300),
    text('측점 0+000 ~ 0+006 / 지수재 각 벽체 시공이음 전 연장 6m', x - 600, y - 1600),
  ];
}

function longitudinalView() {
  const x = 24000, y = 0;
  return [
    rectangle(x, y, 6000, 3600, 'LONG_OUTER'), rectangle(x, y + 300, 6000, 3000, 'LONG_VOID'),
    rectangle(x - 100, y - 100, 6200, 100, 'LONG_LEAN', 4),
    poly(shifted([[-600, -100], [6600, -100], [11300, 4600], [-5300, 4600]], x, y), 'LONG_EXCAVATION', true, 8),
    line(point(x - 5500, y + 4600), point(x + 11500, y + 4600), 'GROUND', 3),
    text('일반 종단면 — 내공높이 3000 / 연장 6000 / 양단 개방', x - 5000, y + 5400, 'VIEW_TITLE', 150),
    text('굴착은 종·횡 양방향 사면 1V:1H인 직사각형 저면의 확장체', x - 5000, y - 700),
    text('단면적×고정연장으로 단순 산출하지 말고 양단 굴착사면까지 포함', x - 5000, y - 1000),
  ];
}

function cuttingShapes(bars) {
  return [text('기호별 가공 중심선 — 각 형상 1본의 길이를 측정하고 지정 본수를 곱할 것', 10000, -3800, 'VIEW_TITLE', 150),
    ...bars.flatMap((bar, index) => {
      const x = 10000, y = -4700 - index * 1050;
      return [
        poly(shifted(bar.vertices, x, y), `BAR_SHAPE_${bar.tag}`, false, 1),
        line(point(x + 200, y - 20), point(x + 6200, y + 160), `BAR_LEADER_${bar.tag}`, 3),
        text(`${bar.tag}: ${bar.diameter} / ${bar.count}본 / 1본 L=${show(bar.cutLengthMm, 1)}mm`, x + 6250, y + 160, 'BAR_TAG', 95, 3),
        text(`${bar.tag} 설치: ${bar.phase} / 중심선 치수, 뷰 투영선과 중복 합산 금지`, x + 6250, y - 50, 'BAR_SCOPE', 80),
      ];
    })];
}

function notes(c) {
  const values = [
    '시험 가정: 단위 mm, 모형 좌표 1:1, fck=30MPa, SD400 KS D 3504.',
    '하중·지반·내진·수리 구조계산 미수행. 시공용 승인 설계도면 아님.',
    `피복 ${c.coverMm}mm, 린 위 기초타설 / 모든 외측면의 노출조건은 별도 검토.`,
    `뒤채움 재료: ${c.backfillMaterial}. 입도·품질시험 성적서 미제공.`,
    `다짐 완료 1층 ${c.backfillLayerMm}mm / 다짐도 ${c.backfillCompactionPercent}% / 양측 같은 높이 동시 시공.`,
    '뒤채움 설계 경계 1V:1H는 이 시험 설계서의 지정값이며 일반 기준값 아님.',
    `실제 이음: ${c.lapLocation}${c.noncompliant ? ' / 겹침 200mm' : ''}.`,
    '설계 지정: 이음이 필요하면 승인 상세도상 상단 구간에 분산, 계산 이음길이 확보.',
    '기초타설 기성: 터파기·린·기초콘크리트·B1/B2·기초정착 벽체 수직근 포함.',
    '벽체 수직근은 전장 선조립 완료 가정. 상부/벽체수평근·뒤채움은 미시공.',
    c.noncompliant ? '지수재는 양측 벽체-기초 시공이음에 기초타설 전 선설치, 순길이 12m.'
      : '수팽창 지수재는 기초콘크리트 양생 후 시공, 순길이 12m / 기초타설 기성 제외.',
    '철근 표의 kg/m는 검증 대상. 독립 표준값과 호칭의 실제 공칭지름 대조 필요.',
    '형상은 시험 가공 중심선. 실제 굽힘 곡률·가공공차·절단손실은 별도 검토.',
    '대표 가공선·배근 투영선·표를 같은 설치 철근으로 중복 집계하지 말 것.',
  ];
  return values.map((value, index) => text(value, 23500, -3800 - index * 340, 'DESIGN_NOTES', 100));
}

function schedule(bars) {
  const x = -5500, y = -14000, rowHeight = 400;
  const widths = [1800, 1700, 1500, 2600, 3000, 3000, 3400, 6500];
  const edges = [0, ...widths.map((_, index) => widths.slice(0, index + 1).reduce((sum, width) => sum + width, 0))];
  const rows = [['기호', '규격', '본수', '1본길이(m)', '총길이(m)', '단위중량(kg/m)', '표 중량(kg)', '설치 공정'],
    ...bars.map(bar => [bar.tag, bar.diameter, String(bar.count), show(bar.cutLengthMm / 1000, 4), show(bar.totalLengthM, 4), show(bar.scheduleUnitMassKgM), show(bar.scheduleMassKg), bar.phase])];
  return [
    text('철근수량산출표 — 순 가공길이·할증 없음 / 단위중량과 본수는 독립 검증 대상', x, y + 650, 'SCHEDULE_TITLE', 170),
    rectangle(x, y - rows.length * rowHeight, edges.at(-1), rows.length * rowHeight, 'SCHEDULE_GRID'),
    ...edges.slice(1, -1).map(edge => line(point(x + edge, y), point(x + edge, y - rows.length * rowHeight), 'SCHEDULE_GRID')),
    ...rows.slice(1).map((_, index) => line(point(x, y - (index + 1) * rowHeight), point(x + edges.at(-1), y - (index + 1) * rowHeight), 'SCHEDULE_GRID')),
    ...rows.flatMap((row, index) => row.map((value, column) => text(value, x + edges[column] + 100, y - (index + 0.7) * rowHeight, 'REBAR_SCHEDULE', 115))),
    ...bars.map((bar, index) => text(`${bar.tag} | ${bar.diameter} | n=${bar.count} | L=${show(bar.cutLengthMm, 1)}mm | kg/m=${show(bar.scheduleUnitMassKgM)} | W=${show(bar.scheduleMassKg)}kg`, 19000, -14500 - index * 400, 'SCHEDULE_ROW_COPY', 100)),
    text(`표 총중량 ${show(bars.reduce((sum, bar) => sum + bar.scheduleMassKg, 0))}kg / 행별 반올림 전 값 합계`, x, y - (rows.length + 1) * rowHeight, 'SCHEDULE_TOTAL', 130),
    text('오른쪽 문자행은 동일 표의 기계 판독용 사본이며 별도 물량이 아님.', 19000, -18000, 'SCHEDULE_NOTE', 100),
  ];
}

function progress(c) {
  const hatch = (boundary, layer, color, scale) => ({ type: 'Hatch', boundary, solid: false, pattern: 'ANSI31', pattern_scale: scale, pattern_angle_deg: 45, layer, color });
  const vertical = c.coverMm + 15.9 / 2;
  return [
    hatch([[-600, -100], [3200, -100], [7900, 4600], [-5300, 4600]], 'PROGRESS_01_EXCAVATION', 8, 180),
    hatch([[-100, -100], [2700, -100], [2700, 0], [-100, 0]], 'PROGRESS_01_LEAN', 4, 30),
    hatch([[0, 0], [2600, 0], [2600, 300], [0, 300]], 'PROGRESS_01_FOUNDATION', 3, 50),
    ...[vertical, 300 - vertical, 2300 + vertical, 2600 - vertical].map((px, index) =>
      poly([[px + (index < 2 ? 600 : -600), vertical], [px, vertical], [px, 3600 - vertical]], 'PROGRESS_01_WALL_VERTICAL', false, 6)),
    text('기성 01: 기초콘크리트 타설 — 굴착·린·기초 및 선조립 벽체수직근 포함', -5300, 6100, 'PROGRESS_01_NOTE', 140, 3),
    text('벽체/상부 콘크리트·상부근·벽체수평근·뒤채움은 이번 기성 제외', -5300, 5800, 'PROGRESS_01_NOTE', 110, 3),
  ];
}

export function buildBoxCulvertFixture(input = {}) {
  const c = conditions(input);
  const bars = barDefinitions(c);
  const entities = [
    rectangle(-6500, -20500, 43500, 27500, 'SHEET_BORDER', 8),
    text(`2m×3m 통로박스 — ${c.noncompliant ? '의도적 불일치 시험도면' : '일반도·철근배근도 시험도면'} / L=6m`, -5500, 6500, 'DRAWING_TITLE', 250),
    ...crossSection(c, 0, 0), ...planView(), ...longitudinalView(),
    ...crossSection(c, 0, -8500, true), ...cuttingShapes(bars), ...notes(c), ...schedule(bars),
  ];
  const rebar = bars.map(({ vertices, ...bar }) => ({ ...bar, shapeEntityIndex: entities.findIndex(entity => entity.layer === `BAR_SHAPE_${bar.tag}`) }));
  const h = 4.7, bottomWidth = 3.8, bottomLength = 7.2, slope = c.excavationSlopeHPerV;
  const excavationM3 = h * (bottomWidth * bottomLength + (bottomWidth + bottomLength) * slope * h + 4 / 3 * slope ** 2 * h ** 2);
  const concreteM3 = (2.6 * 3.6 - 2 * 3) * 6;
  const leanConcreteM3 = 2.8 * 6.2 * 0.1;
  const foundationTags = rebar.filter(bar => bar.phase.startsWith('기초타설')).map(bar => bar.tag);
  return { name: c.noncompliant ? 'box-culvert-2x3-noncompliant' : 'box-culvert-2x3-normal', units: 4, entities,
    oracle: { conditions: c, dimensions: { clearWidthMm: 2000, clearHeightMm: 3000, lengthMm: 6000, thicknessMm: 300,
      leanWidthMm: 2800, leanLengthMm: 6200, leanThicknessMm: 100, excavationDepthMm: 4700, excavationBottomWidthMm: 3800, excavationBottomLengthMm: 7200 },
    quantities: { concreteM3, foundationConcreteM3: 2.6 * 0.3 * 6, wallConcreteM3: 2 * 0.3 * 3 * 6,
      roofConcreteM3: 2.6 * 0.3 * 6, leanConcreteM3, excavationM3, backfillM3: excavationM3 - concreteM3 - leanConcreteM3 - 36, waterstopM: 12 },
    rebar, totalRebarMassKg: rebar.reduce((sum, bar) => sum + bar.totalMassKg, 0),
    foundationStage: { concreteM3: 2.6 * 0.3 * 6, leanConcreteM3, excavationM3, backfillM3: 0, waterstopM: 0,
      rebarTags: foundationTags, rebarMassKg: rebar.filter(bar => foundationTags.includes(bar.tag)).reduce((sum, bar) => sum + bar.totalMassKg, 0) },
    limitations: ['교육·회귀시험용 배근이며 구조계산·현장·지반·내진·수리설계 미수행',
      '철근은 시험 중심선 길이이며 실제 굽힘곡률·가공공차·손실 별도', '표준 단위중량 참조값은 실제 검토 시 독립 공식 출처와 대조',
      '기성은 전장 벽체 수직근 선조립 완료 가정, 수팽창 지수재는 기초 양생 후 시공하므로 기초타설 단계 제외', '뒤채움 경사 1V:1H는 시험 설계서 조건이며 보편 기준값 아님'] },
    expectedIssues: c.noncompliant ? ['cover', 'backfill-material', 'backfill-layer', 'backfill-compaction', 'backfill-design-slope', 'rebar-unit-mass', 'lap-length', 'lap-location-needs-design-check', 'waterstop-installation-phase'] : [],
    progressMarkups: progress(c) };
}
