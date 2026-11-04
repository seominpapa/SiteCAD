import assert from 'node:assert/strict';

const rounded = value => Number(value.toFixed(6));
const show = (value, digits = 3) => value.toFixed(digits);
const p = (x, y) => [rounded(x), rounded(y)];
const poly = (vertices, layer, closed = false, color = 7) => ({ type: 'LwPolyline', vertices, closed, layer, color });
const line = (start, end, layer, color = 7) => ({ type: 'Line', start, end, layer, color });
const text = (value, x, y, layer = 'NOTES', height = 110, color = 7) => ({ type: 'Text', value, position: p(x, y), height, layer, color });
const rect = (x, y, width, height, layer, color = 7) => poly([p(x, y), p(x + width, y), p(x + width, y + height), p(x, y + height)], layer, true, color);
const shifted = (vertices, x, y) => vertices.map(([px, py]) => p(px + x, py + y));
const pathLength = vertices => vertices.slice(1).reduce((sum, current, i) => sum + Math.hypot(current[0] - vertices[i][0], current[1] - vertices[i][1]), 0);
const excavation = [[-600, -100], [3000, -100], [6500, 3400], [-4100, 3400]];
const rearBackfill = [[900, 400], [3500, 400], [6500, 3400], [900, 3400]];

function conditions(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input));
  assert.ok(Object.keys(input).every(key => key === 'noncompliant'));
  const { noncompliant = false } = input;
  assert.equal(typeof noncompliant, 'boolean');
  return { noncompliant, coverMm: noncompliant ? 20 : 75, backfillLayerMm: noncompliant ? 400 : 150,
    backfillCompactionPercent: noncompliant ? 90 : 95,
    backfillMaterial: noncompliant ? '유기질토·건설폐기물 혼합토' : '승인된 양질의 조립재료, 입도·품질시험 별도',
    lapLengthMm: noncompliant ? 200 : null,
    lapLocation: noncompliant ? '벽체 기부 최대인장 예상구간, 동일 단면 전수 겹이음' : 'V1 전장 무이음, 향후 이음은 구조계산·승인상세에 따름',
    excavationSlopeHPerV: 1, concreteStrengthMPa: 30, steelGrade: 'SD400, KS D 3504' };
}

function bars(c) {
  const lower = c.coverMm + 15.9 / 2, upper = 3400 - lower;
  const row = (tag, diameter, count, vertices, phase) => ({ tag, diameter, count, vertices, phase });
  return [
    row('B1', 'D19', 62, [[0, 0], [2400 - 2 * c.coverMm - 19.1, 0]], '기초타설'),
    row('B2', 'D16', 24, [[0, 0], [6000 - 2 * c.coverMm - 15.9, 0]], '기초타설'),
    ...(c.noncompliant ? [
      row('V1A', 'D16', 62, [[0, 0], [600, 0], [600, 800 - lower]], '기초타설·벽체전장선조립'),
      row('V1B', 'D16', 62, [[0, 0], [0, upper - 600]], '기초타설·벽체전장선조립'),
    ] : [row('V1', 'D16', 62, [[0, 0], [600, 0], [600, upper - lower]], '기초타설·벽체전장선조립')]),
    row('H1', 'D13', 32, [[0, 0], [6000 - 2 * c.coverMm - 12.7, 0]], '벽체수평근·후속공정'),
  ].map(bar => {
    const standard = { D13: [12.7, 0.995], D16: [15.9, 1.56], D19: [19.1, 2.25] }[bar.diameter];
    const cutLengthMm = rounded(pathLength(bar.vertices));
    const totalLengthM = cutLengthMm / 1000 * bar.count;
    const scheduleUnitMassKgM = c.noncompliant && bar.tag === 'H1' ? 1.2 : standard[1];
    return { ...bar, nominalDiameterMm: standard[0], cutLengthMm, totalLengthM,
      referenceUnitMassKgM: standard[1], totalMassKg: totalLengthM * standard[1],
      scheduleUnitMassKgM, scheduleMassKg: totalLengthM * scheduleUnitMassKgM };
  });
}

