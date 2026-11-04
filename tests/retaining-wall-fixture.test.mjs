import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetainingWallFixture } from '../scripts/retaining-wall-fixture.mjs';
import { validateControlRequest } from '../public/control-schema.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const area = vertices => Math.abs(vertices.reduce((sum, [x, y], i) => { const next = vertices[(i + 1) % vertices.length]; return sum + x * next[1] - next[0] * y; }, 0)) / 2;
const length = vertices => vertices.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - vertices[i][0], p[1] - vertices[i][1]), 0);

test('retaining wall separates concrete, excavation, ordinary refill and structural backfill with a balanced final section', () => {
  const fixture = buildRetainingWallFixture();
  const q = fixture.oracle.quantities;
  close(q.concreteM3, 11.16);
  close(q.foundationConcreteM3, 5.76);
  close(q.wallConcreteM3, 5.4);
  close(q.leanConcreteM3, 1.56);
  close(q.excavationM3, 149.1);
  close(q.ordinaryRefillM3, 4.98);
  close(q.backfillM3, 73.8);
  close(q.finalOpenM3, 57.6);
  close(q.waterstopM, 6);
  close(q.excavationM3, q.concreteM3 + q.leanConcreteM3 + q.ordinaryRefillM3 + q.backfillM3 + q.finalOpenM3);
  const excavation = fixture.entities.find(entity => entity.layer === 'EXCAVATION');
  const backfill = fixture.entities.find(entity => entity.layer === 'BACKFILL_BOUNDARY');
  close(area(excavation.vertices) / 1e6 * 6, q.excavationM3);
  close(area(backfill.vertices) / 1e6 * 6, q.backfillM3);
  assert.ok(fixture.entities.some(entity => entity.value?.includes('양단 가시설 수직막음')));
  assert.ok(fixture.entities.some(entity => entity.value?.includes('구조계산 미수행')));
});

test('all diameter-tagged schedule rows trace to measured polylines and independently specified installation counts', () => {
  const fixture = buildRetainingWallFixture();
  assert.deepEqual([...new Set(fixture.oracle.rebar.map(bar => bar.diameter))].sort(), ['D13', 'D16', 'D19']);
  for (const bar of fixture.oracle.rebar) {
    const shape = fixture.entities[bar.shapeEntityIndex];
    assert.equal(shape.layer, `BAR_SHAPE_${bar.tag}`);
    close(length(shape.vertices), bar.cutLengthMm);
    close(bar.totalLengthM, bar.count * length(shape.vertices) / 1000);
    close(bar.totalMassKg, bar.totalLengthM * bar.referenceUnitMassKgM);
    close(bar.scheduleUnitMassKgM, bar.referenceUnitMassKgM);
    assert.ok(fixture.entities.some(entity => entity.layer === `BAR_LEADER_${bar.tag}`));
    assert.ok(fixture.entities.some(entity => entity.layer === 'BAR_COUNT_NOTE' && entity.value.includes(bar.tag)));
  }
  assert.deepEqual(fixture.oracle.rebar.map(bar => [bar.tag, bar.count]), [['B1', 62], ['B2', 24], ['V1', 62], ['H1', 32]]);
});

test('foundation stage includes all erected wall vertical bars but excludes subsequent work and waterstop', () => {
  const fixture = buildRetainingWallFixture();
  const stage = fixture.oracle.foundationStage;
  assert.deepEqual(stage.rebarTags, ['B1', 'B2', 'V1']);
  close(stage.concreteM3, 5.76);
  close(stage.excavationM3, 149.1);
  close(stage.leanConcreteM3, 1.56);
  assert.equal(stage.backfillM3, 0);
  assert.equal(stage.ordinaryRefillM3, 0);
  assert.equal(stage.waterstopM, 0);
  close(stage.rebarMassKg, fixture.oracle.rebar.filter(bar => stage.rebarTags.includes(bar.tag)).reduce((sum, bar) => sum + bar.totalMassKg, 0));
  assert.equal(fixture.progressMarkups.filter(entity => entity.type === 'Hatch').length, 3);
  assert.ok(fixture.progressMarkups.some(entity => entity.layer === 'PROGRESS_01_WALL_VERTICAL'));
  assert.ok(fixture.entities.some(entity => entity.value?.includes('기초 양생 후') && entity.value?.includes('6m')));
});

test('intentional defects have physical cover and lap evidence plus an incorrect H1 schedule mass', () => {
  const fixture = buildRetainingWallFixture({ noncompliant: true });
  assert.equal(fixture.oracle.conditions.coverMm, 20);
  assert.equal(fixture.oracle.conditions.backfillLayerMm, 400);
  assert.equal(fixture.oracle.conditions.backfillCompactionPercent, 90);
  assert.equal(fixture.oracle.conditions.lapLengthMm, 200);
  assert.ok(fixture.oracle.conditions.backfillMaterial.includes('유기질토'));
  assert.ok(fixture.expectedIssues.includes('lap-location-needs-design-check'));
  assert.ok(fixture.expectedIssues.includes('rebar-unit-mass'));
  const h1 = fixture.oracle.rebar.find(bar => bar.tag === 'H1');
  close(h1.referenceUnitMassKgM, 0.995);
  close(h1.scheduleUnitMassKgM, 1.2);
  assert.ok(h1.scheduleMassKg > h1.totalMassKg);
  const a = fixture.entities.find(entity => entity.layer === 'BAR_VIEW_V1A');
  const b = fixture.entities.find(entity => entity.layer === 'BAR_VIEW_V1B');
  close(Math.max(...a.vertices.map(p => p[1])) - Math.min(b.start[1], b.end[1]), 200);
});

test('fixture controls and stage markups validate, builds are isolated and unsupported inputs fail', () => {
  for (const fixture of [buildRetainingWallFixture(), buildRetainingWallFixture({ noncompliant: true })]) {
    assert.equal(fixture.units, 4);
    assert.ok(fixture.entities.length > 100 && fixture.entities.length < 700);
    for (let i = 0; i < fixture.entities.length; i += 200) assert.doesNotThrow(() => validateControlRequest({ op: 'entities_create', entities: fixture.entities.slice(i, i + 200) }));
    assert.doesNotThrow(() => validateControlRequest({ op: 'entities_create', entities: fixture.progressMarkups }));
    assert.ok(fixture.progressMarkups.every(entity => entity.layer.startsWith('PROGRESS_01_')));
  }
  const fixture = buildRetainingWallFixture();
  fixture.entities[0].layer = 'CHANGED';
  fixture.oracle.conditions.coverMm = 999;
  const other = buildRetainingWallFixture();
  assert.equal(other.oracle.conditions.coverMm, 75);
  assert.notEqual(other.entities[0].layer, 'CHANGED');
  for (const input of [null, [], { noncompliant: 'yes' }, { extra: true }]) assert.throws(() => buildRetainingWallFixture(input));
});
