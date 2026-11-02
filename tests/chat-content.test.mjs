import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChatContent } from '../public/chat-content.js';

class Element {
  constructor(tag, ownerDocument) { Object.assign(this, { tagName: tag, ownerDocument, children: [], style: {} }); }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { assert.fail('Untrusted HTML must not execute'); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.text = ''; this.children = items; }
  setAttribute(name, value) { this[name] = value; }
}
const doc = { createElement: tag => new Element(tag, doc) };
const all = (element, tag) => [element, ...element.children.flatMap(child => all(child, tag))].filter(child => child.tagName === tag);
const render = text => { const body = doc.createElement('div'); renderChatContent(body, text); return body; };

test('quantity and standards replies render semantic tables, units and unknown values without Markdown syntax', () => {
  const body = render('## 물량 검토\n\n**H1 결과**\n\n| 기호 | 직경 | 총길이 (m) | 판정 |\n| :--- | ---: | ---: | --- |\n| `H1` | H19 | 13.152 | 일치 |\n| H2 | 미확인 | — | 미확인 |\n\n### 기준 검토\n| 기준·조항 | 도면 값 | 검토 결과 |\n| --- | --- | --- |\n| 원문 미확인 | 200mm | 보류 |\n\n근거를 더 확인합니다.');
  assert.equal(all(body, 'table').length, 2);
  assert.equal(all(body, 'th').length, 7);
  assert.equal(all(body, 'td')[2].textContent, '13.152');
  assert.equal(all(body, 'td')[6].textContent, '—');
  assert.equal(all(body, 'h2')[0].textContent, '물량 검토');
  assert.equal(all(body, 'strong')[0].textContent, 'H1 결과');
  assert.equal(all(body, 'code')[0].textContent, 'H1');
  assert.doesNotMatch(body.textContent, /\*\*|##|\|\s*---/);
  assert.match(body.textContent, /총길이 \(m\).*미확인.*기준·조항.*보류.*근거/s);
  for (const scroll of all(body, 'div').filter(item => item.className === 'chat-table-scroll')) {
    assert.equal(scroll.tabIndex, 0); assert.equal(scroll.role, 'region');
  }
});

test('escaped pipes and inline code do not shift quantities; uneven rows preserve all original values', () => {
  const body = render('| 기호 | 근거 |\n| --- | --- |\n| H1\\|A | `a|b` |\n| H2 | 2 | 잃으면 안 되는 값 |');
  assert.equal(all(body, 'table').length, 1);
  assert.deepEqual(all(body, 'td').map(cell => cell.textContent), ['H1|A', 'a|b']);
  assert.match(body.textContent, /H2.*2.*잃으면 안 되는 값/);
  const incomplete = render('| 기호 | 값 |\n| --- |');
  assert.equal(all(incomplete, 'table').length, 0);
  assert.match(incomplete.textContent, /기호.*값/s);
});

test('raw HTML stays text, unsafe links never become active and HTTPS citations remain clickable', () => {
  const body = render('<img src=x onerror=attack()>\n\n| 근거 | 값 |\n| --- | --- |\n| <script>attack()</script> | **미확인** |\n\n[공식 원문](https://example.com/standard#3) [실행](javascript:attack) [파일](file:///private/key) [계정](https://user:secret@example.com/)');
  assert.equal(all(body, 'img').length, 0); assert.equal(all(body, 'script').length, 0);
  assert.match(body.textContent, /<script>attack\(\)<\/script>/);
  const links = all(body, 'a'); assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/standard#3');
  assert.match(links[0].rel, /noopener/);
  assert.doesNotMatch(body.textContent, /\*\*/);
});

test('fenced examples remain literal and updating a streamed response replaces the prior rendering', () => {
  const body = render('```text\n| 예시 | 값 |\n| --- | --- |\n| X | 1 |\n```\n\n- 첫 근거\n- *다음 근거*\n\n1. 첫 단계\n2. 다음 단계');
  assert.equal(all(body, 'table').length, 0);
  assert.match(all(body, 'pre')[0].textContent, /\| X \| 1 \|/);
  assert.equal(all(body, 'li').length, 4);
  assert.equal(all(body, 'em')[0].textContent, '다음 근거');
  renderChatContent(body, '| 기호 | 값 |\n| --- | --- |\n| H1 | 8 |');
  assert.equal(all(body, 'table').length, 1); assert.equal(all(body, 'pre').length, 0);
  assert.equal(all(body, 'td')[1].textContent, '8');
});