function section(c, x, y, reinforced = false) {
  const geometry = [
    rect(x, y, 2400, 400, reinforced ? 'REBAR_VIEW_FOUNDATION' : 'FOUNDATION_CONCRETE'),
    rect(x + 600, y + 400, 300, 3000, reinforced ? 'REBAR_VIEW_STEM' : 'WALL_CONCRETE'),
    rect(x - 100, y - 100, 2600, 100, reinforced ? 'REBAR_VIEW_LEAN' : 'LEAN_CONCRETE', 4),
    text(reinforced ? '배근 횡단면 — 대표선, 본수는 별도 근거 적용' : '일반 횡단면 — 벽체 H=3000 / t=300 / 기초 2400×400', x - 4100, y + 4100, 'VIEW_TITLE', 160),
    text('기초 전면끝 x=0 / 벽체 전면 x=600 / 배면 x=900 / 기초 배면끝 x=2400', x - 4100, y - 800),
    text(`피복 ${c.coverMm}mm: 콘크리트면~최외측 철근 표면 / 전 면 동일 시험조건`, x - 4100, y - 1100, 'COVER_NOTE'),
  ];
  if (reinforced) return [...geometry, ...rebarView(c, x, y)];
  return [...geometry,
    poly(shifted(excavation, x, y), 'EXCAVATION', true, 8),
    poly(shifted(rearBackfill, x, y), 'BACKFILL_BOUNDARY', true, 2),
    line(p(x - 4400, y + 3400), p(x + 6800, y + 3400), 'ORIGINAL_GROUND', 3),
    line(p(x - 1100, y + 400), p(x, y + 400), 'FINAL_FRONT_GROUND', 3),
    rect(x + 740, y + 395, 20, 10, 'WATERSTOP', 6),
    line(p(x + 750, y + 400), p(x + 1600, y + 1800), 'WATERSTOP_LEADER', 6),
    text('수팽창 지수재 20×10mm / 벽체-기초 시공이음 전 연장 6m', x + 1700, y + 1800, 'WATERSTOP_NOTE', 105, 6),
    text('초기지반 EL.+3.400 평탄 / 최종 전면 EL.+0.400 / 배면 EL.+3.400', x - 4100, y + 3650),
    text('굴착저면 EL.-0.100, 폭3600 / 상단폭10600 / 깊이3500mm', x - 4100, y - 1500),
    text('굴착사면 1V:1H는 시험 설계 가정. 지반·가시설 안전검토 전 실제 적용 금지.', x - 4100, y - 1800, 'SLOPE_NOTE'),
    text('배면 구조물뒤채움: EL.+0.400 이상 닫힌 경계 / 하부 일반되메움과 분리', x - 4100, y - 2100),
  ];
}

function rebarView(c, x, y) {
  const lower = c.coverMm + 15.9 / 2, upper = 3400 - lower;
  const verticals = [600 + lower, 900 - lower];
  return [
    ...[c.coverMm + 19.1 / 2, 400 - c.coverMm - 19.1 / 2].map(py => line(p(x + c.coverMm + 19.1 / 2, y + py), p(x + 2400 - c.coverMm - 19.1 / 2, y + py), 'BAR_VIEW_B1', 1)),
    ...verticals.flatMap(px => c.noncompliant ? [
      poly(shifted([[px + 600, lower], [px, lower], [px, 800]], x, y), 'BAR_VIEW_V1A', false, 1),
      line(p(x + px + 20, y + 600), p(x + px + 20, y + upper), 'BAR_VIEW_V1B', 1),
    ] : [poly(shifted([[px + 600, lower], [px, lower], [px, upper]], x, y), 'BAR_VIEW_V1', false, 1)]),
    ...verticals.flatMap(px => Array.from({ length: 16 }, (_, i) => ({ type: 'Circle', center: p(x + px, y + 400 + c.coverMm + 6.35 + i * (3000 - 2 * c.coverMm - 12.7) / 15), radius: 6.35, layer: 'BAR_VIEW_H1', color: 2 }))),
    text('B1 D19: 연장방향31위치×상하2층=62본 (양끝 포함, 최대 간격200mm)', x - 4100, y - 1500, 'BAR_COUNT_NOTE'),
    text('B2 D16: 기초폭방향12위치×상하2층=24본 (양끝 포함 등간격)', x - 4100, y - 1800, 'BAR_COUNT_NOTE'),
    text(c.noncompliant ? 'V1A/V1B D16: 전후2면×연장31위치=각62본, EL.+0.600~0.800에서200mm 겹침' : 'V1 D16: 전후2면×연장31위치=62본, 전장 무이음', x - 4100, y - 2100, 'BAR_COUNT_NOTE'),
    text('H1 D13: 벽 전후2면×높이방향16위치=32본 (양끝 포함 등간격)', x - 4100, y - 2400, 'BAR_COUNT_NOTE'),
    text('배근 투영선·원은 대표 표현. 기호별 가공형상 1본×독립 본수로 산출, 중복 합산 금지.', x - 4100, y - 2700, 'REBAR_VIEW_NOTE'),
  ];
}

