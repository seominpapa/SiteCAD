import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettings } from '../public/settings.js';

const TEST_LLM_KEY = 'sk-test-private-only';
const TEST_REFERENCE_KEY = 'private-api-key';
const TEST_DYNAMIC_API_KEY = 'private-dynamic-api-key';

const descendants = node => [node, ...node.children.flatMap(descendants)];
const content = node => descendants(node).map(item => item.textContent).join(' ');
class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], listeners: {}, dataset: {}, value: '', checked: false, disabled: false, textContent: '', hidden: false, open: false }); this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
  querySelectorAll(selector) { return descendants(this).filter(node => selector === '[data-secret]' ? node.dataset.secret : selector === 'button,input,textarea,select' ? ['button','input','textarea','select'].includes(node.tagName) : false); }
  set innerHTML(_) { assert.fail('Untrusted HTML rendering'); }
}
async function fixture(t, overrides = {}) {
  const prior = { document: globalThis.document, fetch: globalThis.fetch, window: globalThis.window };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([_, id]) => [id, new Element()]));
  ids['settings-content'].append(...['general','llm','api','mcp','plugins'].map(tab=>ids[`settings-panel-${tab}`]).filter(Boolean));
  const requests = []; let changes = 0, busy = false;
  const state = { active: 'openai-oauth', connections: [
    { id: 'openai-oauth', label: 'OpenAI · ChatGPT OAuth', provider: 'openai', method: 'oauth', configured: false },
    { id: 'openai-api', label: 'OpenAI · API 키', provider: 'openai', method: 'api', configured: true },
    { id: 'anthropic-api', label: 'Claude · API 키', provider: 'anthropic', method: 'api', configured: false },
    { id: 'anthropic-oauth', label: 'Claude Console · OAuth', provider: 'anthropic', method: 'oauth', configured: false },
  ] };
  globalThis.document = { getElementById: id => { assert.ok(ids[id], id); return ids[id]; }, createElement: tag => new Element(tag) };
  globalThis.window = { confirm: () => true };
  const storage = { path:'/Applications/SiteCAD/drawings',defaultPath:'/Applications/SiteCAD/drawings',isDefault:true };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({url, ...options});
    if(url.endsWith('/storage/save')){storage.path=JSON.parse(options.body).path||storage.defaultPath;storage.isDefault=storage.path===storage.defaultPath;}
    if(url.endsWith('/storage/select')){storage.path='/Users/example/도면 저장';storage.isDefault=false;}
    const data = url.endsWith('/storage') || url.endsWith('/storage/save') || url.endsWith('/storage/select') ? {...storage} : url.endsWith('/llm') || url.includes('/llm/') ? state : url.endsWith('/mcp') ? {servers:[]} : url.endsWith('/references') ? {vworld:{configured:false}} : url.endsWith('/plugins') ? {plugins:[]} : {};
    return Response.json({ok:true,data});
  };
  t.after(() => Object.assign(globalThis, prior));
  const ui = createSettings({isBusy:()=>busy,onChange:async()=>{changes++;},...overrides});
  ui.update({desktop:true});
  const field = name => descendants(ids['settings-content']).find(node=>node.dataset.field===name);
  const click = name => field(name).listeners.click();
  return {ui,ids,requests,state,storage,field,click,html,changes:()=>changes,busy:value=>{busy=value;ui.sync();}};
}

test('unified settings open read-only and expose accessible LLM/API/MCP/plugin tabs', async t=>{
  const {ids,ui,requests,html}=await fixture(t); await ui.open();
  assert.equal(ids['settings-dialog'].open,true);
  assert.match(html,/id="settings-dialog"[^>]*aria-labelledby="settings-title"/);
  assert.match(html,/role="tablist"/);
  assert.deepEqual(requests.map(r=>r.url).sort(),['storage','llm','mcp','references','kcsc','plugins','apis','updates'].map(p=>`/api/desktop/${p}`).sort());
  assert.ok(requests.every(r=>!r.method));
  assert.match(content(ids['settings-content']),/OpenAI.*API.*Claude/s);
});

