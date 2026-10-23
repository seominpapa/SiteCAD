const UNIT_MM = { 1: 25.4, 2: 304.8, 3: 1_609_344, 4: 1, 5: 10, 6: 1000,
  7: 1_000_000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6,
  13: 0.001, 14: 100, 15: 10000, 16: 100000, 21: 1200000 / 3937 };

export function mmPerUnit(units) {
  const scale = UNIT_MM[units];
  if (!scale) throw new Error('도면 단위가 미설정이거나 지원 범위 밖입니다. mm 단위의 새 도면을 사용해 주세요.');
  return scale;
}
