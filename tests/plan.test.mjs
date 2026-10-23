import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChat, validatePlan } from '../lib/plan.mjs';

const input = () => ({ message: '6m 사각형', context: { documentId: 2, revision: 0, units: 4, selection: [], entities: [] }, history: [] });
test('validates the bounded chat context without mutating it', () => {
  const value = input();
  assert.deepEqual(validateChat(value), value);
  assert.equal(validateChat({ ...value, history: [{ role: 'assistant', text: '완료' }] }).history.length, 1);
});

test('accepts idle command state from the editor but refuses a new chat during a pending command', () => {
  const value=input();
  assert.equal(validateChat({...value,context:{...value.context,command:null}}).context.command,null);
  assert.throws(()=>validateChat({...value,context:{...value.context,command:{name:'LINE'}}}));
});
test('rejects malformed, oversized and injected context', () => {
  for (const value of [null, { ...input(), message: '' }, { ...input(), message: 'x'.repeat(2001) }, { ...input(), history: Array(9).fill({ role: 'user', text: 'x' }) }, { ...input(), context: { ...input().context, revision: -1 } }, { ...input(), context: { ...input().context, selection: ['../../secret'] } }, { ...input(), secret: true }, { ...input(), context: { ...input().context, entities: [{ x: Infinity }] } }]) {
    assert.throws(() => validateChat(value));
  }
});
test('accepts every supported operation and clarification', () => {
  const operations = [
    { type: 'rectangle', x_mm: 0, y_mm: 0, width_mm: 6000, height_mm: 4000 },
    { type: 'circle', x_mm: 0, y_mm: 0, radius_mm: 500 },
    { type: 'line', x1_mm: 0, y1_mm: 0, x2_mm: 100, y2_mm: 0 },
    { type: 'move', target: 'selection', dx_mm: 500, dy_mm: 0 },
    { type: 'measure', target: 'last' }, { type: 'undo' },
  ];
  assert.deepEqual(validatePlan({ reply: '완료', operations }), { reply: '완료', operations });
  assert.deepEqual(validatePlan({ reply: '치수를 알려주세요', operations: [] }).operations, []);
});

test('quantity review is a read-only operation without caller-supplied geometry or filters', () => {
  const operations = [{ type: 'quantity_review' }];
  assert.deepEqual(validatePlan({ reply: '레이어별 물량을 집계합니다.', operations }).operations, operations);
  assert.throws(() => validatePlan({ reply: '검토', operations: [{ type: 'quantity_review', totals: { area: 999 } }] }));
  assert.throws(() => validatePlan({ reply: '검토', operations: [{ type: 'quantity_review' }, { type: 'undo' }] }));
});
test('refuses arbitrary commands, extra fields and invalid geometry', () => {
  for (const operation of [
    { type: 'eval', code: 'alert(1)' },
    { type: 'rectangle', x_mm: 0, y_mm: 0, width_mm: -1, height_mm: 10 },
    { type: 'circle', x_mm: 0, y_mm: 0, radius_mm: 0 },
    { type: 'line', x1_mm: 0, y1_mm: 0, x2_mm: 0, y2_mm: 0 },
    { type: 'move', target: 'all', dx_mm: 1, dy_mm: 0 },
    { type: 'move', target: 'last', dx_mm: 0, dy_mm: 0 },
    { type: 'circle', x_mm: 1e9, y_mm: 0, radius_mm: 1 },
    { type: 'undo', code: 'x' }, { type: 'rectangle' },
  ]) assert.throws(() => validatePlan({ reply: 'x', operations: [operation] }));
  for (const value of [null, { reply: '', operations: [] }, { reply: 'x', operations: Array(9).fill({ type: 'undo' }) }, { reply: 'x', operations: [], code: 'x' }]) assert.throws(() => validatePlan(value));
});
