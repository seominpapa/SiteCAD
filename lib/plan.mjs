import { readFileSync } from 'node:fs';

export const planSchema = JSON.parse(readFileSync(new URL('../plan.schema.json', import.meta.url), 'utf8'));
const operationSchemas = planSchema.properties.operations.items.anyOf;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

export function validatePlan(value) {
  if (!exact(value, ['reply', 'operations']) || !text(value.reply, 2000) || !Array.isArray(value.operations) || value.operations.length > 8) throw Error('Invalid plan');
  if (value.operations.some(op => op?.type === 'quantity_review') && value.operations.length !== 1) throw Error('Quantity review must be read-only');
  for (const operation of value.operations) {
    const schema = operationSchemas.find(item => item.properties.type.const === operation?.type);
    if (!schema || !exact(operation, schema.required)) throw Error('Unsupported operation');
    for (const [key, rule] of Object.entries(schema.properties)) {
      const item = operation[key];
      if (rule.const !== undefined && item !== rule.const) throw Error('Invalid operation type');
      if (rule.enum && !rule.enum.includes(item)) throw Error('Invalid target');
      if (rule.type === 'number' && (!Number.isFinite(item) || item < (rule.minimum ?? -Infinity) || item > rule.maximum || (rule.exclusiveMinimum !== undefined && item <= rule.exclusiveMinimum))) throw Error('Invalid dimension');
    }
    if (operation.type === 'line' && operation.x1_mm === operation.x2_mm && operation.y1_mm === operation.y2_mm) throw Error('Zero length line');
    if (operation.type === 'move' && operation.dx_mm === 0 && operation.dy_mm === 0) throw Error('Zero movement');
  }
  return value;
}

function boundedSummary(value, depth = 0) {
  if (depth > 5) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1e15;
  if (typeof value === 'string') return value.length <= 1000;
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => boundedSummary(item, depth + 1));
  return object(value) && Object.keys(value).length <= 30 && Object.entries(value).every(([key, item]) => key.length <= 60 && !['__proto__', 'constructor', 'prototype'].includes(key) && boundedSummary(item, depth + 1));
}

export function validateChat(value) {
  if (!exact(value, ['message', 'context', 'history']) || !text(value.message, 2000)) throw Error('메시지는 1~2000자로 입력해 주세요.');
  const context = value.context;
  if (!object(context) || !['documentId', 'revision', 'units', 'selection', 'entities'].every(key=>Object.hasOwn(context,key)) || Object.keys(context).some(key=>!['documentId','revision','units','selection','entities','geometryRevision','layout','command'].includes(key)) || (context.command !== undefined && context.command !== null) || (context.geometryRevision !== undefined && !integer(context.geometryRevision)) || (context.layout !== undefined && !text(context.layout,200)) || !integer(context.documentId) || !integer(context.revision) || !integer(context.units, 24)) throw Error('도면 상태를 다시 확인해 주세요.');
  if (!Array.isArray(context.selection) || context.selection.length > 100 || context.selection.some(handle => typeof handle !== 'string' || !/^[0-9a-f]{1,16}$/i.test(handle))) throw Error('선택 객체가 올바르지 않습니다.');
  if (!Array.isArray(context.entities) || context.entities.length > 150 || context.entities.some(entity => !object(entity) || !boundedSummary(entity)) || JSON.stringify(context.entities).length > 80000) throw Error('도면 요약이 너무 크거나 올바르지 않습니다.');
  if (!Array.isArray(value.history) || value.history.length > 8 || value.history.some(item => !exact(item, ['role', 'text']) || !['user', 'assistant'].includes(item.role) || !text(item.text, 2000))) throw Error('대화 기록을 다시 확인해 주세요.');
  return value;
}
