const TABS = ['general', 'llm', 'api', 'mcp', 'plugins'];
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';

export function createSettings({ isBusy, onChange = async () => {}, onModelSelect = () => {} }) {
  const $ = id => document.getElementById(id);
  const dialog = $('settings-dialog');
  let supported = false, pending = false, activeTab = 'general', state = {}, updateTimer;
  const controls = new Map();
  const node = (tag, value = '') => { const item = document.createElement(tag); item.textContent = value; return item; };
  const locked = () => !supported || pending || isBusy();
  const register = (item, allowed = () => true) => { controls.set(item, allowed); return item; };
  function notice(message = '', error = false) {
    $('settings-notice').textContent = message; $('settings-notice').hidden = !message;
    $('settings-notice').classList.toggle('error', error);
  }
  function clearSecrets() {
    for (const item of controls.keys()) if (item.dataset.secret) item.value = '';
  }
  function sync() {
    $('settings-open').hidden = !supported;
    $('settings-open').disabled = locked();
    $('settings-refresh').disabled = locked();
    $('settings-close').disabled = pending;
    for (const [item, allowed] of controls) item.disabled = locked() || !allowed();
  }
  async function request(path, body) {
    const response = await fetch(`/api/desktop/${path}`, body === undefined ? {cache:'no-store'} : {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Error('설정 요청에 실패했습니다.');
    return result.data;
  }
  async function action(task) {
    if (locked()) return;
    pending = true; sync(); notice();
    try { await task(); }
    catch { notice('요청을 완료하지 못했습니다. 입력값·권한·연결 상태를 확인한 뒤 다시 시도해 주세요.', true); }
    finally { pending = false; sync(); }
  }
  async function refresh() {
    const [llm,mcp,references,kcsc,plugins,apis,storage,updates] = await Promise.all(['llm','mcp','references','kcsc','plugins','apis','storage','updates'].map(path=>request(path)));
    state = {llm,mcp,references,kcsc,plugins,apis,storage,updates}; render();
  }
  async function changed(message = '설정을 반영했습니다.', llmChanged = false) {
    await refresh(); await onChange({llmChanged}); notice(message);
  }
  function field(parent, name, label, type = 'text', secret = false) {
    const wrap = node('label',label), input = node(type === 'textarea' ? 'textarea':'input');
    input.dataset.field = name; input.autocomplete = 'off'; input.spellcheck = false;
    if (type !== 'textarea') input.type = type;
    if (secret) input.dataset.secret = 'true';
    if (type === 'checkbox') wrap.className = 'mcp-trust-label';
    input.maxLength = type === 'textarea' ? 65536 : 1024;
    wrap.append(input); parent.append(wrap); register(input); return input;
  }
  function button(parent,name,label,handler,allowed = () => true) {
    const item = node('button',label); item.type = 'button'; item.dataset.field = name;
    item.addEventListener('click', () => { if (!locked() && allowed()) return handler(); });
    parent.append(item); return register(item,allowed);
  }
  function external(parent,label,href) {
    let safe;try{const url=new URL(href);if(url.protocol!=='https:'||url.username||url.password)return;safe=url.href;}catch{return;}
    const link=node('a',label); link.href=safe; link.target='_blank'; link.rel='noopener noreferrer'; parent.append(link);
  }
  function card(parent,title,description) {
    const article=node('article'); article.className='settings-card';
    article.append(node('h3',title),node('p',description)); parent.append(article);return article;
  }
  function submit(form,handler) {
    form.addEventListener('submit',event=>{event.preventDefault(); if (!locked()) return handler();});
  }
  function pollUpdates() {
    clearTimeout(updateTimer);
    if (!dialog.open || !(state.updates?.busy || state.updates?.status === 'ready')) return;
    updateTimer = setTimeout(async () => {
      try {
        const updates = await request('updates');
        const changed = JSON.stringify(updates) !== JSON.stringify(state.updates);
        state = {...state,updates};
        if (changed && activeTab === 'general' && !pending) render();
      } catch { /* A successful update closes the old local server. */ }
      pollUpdates();
    }, 1500);
    updateTimer.unref?.();
  }
  function generalPanel(parent) {
    const update=state.updates??{};
    const updateBox=card(parent,'SiteCAD 업데이트',`현재 버전: ${text(update.currentVersion,30)||'확인 필요'}`);
    const available=typeof update.availableVersion==='string' && /^\d+\.\d+\.\d+$/.test(update.availableVersion);
    updateBox.append(node('p',available?`새 버전: ${update.availableVersion}`:update.status==='current'?'현재 최신 버전을 사용하고 있습니다.':update.supported===false?'개발용 실행에서는 설치 업데이트를 지원하지 않습니다.':'새 버전이 있는지 확인해 주세요.'));
    updateBox.append(node('p','업데이트 전에 필요한 도면을 저장해 주세요. 설치 후 앱을 다시 열며 기존 도면·설정·로그인 정보는 유지합니다.'));
    if(update.status==='ready')updateBox.append(node('p','다운로드가 완료됐습니다. 필요한 도면을 저장한 뒤 아래 버튼을 눌러 설치해 주세요.'));
    if(update.status==='failed'||update.lastInstallFailed)updateBox.append(node('p','업데이트를 확인하거나 완료하지 못했습니다. 인터넷 연결과 설치 폴더 권한을 확인한 뒤 다시 시도해 주세요.'));
    if(update.busy===true)updateBox.append(node('p',update.status==='downloading'?`업데이트 다운로드 중${Number.isFinite(update.progress)?` · ${Math.round(update.progress*100)}%`:''}`:'업데이트를 처리하고 있습니다.'));
    const updateActions=node('div');updateActions.className='settings-actions';updateBox.append(updateActions);
    button(updateActions,'updates-check','새 버전 확인',()=>action(async()=>{state={...state,updates:await request('updates/check',{})};render();}),()=>update.supported===true&&update.busy!==true&&update.status!=='ready');
    button(updateActions,'updates-install',update.status==='ready'?'저장 후 재시작하여 설치':available?`${update.availableVersion} 업데이트`:'업데이트',()=>action(async()=>{
      const message=update.kind==='web'&&update.status!=='ready'?'업데이트를 다운로드할까요? 다운로드 후 도면을 저장하고 설치를 다시 확인할 수 있습니다.': '필요한 도면을 DWG로 저장했나요? 앱을 종료한 뒤 업데이트를 설치합니다. 기존 도면·설정·로그인 정보는 유지합니다.';
      if(!window.confirm(message))return;
      state={...state,updates:await request('updates/install',{approved:true})};render();notice('업데이트를 시작했습니다. 설치 안내에 따라 진행해 주세요.');
    }),()=>update.supported===true&&update.busy!==true&&available);
    const current=text(state.storage?.path,4096),defaultPath=text(state.storage?.defaultPath,4096);
    const box=card(parent,'도면 저장 폴더','기존 도면은 이동하지 않습니다. 변경한 폴더는 다음 DWG 저장부터 사용합니다.');
    for(const [label,path] of [['현재 저장 위치',current],['기본 위치 · 웹앱 폴더의 drawings',defaultPath]]) {
      const value=node('p',`${label}: ${path||'확인 필요'}`);value.className='settings-path';box.append(value);
    }
    const actions=node('div');actions.className='settings-actions';box.append(actions);
    button(actions,'storage-select','폴더 선택',()=>action(async()=>{
      const result=await request('storage/select',{});
      if(result?.cancelled===true){notice('폴더 선택을 취소하여 저장 위치를 변경하지 않았습니다.');return;}
      await changed('도면 저장 위치를 변경했습니다. 다음 저장부터 적용됩니다.');
    }));
    button(actions,'storage-reset','기본 폴더로 되돌리기',()=>action(async()=>{await request('storage/save',{path:''});await changed('기본 저장 위치인 웹앱 폴더의 drawings로 변경했습니다.');}),()=>Boolean(current&&defaultPath)&&state.storage?.isDefault===false);
    box.append(node('p','‘폴더 선택’을 누르면 운영체제의 폴더 선택 창이 열립니다. 저장 권한이 있는 폴더를 선택하면 바로 적용되며, 상단 ‘저장 폴더’에서 열 수 있습니다. 브라우저가 별도로 다운로드하는 복사본은 브라우저의 다운로드 설정을 따릅니다.'));
  }
  function llmPanel(parent) {
    parent.append(node('p','AI 연결을 저장한 뒤 사용할 연결을 선택하세요. API 연결은 각 제공자의 사용량 과금이 적용됩니다. 키는 이 PC에 암호화 저장하며 채팅이나 AI 입력에 포함하지 않습니다.'));
    const rows = Array.isArray(state.llm?.connections) ? state.llm.connections : [];
    for (const connection of rows) {
      if (!['openai-oauth','openai-api','anthropic-api','anthropic-oauth'].includes(connection.id)) continue;
      const id=connection.id, configured=connection.configured===true;
      const current=state.llm.active===id;
      const verified=connection.lastCheck?.ok===true;
      const status=current ? configured?'현재 사용':'현재 선택 · 연결 필요' : verified ? '모델 목록 확인됨' : configured ? '등록됨 · 연결 미확인' : '연결 필요';
      const box=card(parent,text(connection.label,120)||id,status);
      if (connection.notice) box.append(node('p',text(connection.notice)));
      if (id==='anthropic-oauth' && connection.error) {
        const error=node('p',text(connection.error));error.className='mcp-notice error';error.setAttribute('role','status');box.append(error);
      }
      const form=node('form');form.dataset.field=`${id}-form`;box.append(form);
      if (id.endsWith('-api')) {
        const key=field(form,`${id}-key`,configured?'API 키 변경':'API 키','password',true);
        const workspace=id==='anthropic-api' ? field(form,`${id}-workspace`,'Workspace ID (필요한 경우)') : undefined;
        const save=button(form,`${id}-save`,'키 저장',()=>{},()=>Boolean(key.value.trim()));save.type='submit';
        key.addEventListener('input',sync);
        submit(form,async()=>{
          const apiKey=key.value.trim(),workspaceId=workspace?.value.trim();
          if (!apiKey || apiKey.length>1024 || /[\x00-\x20]/.test(apiKey)) {notice('공백 없는 API 키를 입력해 주세요.',true);return;}
          key.value='';
          await action(async()=>{await request('llm/save',{id,apiKey,...(workspaceId?{workspaceId}:{})});await changed('키를 저장했습니다. 사용할 연결 선택과 모델 목록 확인을 진행해 주세요.',true);});
        });
        external(box,id==='openai-api'?'OpenAI API 키 발급':'Claude API 키 발급',id==='openai-api'?'https://platform.openai.com/api-keys':'https://platform.claude.com/settings/keys');
      } else {
        if (id==='anthropic-oauth') box.append(node('p','Claude 구독 계정으로 공식 Claude Code 로그인 절차를 진행합니다. 로그인 정보는 이 PC의 SiteCAD 전용 프로필에 보관합니다.'));
        const available=id!=='anthropic-oauth'||state.llm.anthropicOAuth?.available!==false;
        button(form,`${id}-login`,id==='openai-oauth'?'ChatGPT로 로그인':'Claude로 로그인·다시 확인',()=>action(async()=>{
          const result=await request('llm/login',{id});
          await changed(['install-anthropic-cli','install-claude-code'].includes(result?.actionNeeded)?'공식 Claude Code를 설치한 뒤 Claude 로그인 버튼을 다시 눌러 주세요.':'기본 브라우저에서 공식 로그인을 완료한 뒤 새로 고침을 눌러 주세요.',true);
        }));
        if (!available) {
          box.append(node('p','공식 Claude Code 설치가 필요합니다. 설치를 완료한 뒤 로그인 버튼을 다시 눌러 주세요.'));
          external(box,'공식 Claude Code 설치 안내',state.llm.anthropicOAuth?.installUrl||'https://code.claude.com/docs/en/quickstart');
        }
        external(box,'공식 인증 안내',id==='openai-oauth'?'https://developers.openai.com/codex/auth/':'https://code.claude.com/docs/en/authentication');
      }
      const actions=node('div');actions.className='settings-actions';box.append(actions);
      button(actions,`${id}-select`,current?'사용 중':'이 연결 사용',()=>action(async()=>{await request('llm/select',{id});await changed('사용할 AI 연결을 변경했습니다. 다음 요청부터 적용됩니다.',true);}),()=>configured&&!current);
      button(actions,`${id}-test`,'모델 목록·연결 확인',()=>action(async()=>{
        const check=await request('llm/test',{id});
        await changed(check?.ok===true?'모델 목록 접근을 확인했습니다. 실제 모델 실행 권한은 요청 시 별도로 확인됩니다.':'모델 목록 연결을 확인하지 못했습니다. 인증정보·API 권한·네트워크를 확인해 주세요.');
        if(check?.ok!==true)$('settings-notice').classList.toggle('error',true);
      }),()=>configured);
      button(actions,`${id}-remove`,id.endsWith('-api')?'키 삭제':'로그아웃',()=>action(async()=>{await request('llm/remove',{id});await changed('이 연결의 로컬 인증을 해제했습니다.',true);}),()=>configured);
    }
    const catalog=card(parent,'사용 중인 연결의 모델','모델 목록 조회는 추론 요청을 보내지 않습니다. 모델 실행에는 선택한 연결의 구독 한도 또는 API 요금과 계정 권한이 적용됩니다.');
    const select=node('select');select.dataset.field='llm-model-select';select.setAttribute('aria-label','사용할 AI 모델');catalog.append(select);
    let models=[];
    register(select,()=>models.length>0);
    button(catalog,'llm-model-load','모델 목록 불러오기',()=>action(async()=>{
      const result=await request('models');
      models=Array.isArray(result?.models)?result.models.filter(item=>item&&typeof item.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/.test(item.id)).slice(0,500):[];
      if(!models.length)throw Error();
      select.replaceChildren(...models.map(item=>{const option=node('option',text(item.displayName,160)||item.id);option.value=item.id;return option;}));
      select.value=models.find(item=>item.id===result.defaultModel)?.id??models.find(item=>item.isDefault)?.id??models[0].id;
      notice('실제 모델 목록을 불러왔습니다. 사용할 모델을 선택해 적용하세요.');
    }),()=>rows.some(item=>item.id===state.llm.active&&item.configured));
    button(catalog,'llm-model-apply','선택 모델 적용',()=>{const model=models.find(item=>item.id===select.value);if(model){onModelSelect(model);notice('선택 모델은 다음 요청부터 사용합니다.');}},()=>models.some(item=>item.id===select.value));
  }
  function apiPanel(parent) {
    parent.append(node('p','API 추가는 채팅에 공식 문서 주소와 등록 요청을 입력하세요. 필요한 키의 발급 안내와 입력 항목이 이곳에 기록됩니다. API 키는 채팅에 입력하지 마세요.'));
    for (const id of ['vworld','kcsc']) {
      const kcsc=id==='kcsc', connection=kcsc?state.kcsc:state.references?.vworld, configured=connection?.configured===true;
      const checked=kcsc?connection?.connected===true:connection?.lastCheck?.ok===true;
      const status=!configured?'키 미등록':checked?'키 등록됨 · 연결 확인됨':connection?.lastCheck?.ok===false?'키 등록됨 · 연결 확인 실패':'키 등록됨 · 연결 미확인';
      const box=card(parent,kcsc?'KCSC · 국가건설기준센터':'VWorld',status);
      const form=node('form');form.dataset.field=`${id}-form`;box.append(form);
      const key=field(form,`${id}-key`,'API 키','password',true);
      const domain=kcsc?undefined:field(form,`${id}-domain`,'발급 시 등록한 도메인 (선택)');
      const trust=field(form,`${id}-trust`,kcsc?'KCSC MCP·Python 실행 환경 설치와 키의 로컬 저장·기준 조회 전송에 동의합니다.':'키의 로컬 저장과 VWorld API 요청에 사용함에 동의합니다.','checkbox');
      key.addEventListener('input',()=>{trust.checked=false;sync();});trust.addEventListener('change',sync);
      const save=button(form,`${id}-save`,kcsc?'설치·키 등록·연결':'키 저장',()=>{},()=>trust.checked&&Boolean(key.value.trim()));save.type='submit';
      submit(form,async()=>{
        if (!trust.checked||!key.value.trim()) {notice('키와 설치·저장 동의를 확인해 주세요.',true);return;}
        const apiKey=key.value.trim(),registeredDomain=domain?.value.trim();
        if(!/^[\x21-\x7e]{8,1024}$/.test(apiKey)||(!kcsc&&!/^[A-Za-z0-9_-]{8,256}$/.test(apiKey))||registeredDomain&&/[\s\x00-\x1f]/.test(registeredDomain)){notice('API 키와 등록 도메인의 형식을 확인해 주세요.',true);return;}
        key.value='';trust.checked=false;
        await action(async()=>{await request(kcsc?'kcsc/save':'references/save',{apiKey,...(kcsc?{trusted:true}:registeredDomain?{domain:registeredDomain}:{})});await changed('API 설정을 반영했습니다.');});
      });
      button(form,`${id}-test`,'연결 확인',()=>action(async()=>{const result=await request(kcsc?'kcsc/test':'references/test',{});const ok=kcsc?result?.connected===true:result?.ok===true;await changed(ok?'실제 연결을 확인했습니다.':'연결 확인 실패. 키와 API 사용 권한을 확인해 주세요.');if(!ok)$('settings-notice').classList.toggle('error',true);}),()=>configured);
      button(form,`${id}-remove`,'키·연결 삭제',()=>action(async()=>{await request(kcsc?'kcsc/remove':'references/remove',{});await changed('API 키·연결을 삭제했습니다.');}),()=>configured||(kcsc&&state.kcsc?.installed));
      external(box,'공식 API 발급 안내',kcsc?'https://kcsc.re.kr/support/api':'https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do');
    }
    for(const api of state.apis?.apis??[])registeredApi(parent,api);
    for(const server of state.mcp?.servers??[])mcpCredentials(parent,server);
  }
  function registeredApi(parent, api) {
    if(!api || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(api.id) || ['vworld','kcsc'].includes(api.id))return;
    const id=api.id,prefix=`api-${id}`;
    const box=card(parent,text(api.name,120)||id,api.configured?'키 등록됨 · 실제 API 실행 미확인':'API 키 등록 필요');
    box.append(node('p','키 저장은 실제 API 실행과 별개입니다. 지원되는 조회 기능과 연결 상태는 채팅에서 확인하세요.'));
    external(box,'서비스 공식 문서',api.url);
    external(box,'API 키 발급 사이트',api.issuanceUrl);
    const form=node('form');form.dataset.field=`${prefix}-form`;box.append(form);
    const key=field(form,`${prefix}-key`,'API 키','password',true);
    const trust=field(form,`${prefix}-trust`,'이 API의 키를 로컬 보안 저장소에 저장하는 데 동의합니다.','checkbox');
    key.addEventListener('input',()=>{trust.checked=false;sync();});trust.addEventListener('change',sync);
    const save=button(form,`${prefix}-save`,'키 저장',()=>{},()=>trust.checked&&Boolean(key.value.trim()));save.type='submit';
    submit(form,async()=>{
      if(!trust.checked)return;
      const apiKey=key.value.trim();
      if(!apiKey||apiKey.length>1024||/[\x00-\x20]/.test(apiKey)){notice('공백 없는 API 키를 입력해 주세요.',true);return;}
      key.value='';trust.checked=false;
      await action(async()=>{await request('apis/save',{id,apiKey});await changed('키를 저장했습니다. 실제 API 실행 여부는 별도로 확인해야 합니다.');});
    });
    button(box,`${prefix}-remove`,'API 항목·키 삭제',()=>action(async()=>{await request('apis/remove',{id});await changed('API 항목과 저장된 키를 삭제했습니다.');}));
  }
  function mcpCredentials(parent,server) {
    const requirements=server.credentialRequirements;
    if(!requirements||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(server.name))return;
    const envKeys=Array.isArray(requirements.envKeys)?requirements.envKeys.filter(key=>typeof key==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(key)).slice(0,20):[];
    if(!envKeys.length&&requirements.bearerToken!==true)return;
    const name=server.name,prefix=`mcp-${name}`;
    const box=card(parent,`${text(name,100)} · MCP 인증`,server.credentialsRequired?'인증 키 등록 필요 · 실행 대기':'키 등록됨 · 실제 연결은 MCP 탭에서 확인');
    box.append(node('p','MCP 인증은 선언된 환경 변수 또는 HTTP Bearer 토큰을 지원합니다. OAuth 로그인·사용자명/비밀번호 등 다른 인증은 자동으로 처리하지 않습니다.'));
    external(box,'공식 인증 키 발급 안내',requirements.issuanceUrl);
    const form=node('form');form.dataset.field=`${prefix}-credentials-form`;box.append(form);
    const inputs=envKeys.map(key=>({key,input:field(form,`${prefix}-env-${key}`,key,'password',true)}));
    const bearer=requirements.bearerToken===true?field(form,`${prefix}-bearer`,'HTTP Bearer 토큰','password',true):undefined;
    for(const input of [...inputs.map(item=>item.input),...(bearer?[bearer]:[])])input.maxLength=8192;
    const trust=field(form,`${prefix}-credentials-trust`,'이 MCP 실행 대상과 키 사용 범위를 확인했으며 키의 로컬 보안 저장과 MCP 활성화·실행에 동의합니다.','checkbox');
    const keys=()=>[...inputs.map(item=>item.input),...(bearer?[bearer]:[])];
    for(const input of keys())input.addEventListener('input',()=>{trust.checked=false;sync();});trust.addEventListener('change',sync);
    const save=button(form,`${prefix}-credentials-save`,'키 저장·MCP 활성화',()=>{},()=>trust.checked&&keys().every(input=>input.value.trim()));save.type='submit';
    submit(form,async()=>{
      if(!trust.checked)return;
      if(keys().some(input=>!input.value.trim()||input.value.trim().length>8192||!/^[\x21-\x7e]+$/.test(input.value.trim()))){notice('공백 없는 인증 키를 입력해 주세요.',true);return;}
      const credentials=bearer?{bearerToken:bearer.value.trim()}:{env:Object.fromEntries(inputs.map(({key,input})=>[key,input.value.trim()]))};
      for(const input of keys())input.value='';trust.checked=false;
      await action(async()=>{await request('mcp/credentials',{name,...credentials,trusted:true});await changed('인증 키를 저장하고 MCP를 활성화했습니다. MCP 탭의 연결 확인으로 실제 동작을 확인하세요.');});
    });
  }
  function installationHistory(parent,data) {
    if(data?.installationHistoryWarning)parent.append(node('p','일부 설치 기록을 저장하지 못했습니다. 현재 등록 목록과 상태를 확인해 주세요.'));
    const rows=Array.isArray(data?.installationResults)?data.installationResults.slice(0,30):[];
    if(!rows.length)return;
    const details=node('details');details.className='settings-installation-history';
    details.append(node('summary',`설치 기록 · ${rows.length}건`));
    const labels={connected:'연결 확인됨',installed:'설치됨',failed:'설치 실패',key_required:'키 등록 필요'};
    for(const result of rows){
      if(!result||!labels[result.status])continue;
      const item=node('article');item.className='source-card';
      item.append(node('strong',`${text(result.name,100)} · ${labels[result.status]}`));
      const date=new Date(result.createdAt);
      if(!Number.isNaN(date.getTime())){const time=node('time',date.toLocaleString('ko-KR'));time.dateTime=date.toISOString();item.append(time);}
      item.append(node('p',text(result.message,400)));details.append(item);
    }
    parent.append(details);
  }
  function mcpPanel(parent) {
    parent.append(node('p','MCP 추가는 채팅에 공식 주소와 “설치해 줘”를 입력하세요. AI가 설치 방법을 확인하고 진행하며 결과는 여기에 기록됩니다. 환경 변수·HTTP Bearer 인증은 API 탭에서 등록하며 다른 인증은 제공자별 지원 확인이 필요합니다.'));
    external(parent,'OpenAI MCP 설정 문서','https://developers.openai.com/codex/mcp/');
    external(parent,'Claude MCP 설정 문서','https://code.claude.com/docs/en/mcp');
    installationHistory(parent,state.mcp);
    if(!state.mcp?.servers?.length)parent.append(node('p','등록된 MCP가 없습니다.'));
    for (const server of state.mcp?.servers??[]) {
      const status=server.credentialsRequired?'키 등록 필요 · 실행 대기':server.enabled===false?'사용 안 함':server.connected?'연결됨':server.status==='authenticationRequired'?'인증 필요':server.status==='failed'?'연결 실패':'연결 미확인';
      const box=card(parent,text(server.name,100),status);
      const name=server.name;
      button(box,`mcp-${name}-toggle`,server.enabled===false?'활성화':'비활성화',()=>action(async()=>{await request('mcp/toggle',{name,enabled:server.enabled===false});await changed();}),()=>server.credentialsRequired!==true);
      if(server.credentialsRequired)button(box,`mcp-${name}-credentials-open`,'API 탭에서 인증 키 등록',()=>open('api',`mcp-${name}`));
      button(box,`mcp-${name}-test`,'연결 확인',()=>action(async()=>{await request('mcp/test',{name});await changed('MCP 연결 확인 요청을 완료했습니다.');}),()=>server.enabled!==false&&server.credentialsRequired!==true);
      button(box,`mcp-${name}-remove`,'등록 삭제',()=>action(async()=>{await request('mcp/remove',{name});await changed('MCP 등록을 삭제했습니다.');}));
    }
  }
  function pluginPanel(parent) {
    parent.append(node('p','플러그인 추가는 채팅에 공식 주소와 “설치해 줘”를 입력하세요. AI가 지원되는 설치 방법과 포함된 스킬을 확인하며 결과는 여기에 기록됩니다. SiteCAD는 검토한 지침형 플러그인을 지원합니다.'));
    external(parent,'OpenAI 플러그인 문서','https://developers.openai.com/codex/plugins/');
    external(parent,'Claude 플러그인 문서','https://code.claude.com/docs/en/plugins');
    installationHistory(parent,state.plugins);
    if(!state.plugins?.plugins?.length)parent.append(node('p','설치된 플러그인이 없습니다.'));
    for (const plugin of state.plugins?.plugins??[]) {
      const box=card(parent,text(plugin.name,100),`스킬 ${Array.isArray(plugin.skills)?plugin.skills.length:0}개 · ${text(plugin.status,50)}`);
      const consent=field(box,`plugin-${plugin.name}-consent`,'이 플러그인과 포함된 스킬의 삭제에 동의합니다.','checkbox');consent.addEventListener('change',sync);
      button(box,`plugin-${plugin.name}-remove`,'플러그인 삭제',()=>action(async()=>{await request('plugins/remove',{name:plugin.name,approved:true});await changed('플러그인을 삭제했습니다.');}),()=>consent.checked);
    }
  }
  function selectTab(tab,focus=false) {
    activeTab=tab;
    for (const name of TABS) {
      const selected=name===tab;
      $(`settings-tab-${name}`).setAttribute('aria-selected',String(selected));
      $(`settings-tab-${name}`).tabIndex=selected?0:-1;
      $(`settings-panel-${name}`).hidden=!selected;
    }
    if (focus) $(`settings-tab-${tab}`).focus();
  }
  function render() {
    clearSecrets();controls.clear();
    for (const [tab,builder] of [['general',generalPanel],['llm',llmPanel],['api',apiPanel],['mcp',mcpPanel],['plugins',pluginPanel]]) {
      const panel=$(`settings-panel-${tab}`);panel.replaceChildren();builder(panel);
    }
    selectTab(activeTab);sync();pollUpdates();
  }
  async function open(tab='general',focusId) {
    if (locked()) return;
    selectTab(TABS.includes(tab)?tab:'general');
    if (!dialog.open) dialog.showModal();
    await action(refresh);
    if(activeTab==='api'&&typeof focusId==='string'){const name=['vworld','kcsc'].includes(focusId)?`${focusId}-key`:`api-${focusId}-key`;for(const item of controls.keys())if(item.dataset.field===name||(focusId.startsWith('mcp-')&&item.dataset.field?.startsWith(`${focusId}-`)&&item.dataset.secret)){item.focus();break;}}
  }
  $('settings-open').addEventListener('click',open);
  $('settings-refresh').addEventListener('click',()=>action(refresh));
  $('settings-close').addEventListener('click',()=>{if(!pending)dialog.close();});
  dialog.addEventListener('close',()=>{clearSecrets();clearTimeout(updateTimer);});
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  for (const tab of TABS) {
    $(`settings-tab-${tab}`).addEventListener('click',()=>selectTab(tab));
    $(`settings-tab-${tab}`).addEventListener('keydown',event=>{
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const index=event.key==='Home'?0:event.key==='End'?TABS.length-1:(TABS.indexOf(tab)+(event.key==='ArrowRight'?1:-1)+TABS.length)%TABS.length;
      selectTab(TABS[index],true);
    });
  }
  return {open,sync,refresh:()=>action(refresh),update(status){supported=status.desktop===true;sync();}};
}