test('general update button needs a newer version and explicit install consent',async t=>{
  const f=await fixture(t),original=globalThis.fetch;let update={supported:true,currentVersion:'0.16.3',status:'current',busy:false};
  globalThis.fetch=async(url,init)=>{
    if(url.endsWith('/updates'))return Response.json({ok:true,data:update});
    if(url.endsWith('/updates/check')){assert.deepEqual(JSON.parse(init.body),{});update={...update,status:'available',availableVersion:'0.16.4'};return Response.json({ok:true,data:update});}
    if(url.endsWith('/updates/install')){assert.deepEqual(JSON.parse(init.body),{approved:true});update={...update,busy:true,status:'scheduled'};return Response.json({ok:true,data:update});}
    return original(url,init);
  };
  await f.ui.open();assert.equal(f.field('updates-install').disabled,true);
  await f.click('updates-check');assert.equal(f.field('updates-install').disabled,false);assert.match(content(f.ids['settings-panel-general']),/0.16.3.*0.16.4/s);
  window.confirm=()=>false;await f.click('updates-install');assert.equal(update.busy,false);
  window.confirm=()=>true;await f.click('updates-install');assert.equal(update.busy,true);assert.equal(f.field('updates-install').disabled,true);
});

test('general settings show the installation-folder default and settings precedes the header folder action',async t=>{
  const {ui,ids,html,field,requests}=await fixture(t);await ui.open();
  assert.equal(ids['settings-panel-general']?.hidden,false);
  assert.equal(ids['settings-tab-general']?.['aria-selected'],'true');
  assert.match(content(ids['settings-panel-general']),/웹앱 폴더의 drawings.*Applications\/SiteCAD\/drawings/);
  assert.equal(field('storage-path'),undefined);assert.equal(field('storage-save'),undefined);
  assert.equal(field('storage-select')?.textContent,'폴더 선택');
  assert.match(content(ids['settings-panel-general']),/기존.*이동.*다음.*저장/s);
  const header=html.slice(html.indexOf('<header'),html.indexOf('</header>'));
  assert.match(header,/id="settings-open"[^>]*>[\s\S]*?설정[\s\S]*?id="local-actions"[\s\S]*?id="open-saved-folder"/);
  assert.equal((html.match(/id="settings-open"/g)||[]).length,1);
  assert.ok(requests.every(item=>!item.method));
});

test('native folder selection and default reset are explicit, refresh paths, and fail without hiding the old location',async t=>{
  const {ui,ids,field,requests,storage,busy}=await fixture(t);await ui.open();
  busy(true);const before=requests.length;await field('storage-select').listeners.click();assert.equal(requests.length,before);
  busy(false);await field('storage-select').listeners.click();
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/storage/select')).body),{});
  assert.equal(storage.path,'/Users/example/도면 저장');assert.match(content(ids['settings-panel-general']),/Users\/example\/도면 저장/);
  await field('storage-reset').listeners.click();
  assert.deepEqual(JSON.parse(requests.filter(item=>item.url.endsWith('/storage/save')).at(-1).body),{path:''});
  assert.equal(storage.path,'/Applications/SiteCAD/drawings');
  const fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/storage/select')?Response.json({ok:false,error:'private backend details'},{status:400}):fetcher(url,options);
  await field('storage-select').listeners.click();
  assert.match(content(ids['settings-panel-general']),/Applications\/SiteCAD\/drawings/);
  assert.match(ids['settings-notice'].textContent,/완료하지 못했습니다/);
  assert.doesNotMatch(ids['settings-notice'].textContent,/private backend/);
});

test('cancelled native folder selection preserves the location without refresh or change callback',async t=>{
  const {ui,ids,field,requests,changes}=await fixture(t);await ui.open();
  const fetcher=globalThis.fetch;let selections=0;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/storage/select')){selections++;assert.deepEqual(JSON.parse(options.body),{});return Response.json({ok:true,data:{cancelled:true}});}
    return fetcher(url,options);
  };
  const before=requests.length;await field('storage-select').listeners.click();
  assert.equal(selections,1);assert.equal(requests.length,before);assert.equal(changes(),0);
  assert.match(content(ids['settings-panel-general']),/Applications\/SiteCAD\/drawings/);
  assert.match(ids['settings-notice'].textContent,/취소.*변경하지 않았습니다/);
  assert.equal(field('storage-select').disabled,false);assert.equal(ids['settings-close'].disabled,false);
});

