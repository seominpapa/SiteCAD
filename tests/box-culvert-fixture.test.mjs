import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoxCulvertFixture } from '../scripts/box-culvert-fixture.mjs';
import { validateControlRequest } from '../public/control-schema.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const shapeLength = shape => shape.vertices.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - shape.vertices[index][0], point[1] - shape.vertices[index][1]), 0);

test('box fixture quantities match independent geometry, void exclusion and stage accounting', () => {
  const fixture = buildBoxCulvertFixture();
  const q = fixture.oracle.quantities;
  close(q.concreteM3, 20.16);
  close(q.foundationConcreteM3, 4.68);
  close(q.leanConcreteM3, 1.736);
  close(q.excavationM3, 510.01266666666663);
  close(q.backfillM3, 452.1166666666666);
  close(q.waterstopM, 12);
  close(q.excavationM3 - q.backfillM3, q.concreteM3 + q.leanConcreteM3 + 36);
  const stage = fixture.oracle.foundationStage;
  close(stage.concreteM3, 4.68);
  close(stage.excavationM3, q.excavationM3);
  close(stage.leanConcreteM3, q.leanConcreteM3);
  assert.equal(stage.backfillM3, 0);
  assert.equal(stage.waterstopM, 0, 'Swelling strip is installed after base concrete cures, not at the base-pour stage');
  assert.ok(fixture.entities.some(entity => entity.type === 'Text' && entity.value.includes('양생 후') && entity.value.includes('12m')));
  assert.deepEqual(stage.rebarTags, ['B1', 'B2', 'V1']);
  assert.ok(stage.rebarTags.includes('V1'), 'Foundation stage includes erected wall vertical bars anchored in the foundation');
  assert.ok(!stage.rebarTags.includes('H1'));
});

test('every scheduled bar traces to an actual measured cutting polyline and independent reference unit mass', () => {
  const fixture = buildBoxCulvertFixture();
  const bars = fixture.oracle.rebar;
  assert.deepEqual([...new Set(bars.map(bar => bar.diameter))].sort(), ['D13', 'D16', 'D19']);
  for (const bar of bars) {
    const shape = fixture.entities[bar.shapeEntityIndex];
    assert.equal(shape.type, 'LwPolyline');
    assert.equal(shape.layer, `BAR_SHAPE_${bar.tag}`);
    close(shapeLength(shape), bar.cutLengthMm);
    close(bar.totalLengthM, shapeLength(shape) / 1000 * bar.count);
    close(bar.totalMassKg, bar.totalLengthM * bar.referenceUnitMassKgM);
    close(bar.scheduleUnitMassKgM, bar.referenceUnitMassKgM);
    assert.ok(fixture.entities.some(entity => entity.type === 'Text' && entity.value.startsWith(`${bar.tag} | ${bar.diameter}`)), bar.tag);
    assert.ok(fixture.entities.some(entity => entity.layer === `BAR_LEADER_${bar.tag}` && entity.type === 'Line'), bar.tag);
  }
  const foundation = bars.filter(bar => ['B1', 'B2', 'V1'].includes(bar.tag)).reduce((sum, bar) => sum + bar.totalMassKg, 0);
  close(fixture.oracle.foundationStage.rebarMassKg, foundation);
  close(fixture.oracle.totalRebarMassKg, bars.reduce((sum, bar) => sum + bar.totalMassKg, 0));
});

test('noncompliant fixture changes physical cover and explicit schedule evidence without changing independent unit-mass reference', () => {
  const normal = buildBoxCulvertFixture();
  const wrong = buildBoxCulvertFixture({ noncompliant: true });
  assert.equal(normal.oracle.conditions.coverMm, 75);
  assert.equal(wrong.oracle.conditions.coverMm, 20);
  assert.equal(wrong.oracle.conditions.backfillLayerMm, 400);
  assert.equal(wrong.oracle.conditions.backfillMaterial, '유기질토·건설폐기물 혼합토');
  assert.equal(wrong.oracle.conditions.lapLocation, '최대인장응력 구간, 동일 단면 전수 겹이음');
  assert.ok(wrong.expectedIssues.includes('cover'));
  assert.ok(wrong.expectedIssues.includes('backfill-material'));
  assert.ok(wrong.expectedIssues.includes('backfill-layer'));
  assert.ok(wrong.expectedIssues.includes('rebar-unit-mass'));
  assert.ok(wrong.expectedIssues.includes('lap-location-needs-design-check'));
  const wrongBar = wrong.oracle.rebar.find(bar => bar.tag === 'H1');
  const normalBar = normal.oracle.rebar.find(bar => bar.tag === 'H1');
  close(wrongBar.referenceUnitMassKgM, normalBar.referenceUnitMassKgM);
  assert.notEqual(wrongBar.scheduleUnitMassKgM, wrongBar.referenceUnitMassKgM);
  assert.notEqual(wrongBar.scheduleMassKg, wrongBar.totalMassKg);
  assert.ok(wrong.entities.some(entity => entity.type === 'Text' && entity.value.includes('유기질토')));
  assert.ok(wrong.entities.some(entity => entity.type === 'Text' && entity.value.includes('동일 단면 전수')));
});

test('all fixture and separate stage markups are accepted flat CAD inputs and isolated per build', () => {
  const fixture = buildBoxCulvertFixture();
  assert.equal(fixture.units, 4);
  assert.ok(fixture.entities.length > 100 && fixture.entities.length < 700);
  for (let offset = 0; offset < fixture.entities.length; offset += 200) {
    assert.doesNotThrow(() => validateControlRequest({ op: 'entities_create', entities: fixture.entities.slice(offset, offset + 200) }));
  }
  assert.doesNotThrow(() => validateControlRequest({ op: 'entities_create', entities: fixture.progressMarkups }));
  assert.ok(fixture.progressMarkups.some(entity => entity.type === 'Hatch'));
  assert.ok(fixture.progressMarkups.some(entity => entity.layer === 'PROGRESS_01_WALL_VERTICAL' && entity.type === 'LwPolyline'));
  assert.ok(fixture.progressMarkups.every(entity => entity.layer.startsWith('PROGRESS_01_')));
  fixture.oracle.conditions.coverMm = 999;
  fixture.entities[0].layer = 'CHANGED';
  const another = buildBoxCulvertFixture();
  assert.equal(another.oracle.conditions.coverMm, 75);
  assert.notEqual(another.entities[0].layer, 'CHANGED');
  assert.throws(() => buildBoxCulvertFixture({ noncompliant: 'yes' }));
  assert.throws(() => buildBoxCulvertFixture({ coverMm: -1 }));
});