function plan() {
  const x = 12000, y = 0;
  return [
    rect(x, y, 6000, 2400, 'PLAN_FOUNDATION'), rect(x, y + 600, 6000, 300, 'PLAN_STEM'),
    rect(x, y - 100, 6000, 2600, 'PLAN_LEAN', 4),
    rect(x, y - 600, 6000, 3600, 'PLAN_EXCAVATION_BOTTOM', 8),
    line(p(x, y + 750), p(x + 6000, y + 750), 'PLAN_WATERSTOP', 6),
    text('일반 평면도 — 연장6000 / 기초폭2400 / 벽체두께300mm', x, y + 4100, 'VIEW_TITLE', 160),
    text('측점0+000~0+006 / 양단 가시설 수직막음 가정: 종방향 사면체적 없음', x, y - 800),
    text('기초·린·굴착·뒤채움은 동일 단면×6m. 린 폭2600×두께100, 단부 여유 제외.', x, y - 1100),
    text('배수공·필터·신축이음·날개벽은 별도 설계 미제공으로 시험 산출범위 제외.', x, y - 1400),
  ];
}

function cuttingShapes(rebar) {
  return [text('기호별 1본 가공 중심선 — mm 실좌표, 굽힘곡률·가공공차·할증 별도', 11500, -3400, 'VIEW_TITLE', 150),
    ...rebar.flatMap((bar, i) => {
      const x = 11500, y = -4600 - i * 4100;
      return [poly(shifted(bar.vertices, x, y), `BAR_SHAPE_${bar.tag}`, false, 1),
        line(p(x + 250, y), p(x + 6500, y + 1200), `BAR_LEADER_${bar.tag}`, 3),
        text(`${bar.tag}: ${bar.diameter}, ${bar.count}본 / L=${show(bar.cutLengthMm, 1)}mm`, x + 6600, y + 1200, 'BAR_TAG', 115, 3),
        text(`설치: ${bar.phase}`, x + 6600, y + 900, 'BAR_SCOPE', 105)];
    })];
}

function notes(c) {
  return [
    '교육·회귀시험 전용 역T 옹벽. 구조계산 미수행, 시공용 승인도면 아님.',
    '단위mm, 모형1:1 / fck30MPa / SD400 KS D 3504 / 전체연장6m.',
    '토압·수압·활동·전도·지지력·내진·배수 및 가시설 검토 미수행.',
    `피복 ${c.coverMm}mm. 노출등급·최외측 철근·현장 타설조건을 KDS/KCS로 별도 검토.`,
    `구조물뒤채움 재료: ${c.backfillMaterial}. 시험성적서 미제공.`,
    `다짐 후 1층 ${c.backfillLayerMm}mm / 다짐도 ${c.backfillCompactionPercent}%. 시험방법·기준밀도 별도 확인.`,
    `벽체 수직근 이음: ${c.lapLocation}${c.noncompliant ? ', 겹침200mm' : ''}.`,
    '기초타설 기성: 굴착·린·기초콘크리트·B1/B2 및 벽체 수직근 전장 선조립 포함.',
    '벽체콘크리트·H1 수평근·일반되메움·구조물뒤채움은 후속공정으로 기초타설 기성 제외.',
    '수팽창 지수재6m는 기초 양생 후 벽체타설 전에 설치하므로 이번 기성 제외.',
    '굴착 상부 전면 개방부는 영구 절토 공간. 되메움으로 채우지 않으며 반출토량과 구분.',
    '순기하 체적, 토량 변화율·손실·폐기·운반·단부 가시설/배수공 물량 제외.',
    '표 단중·공칭지름은 검증 대상. 제조사 공식 원문/KS와 독립 대조, 표를 정답으로 재사용 금지.',
    '가공 중심선·배근 투영선·평면도·표는 같은 철근의 표현. 표현별 중복 집계 금지.',
  ].map((value, i) => text(value, 26000, 3600 - i * 430, 'DESIGN_NOTES', 115));
}