test('API keys only enter a private save request and clear after save and close',async t=>{
  const {ui,ids,field,requests,changes}=await fixture(t);await ui.open();
  const key=field('openai-api-key');assert.equal(key.type,'password'); key.value=TEST_LLM_KEY;
  await field('openai-api-form').listeners.submit({preventDefault(){}});
  const save=requests.find(r=>r.url.endsWith('/llm/save'));
  assert.deepEqual(JSON.parse(save.body),{id:'openai-api',apiKey:TEST_LLM_KEY});
  assert.equal(key.value,'');assert.equal(changes(),1);
  assert.doesNotMatch(content(ids['settings-content']),/sk-test-private-only/);
  field('anthropic-api-key').value='sk-ant-private-only';ids['settings-dialog'].close();
  assert.equal(field('anthropic-api-key').value,'');
});

test('provider changes use explicit selection and no credentials or backend errors render',async t=>{
  const {ui,field,requests,ids}=await fixture(t);await ui.open();await field('openai-api-select').listeners.click();
  assert.deepEqual(JSON.parse(requests.find(r=>r.url.endsWith('/llm/select')).body),{id:'openai-api'});
  globalThis.fetch=async()=>Response.json({ok:false,error:'sk-private-should-not-appear'},{status:400});
  field('openai-api-key').value='sk-private-should-not-appear';
  await field('openai-api-form').listeners.submit({preventDefault(){}});
  assert.doesNotMatch(ids['settings-notice'].textContent,/sk-private/);
  assert.equal(field('openai-api-key').value,'');
});

test('configured credentials remain unverified until a successful model check and failed checks stay visible',async t=>{
  const {ui,state,ids,field}=await fixture(t);
  state.connections.find(item=>item.id==='openai-api').connected=true;
  state.anthropicOAuth={available:false,notice:'공식 CLI 설치 후 로그인 버튼을 다시 누르세요.'};
  await ui.open();
  assert.doesNotMatch(content(ids['settings-content']),/연결 확인됨/);
  assert.equal(field('anthropic-oauth-login').disabled,false);
  const fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/llm/test')?Response.json({ok:true,data:{ok:false,message:'인증정보 또는 API 사용 권한을 확인해 주세요.'}}):fetcher(url,options);
  await field('openai-api-test').listeners.click();
  assert.match(ids['settings-notice'].textContent,/확인하지 못했습니다/);
  assert.doesNotMatch(ids['settings-notice'].textContent,/접근을 확인했습니다/);
});

test('Claude missing CLI response explains installation and keeps login retry available',async t=>{
  const {ui,ids,field}=await fixture(t);await ui.open();
  const fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/llm/login')?Response.json({ok:true,data:{actionNeeded:'install-anthropic-cli'}}):fetcher(url,options);
  await field('anthropic-oauth-login').listeners.click();
  assert.match(ids['settings-notice'].textContent,/공식 Claude Code를 설치/);
  assert.equal(field('anthropic-oauth-login').disabled,false);
});

test('Claude OAuth presents subscription notice, actionable CLI installation and sanitized login failures',async t=>{
  const {ui,state,ids}=await fixture(t),connection=state.connections.find(item=>item.id==='anthropic-oauth');
  connection.notice='Repeated Claude Pro·Max notice';connection.error='Claude Console 로그인을 완료하지 못했습니다.';
  state.anthropicOAuth={available:false,notice:connection.notice};await ui.open();
  const rendered=content(ids['settings-panel-llm']);
  assert.equal((rendered.match(/Pro·Max/g)||[]).length,1);
  assert.match(rendered,/공식 Claude Code 설치가 필요합니다/);
  assert.match(rendered,/Claude Console 로그인을 완료하지 못했습니다/);
  assert.ok(descendants(ids['settings-panel-llm']).some(item=>item.href==='https://code.claude.com/docs/en/quickstart'));
});

test('MCP and plugin settings only show chat installation guidance and registered inventories',async t=>{
  const {ui,ids,field,requests}=await fixture(t);await ui.open('mcp');
  assert.equal(ids['settings-panel-mcp'].hidden,false);
  assert.match(content(ids['settings-panel-mcp']),/채팅.*주소/);
  assert.match(content(ids['settings-panel-plugins']),/채팅.*주소/);
  for(const name of ['mcp-url','mcp-config','mcp-install','plugin-url','plugin-install'])assert.equal(field(name),undefined);
  assert.ok(requests.every(item=>!item.method));
});

