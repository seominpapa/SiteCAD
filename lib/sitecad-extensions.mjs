const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(name) && !['sitecad','research','constructor','prototype'].includes(name);

export function createSitecadExtensions({skills,installer,registry,reaSource,onApproval,isCurrent,getSignal,getConversation}) {
  let staged = [];
  let calls = 0;
  const check = () => { if (!isCurrent() || getSignal()?.aborted) throw Error('작업을 취소했습니다.'); };
  const approve = async (kind,tool,args) => {
    check();
    const result = await onApproval({kind,server:'SiteCAD',tool,arguments:args});
    check(); return result === 'approve';
  };
  const available = async name => {
    if (!validName(name)) throw Error('MCP 이름을 확인해 주세요.');
    if (staged.length >= 4) throw Error('한 채팅에서 MCP는 네 개까지 추가할 수 있습니다.');
    if (staged.some(item => item.config.name === name) || (await registry.list()).some(item=>item.name===name)) throw Error('이미 등록된 MCP 이름입니다. 기존 설정에서 확인해 주세요.');
    check();
  };
  async function manageMcp(value) {
    const allowed = {list:['action'],inspect:['action','url'],install:['action','planId','name','args'],add:['action','name','preset','url']};
    if (!keys(value,allowed[value?.action] ?? [])) throw Error('MCP 관리 입력을 확인해 주세요.');
    if (value.action === 'list') return {servers:await registry.list(),pending:staged.map(item=>({name:item.config.name,status:'installed_pending_connection'}))};
    if (value.action === 'inspect') return installer.inspect(value.url,{signal:getSignal()});
    if (!['install','add'].includes(value.action)) throw Error('MCP 관리 입력을 확인해 주세요.');
    await available(value.name);
    let item;
    if (value.action === 'install') {
      item = await installer.install({planId:value.planId,name:value.name,args:value.args ?? []},{signal:getSignal(),approve:proposal=>approve('mcp-install','MCP 설치 및 연결',{...proposal,name:value.name,args:value.args ?? []})});
      if (!isCurrent() || getSignal()?.aborted) { await installer.remove(item.installation.id); check(); }
    } else {
      let config;
      if (value.preset === 'rea' && value.url === undefined && reaSource) config = {name:value.name,preset:'rea',enabled:true};
      else if (value.preset === undefined && typeof value.url === 'string') {
        let url; try { url = new URL(value.url); } catch { throw Error('HTTPS MCP 주소를 확인해 주세요.'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw Error('인증값 없는 HTTPS MCP 주소를 입력해 주세요.');
        config = {name:value.name,transport:'http',url:url.href,enabled:true};
      } else throw Error('준비된 REA 또는 HTTPS MCP 주소를 선택해 주세요.');
      if (!await approve('mcp-install','MCP 등록 및 연결',config)) throw Error('MCP 등록을 승인하지 않았습니다.');
      item = {config};
    }
    staged.push(item);
    return {name:value.name,status:'installed_pending_connection',message:'설치 승인을 확인했습니다. 현재 채팅 작업이 끝난 뒤 등록하고 실제 연결을 검사합니다. 아직 연결된 상태가 아닙니다.'};
  }
  async function manageSkills(value) {
    const allowed = {list:['action'],find:['action','query'],read:['action','name'],save:['action','name','description','body','expectedHash'],conversation:['action']};
    if (!keys(value,allowed[value?.action] ?? [])) throw Error('스킬 관리 입력을 확인해 주세요.');
    if (value.action === 'list') return {skills:await skills.list()};
    if (value.action === 'find') return {skills:await skills.find(value.query)};
    if (value.action === 'read') return skills.read(value.name);
    if (value.action === 'conversation') return {messages:await getConversation()};
    if (value.action !== 'save') throw Error('스킬 관리 입력을 확인해 주세요.');
    if (value.expectedHash !== undefined) {
      const previous = await skills.read(value.name);
      if (previous.hash !== value.expectedHash) throw Error('스킬이 변경되었습니다. 다시 읽어 주세요.');
      if (!await approve('skill-overwrite','기존 스킬 수정',{name:value.name,expectedHash:previous.hash,description:value.description,body:value.body})) throw Error('스킬 수정을 승인하지 않았습니다.');
    }
    check();
    const {action,...input} = value;
    const saved = await skills.save(input);
    return {...saved,command:`/${saved.name}`,message:`스킬을 저장했습니다. /${saved.name} 명령으로 실행할 수 있습니다.`};
  }
  return {
    async call(method,value) {
      check(); if (++calls>20) throw Error('한 채팅의 확장 관리 횟수를 초과했습니다.');
      const result = method === 'manage_mcp' ? await manageMcp(value) : method === 'manage_skills' ? await manageSkills(value) : (()=>{throw Error('관리 도구를 확인해 주세요.');})();
      check(); return result;
    },
    pending:()=>[...staged],
    complete() { staged=[]; },
    async discard() { const previous=staged; staged=[]; await Promise.all(previous.filter(item=>item.installation).map(item=>installer.remove(item.installation.id))); }
  };
}
