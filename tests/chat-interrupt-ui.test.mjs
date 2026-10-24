import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseConnectionCommand } from '../public/chat-connections.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
class Element {
  constructor() { Object.assign(this, { hidden: false, disabled: false, value: '', textContent: '', children: [], listeners: {}, style: {}, dataset: {} }); this.classList = { toggle() {} }; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  querySelector() { return new Element(); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() { this.focused = true; }
  scrollIntoView() {}
}
function fixture() {
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const calls = []; let request = async () => ({ accepted: true });
  const stub = () => ({ sync() {}, update() {}, refresh: async () => {}, init: async () => {}, clear() {}, handleCommand() { return false; },
    currentId: () => 'test-chat', isPending: () => false, begin() {}, finish() {}, fail() {}, event() {}, selectedModel() {} });
  const context = vm.createContext({ document: { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, querySelectorAll: () => [], createElement: () => new Element() },
    CadEditor: class {}, createMcpSettings: stub, createSkillMenu: stub, createChatPanel: stub, createChatRuntime: stub,
    createChatConnections: stub, createChatSessionsUI: options => {
      let selectedChat = 'test-chat';
      const select = () => { if (!options.isBusy()) { selectedChat = 'new-chat'; options.onSelect({messages:[]}); } };
      ids['chat-new'].addEventListener('click', select); ids['chat-select'].addEventListener('change', select);
      return { ...stub(), currentId: () => selectedChat, sync() { ids['chat-new'].disabled = ids['chat-select'].disabled = options.isBusy(); } };
    }, parseConnectionCommand, readChatStream: async response => response.data,
    desktopRequest: async (...args) => { calls.push(args); return request(...args); }, appendProvenance() {},
    setInterval() {}, addEventListener() {}, fetch() { throw Error('Unexpected second chat request'); }, console,
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replace('await Promise.all([checkConnection(), connectEditor()]);', ''), context);
  const run = code => vm.runInContext(code, context);
  run('desktop = true; connected = true; ready = true;');
  return { ids, calls, run, request: callback => { request = callback; } };
}

test('registration help follows composer and the regional footer is removed', () => {
  assert.ok(html.indexOf('class="registration-help"') > html.indexOf('id="chat-form"'));
  assert.doesNotMatch(html, /class="composer-note"|경기도 광주시 주소만 입력하면/);
  assert.match(html, /id="stop-task"[^>]*type="button"/);
});

test('an active chat keeps composer editable and exposes a stop button but other work stays locked', () => {
  const { ids, run } = fixture();
  run('busy = true; chatRunning = true; activeChatId = "test-chat"; updateControls();');
  assert.equal(ids['message-input'].disabled, false);
  assert.equal(ids['stop-task'].hidden, false);
  assert.equal(ids['stop-task'].disabled, false);
  assert.equal(ids['send-message'].textContent, '추가 지시');
  assert.equal(ids.editor.inert, true);
  run('chatRunning = false; updateControls();');
  assert.equal(ids['message-input'].disabled, true);
});

test('additional instruction targets the current turn and never starts a second chat request', async () => {
  const { ids, calls, run } = fixture();
  run('busy = true; chatRunning = true; activeChatId = "test-chat";');
  ids['message-input'].value = '치수는 200mm로 변경해줘';
  await ids['chat-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['steer', { message: '치수는 200mm로 변경해줘', chatId: 'test-chat' }]]);
  assert.equal(ids['message-input'].value, '');
  assert.equal(ids.messages.children.length, 1);
  assert.equal(ids.messages.children[0].children[1].textContent, '치수는 200mm로 변경해줘');
  assert.equal(run('busy'), true);
});

test('failed steering preserves the draft and private registration commands never reach the runtime', async () => {
  const { ids, calls, run, request } = fixture();
  run('busy = true; chatRunning = true; activeChatId = "test-chat";');
  request(async () => { throw Error('현재 작업이 끝났습니다.'); });
  ids['message-input'].value = '색상은 빨강';
  await ids['chat-form'].listeners.submit({ preventDefault() {} });
  assert.equal(ids['message-input'].value, '색상은 빨강');
  assert.match(ids['workspace-notice'].textContent, /끝났/);
  for (const command of ['/api vworld', '/mcp add {"secret":"never-send"}', 'API 등록해줘']) {
    ids['message-input'].value = command;
    await ids['chat-form'].listeners.submit({ preventDefault() {} });
  }
  assert.equal(calls.length, 1);
  assert.equal(ids.messages.children.length, 0);
});

test('editing during a steering request does not erase the newer draft or send duplicate instructions', async () => {
  const { ids, calls, run, request } = fixture(); let release;
  run('busy = true; chatRunning = true; activeChatId = "test-chat";');
  request(() => new Promise(resolve => { release = resolve; }));
  ids['message-input'].value = '첫 추가 지시';
  const pending = ids['chat-form'].listeners.submit({ preventDefault() {} });
  ids['message-input'].value = '다음 추가 지시';
  await ids['chat-form'].listeners.submit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  release({ accepted: true }); await pending;
  assert.equal(ids['message-input'].value, '다음 추가 지시');
});

test('stop remains pending until the original chat ends and rejects further steering', async () => {
  const { ids, calls, run, request } = fixture(); let release;
  run('busy = true; chatRunning = true; activeChatId = "test-chat"; stopBridge = Object.assign(() => {}, {cancel: async () => ({cancelled:true})});');
  request(() => new Promise(resolve => { release = resolve; }));
  const pending = ids['stop-task'].listeners.click();
  assert.equal(ids['stop-task'].disabled, true);
  assert.match(ids['stop-task'].textContent, /정지 중/);
  ids['message-input'].value = '추가 실행';
  await ids['chat-form'].listeners.submit({ preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'cancel');
  release({ cancelled: true }); await pending;
  assert.equal(run('busy'), true);
  assert.equal(ids['stop-task'].disabled, true);
  assert.equal(ids['message-input'].value, '추가 실행');
});

test('browser handoff freezes controls before checking fresh clean state and rejects dirty drawings', async () => {
  const { ids, run } = fixture();
  run('cad.snapshot = async () => ({document_id:"doc",dirty:true,documents:[{id:"doc",dirty:true}],command:null,modal:null});');
  assert.equal(await run('browserSessionHooks.isSafeToTransfer()'), false);
  assert.equal(run('browserFrozen'), false);
  assert.match(ids['workspace-notice'].textContent, /저장/);
  run('cad.snapshot = async () => ({document_id:"doc",dirty:false,documents:[{id:"doc",dirty:false}],command:null,modal:null});');
  assert.equal(await run('browserSessionHooks.isSafeToTransfer()'), true);
  assert.equal(ids.editor.inert, true);
  assert.equal(ids['message-input'].disabled, true);
});

test('browser handoff refuses active work, open commands and dirty inactive documents', async () => {
  const { run } = fixture();
  run('busy = true; cad.snapshot = async () => { throw Error("must not inspect busy CAD"); };');
  assert.equal(await run('browserSessionHooks.isSafeToTransfer()'), false);
  run('busy = false;');
  for (const state of [
    { dirty: false, command: { name: 'LINE' } },
    { dirty: false, text_editor: 'editing' },
    { dirty: false, documents: [{ dirty: true }] },
    { document_id: 'unknown' },
  ]) {
    run(`cad.snapshot = async () => (${JSON.stringify(state)});`);
    assert.equal(await run('browserSessionHooks.isSafeToTransfer()'), false);
    assert.equal(run('browserFrozen'), false);
  }
});

test('a failed original stream preserves a newer typed instruction', async () => {
  const { ids, run } = fixture();
  run('cad.context = async () => ({}); fetch = async () => ({ok:false,json:async()=>({ok:false,error:"연결 중단"})});');
  ids['message-input'].value = '원래 도면 요청';
  const pending = ids['chat-form'].listeners.submit({ preventDefault() {} });
  ids['message-input'].value = '중간에 작성한 추가 지시';
  await pending;
  assert.equal(ids['message-input'].value, '중간에 작성한 추가 지시');
  assert.equal(run('chatRunning'), false);
  assert.equal(run('busy'), false);
});

test('handoff freeze verifies state again before draining the CAD bridge', async () => {
  const { run } = fixture();
  run('cad.snapshot = async () => ({dirty:false});');
  assert.equal(await run('browserSessionHooks.isSafeToTransfer()'), true);
  run('cad.snapshot = async () => ({dirty:true}); stopBridge = Object.assign(() => {throw Error("must not stop dirty drawing")}, {cancel:async()=>{throw Error("must not cancel dirty drawing")}});');
  await assert.rejects(run('browserSessionHooks.freeze()'), /먼저 저장/);
  run('cad.snapshot = async () => ({dirty:false}); let drained = false; let stopped = false; stopBridge = Object.assign(() => {stopped=true}, {cancel:async()=>{drained=true}});');
  await run('browserSessionHooks.freeze()');
  assert.equal(run('drained && stopped'), true);
  assert.equal(run('stopBridge'), undefined);
});


test('a finished stream waits for the steering response before unlocking or showing the final assistant', async () => {
  const { ids, run, request } = fixture(); let releaseSteer;
  run('cad.context = async () => ({}); cad.snapshot = async () => ({dirty:false}); let finishStream; fetch = async () => ({ok:true}); readChatStream = () => new Promise(resolve => { finishStream = resolve; });');
  ids['message-input'].value = '원래 도면 요청';
  const original = ids['chat-form'].listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  request(() => new Promise(resolve => { releaseSteer = resolve; }));
  ids['message-input'].value = '중간에 전달한 추가 지시';
  const steering = ids['chat-form'].listeners.submit({ preventDefault() {} });
  run('finishStream({executed:true,reply:"최종 응답"});');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('isBusy()'), true);
  assert.equal(ids['chat-new'].disabled, true);
  assert.equal(ids['chat-select'].disabled, true);
  ids['chat-new'].listeners.click(); ids['chat-select'].listeners.change();
  assert.equal(run('chatSessions.currentId()'), 'test-chat');
  assert.equal(ids.messages.children.length, 1);
  ids['message-input'].value = '다음 작업 초안';
  await ids['chat-form'].listeners.submit({ preventDefault() {} });
  releaseSteer({accepted:true});
  await Promise.all([original, steering]);
  assert.deepEqual(ids.messages.children.map(item => item.children[1].textContent), ['원래 도면 요청', '중간에 전달한 추가 지시', '최종 응답']);
  assert.equal(ids['message-input'].value, '다음 작업 초안');
  assert.equal(run('isBusy()'), false);
  assert.equal(ids['chat-new'].disabled, false);
});

test('a finished stream cannot unlock a newer turn before a delayed cancel response settles', async () => {
  const { ids, run, request } = fixture(); let releaseCancel;
  run('cad.context = async () => ({}); cad.snapshot = async () => ({dirty:false}); let finishStream; let chatRequests = 0; fetch = async () => {chatRequests++; return {ok:true}}; readChatStream = () => new Promise(resolve => { finishStream = resolve; });');
  ids['message-input'].value = '진행할 작업';
  const original = ids['chat-form'].listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  request(() => new Promise(resolve => { releaseCancel = resolve; }));
  const cancellation = ids['stop-task'].listeners.click();
  run('finishStream({executed:true,reply:"정지된 작업 결과"});');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('isBusy()'), true);
  assert.equal(ids['stop-task'].hidden, false);
  assert.match(ids['stop-task'].textContent, /정지 중/);
  assert.equal(ids['chat-new'].disabled, true);
  ids['chat-new'].listeners.click();
  assert.equal(run('chatSessions.currentId()'), 'test-chat');
  ids['message-input'].value = '새로운 작업 초안';
  await ids['chat-form'].listeners.submit({ preventDefault() {} });
  assert.equal(run('chatRequests'), 1);
  releaseCancel({cancelled:true});
  await Promise.all([original,cancellation]);
  assert.equal(run('isBusy()'), false);
  assert.equal(ids['message-input'].value, '새로운 작업 초안');
});