test('API connectors require consent and use their existing private save contracts',async t=>{
  const {ui,field,requests}=await fixture(t);await ui.open();
  for(const id of ['vworld','kcsc']){
    field(`${id}-key`).value=TEST_REFERENCE_KEY;
    if(id==='vworld')field('vworld-domain').value='localhost';
    const before=requests.length;
    await field(`${id}-form`).listeners.submit({preventDefault(){}});assert.equal(requests.length,before);
    field(`${id}-trust`).checked=true;
    await field(`${id}-form`).listeners.submit({preventDefault(){}});
    const save=requests.find(item=>item.url.endsWith(id==='kcsc'?'/kcsc/save':'/references/save'));
    assert.deepEqual(JSON.parse(save.body),id==='kcsc'?{apiKey:TEST_REFERENCE_KEY,trusted:true}:{apiKey:TEST_REFERENCE_KEY,domain:'localhost'});
    assert.equal(field(`${id}-key`).value,'');
  }
});

test('registered MCP changes and plugin removal require explicit scoped requests',async t=>{
  const {ui,field,requests}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>options?.method?fetcher(url,options):url.endsWith('/mcp')?Response.json({ok:true,data:{servers:[{name:'demo',enabled:true}]}}):url.endsWith('/plugins')?Response.json({ok:true,data:{plugins:[{name:'helper',skills:[]}]}}):fetcher(url,options);
  await ui.open();await field('mcp-demo-toggle').listeners.click();
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/mcp/toggle')).body),{name:'demo',enabled:false});
  await field('mcp-demo-test').listeners.click();await field('mcp-demo-remove').listeners.click();
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/mcp/remove')).body),{name:'demo'});
  await field('plugin-helper-remove').listeners.click();assert.ok(!requests.some(item=>item.url.endsWith('/plugins/remove')));
  field('plugin-helper-consent').checked=true;field('plugin-helper-consent').listeners.change();
  await field('plugin-helper-remove').listeners.click();
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/plugins/remove')).body),{name:'helper',approved:true});
});

test('busy state blocks configuration mutations and tabs support keyboard navigation',async t=>{
  const {ui,ids,field,busy,requests}=await fixture(t);await ui.open();
  busy(true);const before=requests.length;await field('openai-api-select').listeners.click();assert.equal(requests.length,before);
  busy(false);ids['settings-tab-llm'].listeners.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(ids['settings-tab-api']['aria-selected'],'true');
});

test('chat registered APIs have issuance guidance, private key save, focused settings and removal',async t=>{
  const {ui,ids,field,requests}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/apis')?Response.json({ok:true,data:{apis:[{id:'weather',name:'날씨 API',url:'https://weather.example/api',issuanceUrl:'https://weather.example/keys',configured:false,status:'key_required',adapterReady:false}]}}):fetcher(url,options);
  await ui.open('api','weather');
  assert.equal(ids['settings-tab-api']['aria-selected'],'true');
  const key=field('api-weather-key');assert.equal(key.type,'password');assert.equal(key.focused,true);
  assert.ok(descendants(ids['settings-panel-api']).some(item=>item.href==='https://weather.example/keys'));
  assert.match(content(ids['settings-panel-api']),/실제.*API.*실행/);
  key.value=TEST_DYNAMIC_API_KEY;field('api-weather-trust').checked=true;
  await field('api-weather-form').listeners.submit({preventDefault(){}});
  const save=requests.find(item=>item.url.endsWith('/apis/save'));
  assert.deepEqual(JSON.parse(save.body),{id:'weather',apiKey:TEST_DYNAMIC_API_KEY});
  assert.equal(key.value,'');assert.doesNotMatch(content(ids['settings-content']),/private-dynamic-api-key/);
  await field('api-weather-remove').listeners.click();
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/apis/remove')).body),{id:'weather'});
});

test('dynamic API links reject unsafe URLs and keys clear on close',async t=>{
  const {ui,ids,field}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/apis')?Response.json({ok:true,data:{apis:[{id:'unsafe',name:'Unsafe',issuanceUrl:'javascript:alert(1)',url:'https://user:secret@example.com'}]}}):fetcher(url,options);
  await ui.open('api','unsafe');field('api-unsafe-key').value='private';ids['settings-dialog'].close();
  assert.equal(field('api-unsafe-key').value,'');
  assert.ok(!descendants(ids['settings-panel-api']).some(item=>item.href?.startsWith('javascript:')||item.href?.includes('user:secret')));
});