function schedule(rebar) {
  const x = -4500, y = -23000, rowHeight = 450;
  const widths = [1500, 1600, 1400, 2500, 2700, 2800, 3000, 7600];
  const edges = [0, ...widths.map((_, i) => widths.slice(0, i + 1).reduce((sum, value) => sum + value, 0))];
  const rows = [['기호', '규격', '본수', '1본길이(m)', '총길이(m)', '단중(kg/m)', '표 중량(kg)', '설치공정'],
    ...rebar.map(bar => [bar.tag, bar.diameter, String(bar.count), show(bar.cutLengthMm / 1000, 4), show(bar.totalLengthM, 4), show(bar.scheduleUnitMassKgM), show(bar.scheduleMassKg), bar.phase])];
  return [
    text('철근수량산출표 — 순 가공길이 / 할증 없음 / 단위중량 독립검증 대상', x, y + 700, 'SCHEDULE_TITLE', 170),
    rect(x, y - rows.length * rowHeight, edges.at(-1), rows.length * rowHeight, 'SCHEDULE_GRID'),
    ...edges.slice(1, -1).map(edge => line(p(x + edge, y), p(x + edge, y - rows.length * rowHeight), 'SCHEDULE_GRID')),
    ...rows.slice(1).map((_, i) => line(p(x, y - (i + 1) * rowHeight), p(x + edges.at(-1), y - (i + 1) * rowHeight), 'SCHEDULE_GRID')),
    ...rows.flatMap((row, i) => row.map((value, column) => text(value, x + edges[column] + 100, y - (i + 0.7) * rowHeight, 'REBAR_SCHEDULE', 120))),
    ...rebar.map((bar, i) => text(`${bar.tag} | ${bar.diameter} | n=${bar.count} | L=${show(bar.cutLengthMm, 1)}mm | kg/m=${show(bar.scheduleUnitMassKgM)} | W=${show(bar.scheduleMassKg)}kg`, 26000, -5000 - i * 420, 'SCHEDULE_ROW_COPY', 110)),
    text('위 기계판독용 문자행은 동일 표의 사본. 별도 물량 아님.', 26000, -7800, 'SCHEDULE_NOTE', 110),
    text(`표 총중량 ${show(rebar.reduce((sum, bar) => sum + bar.scheduleMassKg, 0))}kg / 반올림 전 합계`, x, y - (rows.length + 1) * rowHeight, 'SCHEDULE_TOTAL', 140),
  ];
}

function progress(c) {
  const hatch = (boundary, layer, color, scale) => ({ type: 'Hatch', boundary, solid: false, pattern: 'ANSI31', pattern_scale: scale, pattern_angle_deg: 45, layer, color });
  const lower = c.coverMm + 15.9 / 2;
  return [
    hatch(excavation.map(([x, y]) => p(x, y)), 'PROGRESS_01_EXCAVATION', 8, 160),
    hatch([[-100, -100], [2500, -100], [2500, 0], [-100, 0]], 'PROGRESS_01_LEAN', 4, 25),
    hatch([[0, 0], [2400, 0], [2400, 400], [0, 400]], 'PROGRESS_01_FOUNDATION', 3, 60),
    ...[600 + lower, 900 - lower].map(px => poly([[px + 600, lower], [px, lower], [px, 3400 - lower]], 'PROGRESS_01_WALL_VERTICAL', false, 6)),
    text('기성01: 기초콘크리트 타설 — 터파기·린·기초·B1/B2·벽체수직근 전장 선조립', -4100, 4800, 'PROGRESS_01_NOTE', 140, 3),
    text('벽체콘크리트·H1·일반되메움·구조물뒤채움·지수재는 미시공으로 제외', -4100, 4500, 'PROGRESS_01_NOTE', 115, 3),
  ];
}