test('settings model selection uses only a retrieved catalog entry',async t=>{
  const chosen=[];const {ui,field,requests}=await fixture(t,{onModelSelect:model=>chosen.push(model.id)});await ui.open();
  const fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/models')?Response.json({ok:true,data:{models:[{id:'official-model',displayName:'공식 모델'},{id:'<invalid>'}]}}):fetcher(url,options);
  // The active OAuth connection in this fixture is unconfigured, so choose the configured API connection first.
  field('openai-api-select').disabled=false;
  await field('openai-api-select').listeners.click();
  // Simulate the sanitized active selection returned by the backend.
  globalThis.fetch=async(url,options)=>url.endsWith('/llm')?Response.json({ok:true,data:{active:'openai-api',connections:[{id:'openai-api',configured:true}]}}):url.endsWith('/models')?Response.json({ok:true,data:{models:[{id:'official-model',displayName:'공식 모델'},{id:'<invalid>'}]}}):fetcher(url,options);
  await ui.open();await field('llm-model-load').listeners.click();
  assert.equal(field('llm-model-select').children.length,1);
  await field('llm-model-apply').listeners.click();assert.deepEqual(chosen,['official-model']);
  assert.ok(!requests.some(r=>r.url.endsWith('/chat')));
});

test('MCP and plugin inventories render statuses without private launch data',async t=>{
  const {ui,ids}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/mcp')?Response.json({ok:true,data:{servers:[{name:'rea',connected:true,transport:'stdio',command:'/private/secret',args:['credential'],envKeys:['TOKEN']},{name:'oauth',status:'authenticationRequired'},{name:'failed',status:'failed'},{name:'disabled',enabled:false}]}}):url.endsWith('/plugins')?Response.json({ok:true,data:{plugins:[{name:'quantity',skills:['check'],status:'installed',body:'secret instructions',path:'/private/path'}]}}):fetcher(url,options);
  await ui.open('mcp');
  const mcp=content(ids['settings-panel-mcp']);assert.match(mcp,/rea.*연결됨/);assert.match(mcp,/oauth.*인증 필요/);assert.match(mcp,/failed.*연결 실패/);assert.match(mcp,/disabled.*사용 안 함/);
  assert.doesNotMatch(mcp,/private|credential|TOKEN/);
  const plugins=content(ids['settings-panel-plugins']);assert.match(plugins,/quantity.*스킬 1개/);assert.doesNotMatch(plugins,/secret instructions|private/);
});

test('failed refresh keeps the complete previous settings inventory and shows a safe error',async t=>{
  const {ui,ids}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/mcp')?Response.json({ok:true,data:{servers:[{name:'kept',connected:true}]}}):fetcher(url,options);
  await ui.open('mcp');
  globalThis.fetch=async(url)=>url.endsWith('/references')?Response.json({ok:false,error:'/private/backend'},{status:400}):Response.json({ok:true,data:{servers:[{name:'partial-new'}]}});
  await ui.refresh();
  assert.match(content(ids['settings-panel-mcp']),/kept/);assert.doesNotMatch(content(ids['settings-panel-mcp']),/partial-new/);
  assert.match(ids['settings-notice'].textContent,/완료하지 못/);assert.doesNotMatch(ids['settings-notice'].textContent,/private/);
});

test('MCP environment credentials stay private, require consent and target only declared fields',async t=>{
  const {ui,ids,field,requests}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/mcp')?Response.json({ok:true,data:{servers:[{name:'weather',enabled:false,credentialsRequired:true,credentialRequirements:{envKeys:['WEATHER_API_KEY'],issuanceUrl:'https://weather.example/keys'}}]}}):fetcher(url,options);
  await ui.open('api','mcp-weather');
  const key=field('mcp-weather-env-WEATHER_API_KEY');assert.equal(key.type,'password');assert.equal(key.focused,true);
  assert.equal(field('mcp-weather-toggle').disabled,true);assert.equal(field('mcp-weather-test').disabled,true);
  assert.match(content(ids['settings-panel-mcp']),/키 등록 필요.*실행 대기/);
  key.value='private-mcp-key';await field('mcp-weather-credentials-form').listeners.submit({preventDefault(){}});
  assert.ok(!requests.some(item=>item.url.endsWith('/mcp/credentials')));
  field('mcp-weather-credentials-trust').checked=true;
  await field('mcp-weather-credentials-form').listeners.submit({preventDefault(){}});
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/mcp/credentials')).body),{name:'weather',env:{WEATHER_API_KEY:'private-mcp-key'},trusted:true});
  assert.equal(key.value,'');assert.doesNotMatch(content(ids['settings-content']),/private-mcp-key/);
  assert.match(content(ids['settings-panel-api']),/Bearer.*OAuth/s);
});