export function buildRetainingWallFixture(input = {}) {
  const c = conditions(input), rebar = bars(c);
  const entities = [rect(-5000, -27500, 50000, 33500, 'SHEET_BORDER', 8),
    text(`3m 역T 옹벽 — ${c.noncompliant ? '의도적 불일치 검토시험' : '일반도·철근배근도 시험'} / 연장6m`, -4100, 5500, 'DRAWING_TITLE', 250),
    ...section(c, 0, 0), ...plan(), ...section(c, 0, -9500, true), ...cuttingShapes(rebar), ...notes(c), ...schedule(rebar)];
  const measured = rebar.map(({ vertices, ...bar }) => ({ ...bar, shapeEntityIndex: entities.findIndex(entity => entity.layer === `BAR_SHAPE_${bar.tag}`) }));
  const quantities = { concreteM3: 2.4 * 0.4 * 6 + 0.3 * 3 * 6, foundationConcreteM3: 2.4 * 0.4 * 6,
    wallConcreteM3: 0.3 * 3 * 6, leanConcreteM3: 2.6 * 0.1 * 6, excavationM3: (3.6 + 10.6) / 2 * 3.5 * 6,
    ordinaryRefillM3: ((3.6 + 4.6) / 2 * 0.5 - 2.4 * 0.4 - 2.6 * 0.1) * 6,
    backfillM3: (2.6 + 5.6) / 2 * 3 * 6, finalOpenM3: (1.7 + 4.7) / 2 * 3 * 6, waterstopM: 6 };
  const foundationTags = measured.filter(bar => bar.phase.startsWith('기초타설')).map(bar => bar.tag);
  return { name: `retaining-wall-3m-${c.noncompliant ? 'noncompliant' : 'normal'}`, units: 4, entities,
    oracle: { conditions: c, dimensions: { wallHeightMm: 3000, wallThicknessMm: 300, foundationWidthMm: 2400, foundationThicknessMm: 400,
      lengthMm: 6000, leanWidthMm: 2600, leanThicknessMm: 100, excavationDepthMm: 3500, excavationBottomWidthMm: 3600, excavationTopWidthMm: 10600 },
    quantities, rebar: measured, totalRebarMassKg: measured.reduce((sum, bar) => sum + bar.totalMassKg, 0),
    foundationStage: { concreteM3: quantities.foundationConcreteM3, leanConcreteM3: quantities.leanConcreteM3, excavationM3: quantities.excavationM3,
      ordinaryRefillM3: 0, backfillM3: 0, waterstopM: 0, rebarTags: foundationTags,
      rebarMassKg: measured.filter(bar => foundationTags.includes(bar.tag)).reduce((sum, bar) => sum + bar.totalMassKg, 0) },
    limitations: ['교육·회귀시험용, 구조·지반·가시설 안전계산 및 시공승인 없음', '전단면 연장6m, 양단 가시설 수직막음 가정, 종방향 사면 없음',
      '기초타설 전 벽체수직근 전장 선조립 완료 가정', '가공 중심선, 실제 굽힘곡률·공차·손실 제외',
      '제조사·KS 원문과 단위중량 독립 대조 필요', '단부·배수공·필터·날개벽 물량 제외'] },
    expectedIssues: c.noncompliant ? ['cover', 'backfill-material', 'backfill-layer', 'backfill-compaction', 'lap-length', 'lap-location-needs-design-check', 'rebar-unit-mass'] : [],
    progressMarkups: progress(c) };
}