test('HTTP MCP bearer credentials never claim connected and clear on close',async t=>{
  const {ui,ids,field,requests}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/mcp')?Response.json({ok:true,data:{servers:[{name:'httpdemo',enabled:false,credentialsRequired:true,credentialRequirements:{bearerToken:true}}]}}):fetcher(url,options);
  await ui.open('api','mcp-httpdemo');const key=field('mcp-httpdemo-bearer');key.value='private-http-token';field('mcp-httpdemo-credentials-trust').checked=true;
  await field('mcp-httpdemo-credentials-form').listeners.submit({preventDefault(){}});
  assert.deepEqual(JSON.parse(requests.find(item=>item.url.endsWith('/mcp/credentials')).body),{name:'httpdemo',bearerToken:'private-http-token',trusted:true});
  assert.match(ids['settings-notice'].textContent,/연결 확인/);
  field('mcp-httpdemo-bearer').value='another-private-token';ids['settings-dialog'].close();assert.equal(field('mcp-httpdemo-bearer').value,'');
});

test('MCP and plugin installation outcomes remain in collapsed settings history',async t=>{
  const {ui,ids}=await fixture(t),fetcher=globalThis.fetch;
  globalThis.fetch=async(url,options)=>url.endsWith('/mcp')?Response.json({ok:true,data:{servers:[],installationResults:[{id:'fail',kind:'mcp',name:'failed-server',status:'failed',message:'설치를 완료하지 못했습니다.',createdAt:'2026-11-02T02:00:00Z'},{id:'wait',kind:'mcp',name:'weather',status:'key_required',message:'인증 키 등록이 필요합니다.',createdAt:'2026-11-02T01:00:00Z'}]}}):url.endsWith('/plugins')?Response.json({ok:true,data:{plugins:[],installationResults:[{id:'installed',kind:'plugin',name:'drawing-check',status:'installed',message:'설치되었습니다.',createdAt:'2026-11-02T00:00:00Z'}]}}):fetcher(url,options);
  await ui.open('mcp');
  for(const tab of ['mcp','plugins']){
    const history=descendants(ids[`settings-panel-${tab}`]).find(item=>item.tagName==='details');
    assert.ok(history);assert.equal(history.open,false);assert.match(content(history),/설치 기록.*2026/s);
  }
  assert.match(content(ids['settings-panel-mcp']),/failed-server.*설치 실패.*weather.*키 등록 필요/s);
  assert.match(content(ids['settings-panel-plugins']),/drawing-check.*설치됨/s);
});

test('downloaded web update asks to save before enabling the final installation action',async t=>{
  const f=await fixture(t),original=globalThis.fetch;let installs=0,message='';
  globalThis.fetch=async(url,init)=>{
    if(url.endsWith('/updates'))return Response.json({ok:true,data:{supported:true,kind:'web',currentVersion:'0.16.3',availableVersion:'0.16.4',status:'ready',busy:false}});
    if(url.endsWith('/updates/install')){installs++;return Response.json({ok:true,data:{supported:true,kind:'web',currentVersion:'0.16.3',availableVersion:'0.16.4',status:'installing',busy:true}});}
    return original(url,init);
  };
  await f.ui.open();
  assert.equal(f.field('updates-install').textContent,'저장 후 재시작하여 설치');assert.equal(f.field('updates-check').disabled,true);
  window.confirm=value=>{message=value;return false;};await f.click('updates-install');assert.equal(installs,0);assert.match(message,/DWG로 저장/);
  window.confirm=()=>true;await f.click('updates-install');assert.equal(installs,1);
});
