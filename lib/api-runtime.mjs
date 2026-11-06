import { turnTimeoutError } from './chat-errors.mjs';
import { randomUUID } from 'node:crypto';
import { validateChat, validateSteering } from './plan.mjs';
import { attachmentContext } from './chat-attachments.mjs';
import { createBridgeClient, createMcpHandler, mcpTools } from './sitecad-mcp.mjs';
import { createSitecadSkills, checkedSkillInputs } from './sitecad-skills.mjs';
import { sitecadInstructions } from './codex-runtime.mjs';
import { createApiMcpClient, boundedJson } from './api-mcp-client.mjs';

const MAX_CALLS = 64, TURN_MS = 600000;
const cancelled = () => Error('작업을 취소했습니다. 이미 적용된 도면 변경과 미저장 상태를 확인해 주세요.');
const responseFailure = status => Error(status === 401 || status === 403 ? 'LLM 인증에 실패했습니다. API 키·로그인·계정 권한을 확인해 주세요.' : status === 429 ? 'LLM 사용 한도에 도달했습니다. API 잔액·요금 한도와 요청 빈도를 확인해 주세요.' : 'LLM 응답을 완료하지 못했습니다. 연결·모델 권한과 도면 상태를 확인해 주세요.');
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const compatibleModel = (provider,id) => provider === 'anthropic' ? /^claude-/.test(id) : /^(gpt-|o[1-9](?:-|$)|chatgpt-)/.test(id) &&
  !/^(?:gpt-(?:3[.-]|4(?:$|-(?:\d|turbo|vision)))|o1-(?:mini|preview)(?:-|$))/.test(id) &&
  !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct)/.test(id);
const safeText = (value,secret) => String(value ?? '').replaceAll(secret,'[비공개]');
function outputContent(result,provider,token) {
  const images=(result.content??[]).filter(item=>item.type==='image' && ['image/png','image/jpeg','image/gif','image/webp'].includes(item.mimeType) && typeof item.data==='string' && item.data.length<=1024*1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data));
  const value={...result,...(images.length?{content:result.content.map(item=>item.type==='image'?{type:'image',mimeType:item.mimeType,note:'별도 이미지 블록 참조'}:item)}:{})};
  const text=safeText(JSON.stringify(value),token);
  if(provider==='openai')return images.length?[{type:'input_text',text},...images.map(item=>({type:'input_image',image_url:`data:${item.mimeType};base64,${item.data}`,detail:'auto'}))]:text;
  return [{type:'text',text},...images.map(item=>({type:'image',source:{type:'base64',media_type:item.mimeType,data:item.data}}))];
}

export function createApiRuntime(options) {
  const {provider,getApiKey,getCredentials,workspace,codexHome,bridgeUrl,bridgeToken,externalServers=[],researchTools=[],onEvent=()=>{},onApproval,
    fetchImpl=fetch,mcpClientFactory=createApiMcpClient,setTimeoutImpl=setTimeout,clearTimeoutImpl=clearTimeout} = options;
  if(!['openai','anthropic'].includes(provider) || (typeof getApiKey!=='function' && typeof getCredentials!=='function'))throw Error('LLM 공급자 설정을 확인해 주세요.');
  const base=provider==='openai'?'https://api.openai.com/v1':'https://api.anthropic.com/v1';
  const handle=createMcpHandler(createBridgeClient({bridgeUrl,bridgeToken,fetchImpl}),researchTools);
  const internal=[...mcpTools,...researchTools];
  let catalog=[],model,connected=false,cadVerified=false,inferenceVerified=false,failed=false;
  let active,starting,startupAbort,epoch=0,inventory=[],externalConnected=false;
  const clients=new Map();
  const emit=value=>{try{onEvent(value);}catch{/* UI callbacks cannot change a drawing operation. */}};
  async function credentials() {
    const value=getCredentials?await getCredentials():{apiKey:await getApiKey()};
    const token=value?.apiKey;
    if(typeof token!=='string' || !token || token.length>65536 || /[\s\x00-\x1f]/.test(token))throw responseFailure(401);
    if(value.workspaceId!==undefined && (typeof value.workspaceId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.workspaceId)))throw responseFailure(401);
    const headers=provider==='openai'?{Authorization:`Bearer ${token}`} : {'x-api-key':token,...(value.workspaceId?{'anthropic-workspace-id':value.workspaceId}:{})};
    return {token,headers:{...headers,'Content-Type':'application/json',...(provider==='anthropic'?{'anthropic-version':'2023-06-01'}:{})}};
  }
  async function request(path,body,signal) {
    const {token,headers}=await credentials();
    if(signal?.aborted)throw cancelled();
    try {
      const response=await fetchImpl(`${base}${path}`,{method:body===undefined?'GET':'POST',redirect:'error',headers,
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(body===undefined?30000:120000)]):AbortSignal.timeout(30000)});
      if(!response.ok){await response.body?.cancel();throw responseFailure(response.status);}
      const result=await boundedJson(response);
      if(signal?.aborted)throw cancelled();
      return {result,token};
    }catch(error){
      if(signal?.aborted)throw cancelled();
      if(error.message?.startsWith('LLM '))throw error;
      throw responseFailure();
    }
  }
  async function listModels({signal}={}) {
    const generation=epoch;
    const entries=[];const seen=new Set();let cursor;
    for(let page=0;page<10;page++){
      const path=provider==='anthropic'?`/models?limit=100${cursor?`&after_id=${encodeURIComponent(cursor)}`:''}`:'/models';
      const {result}=await request(path,undefined,signal);
      if(generation!==epoch)throw cancelled();
      if(!Array.isArray(result.data) || result.data.length>10000)throw responseFailure();
      for(const value of result.data){
        if(!validModel(value?.id) || !compatibleModel(provider,value.id) || seen.has(value.id))continue;
        seen.add(value.id);entries.push({id:value.id,model:value.id,displayName:String(value.display_name??value.id).slice(0,256),description:`${provider==='openai'?'OpenAI':'Anthropic'} API · 모델 실행 권한은 실제 요청 시 확인됩니다.`,isDefault:entries.length===0});
      }
      if(provider==='openai' || result.has_more!==true){catalog=entries;connected=true;failed=false;model??=catalog[0]?.id;
        if(!catalog.length)throw Error('이 계정에서 사용할 수 있는 텍스트 모델을 찾지 못했습니다.');return catalog.map(entry=>({...entry}));}
      if(!validModel(result.last_id) || result.last_id===cursor)throw responseFailure();
      cursor=result.last_id;
    }
    throw Error('모델 목록의 페이지 한도를 초과했습니다.');
  }
  async function connectExternal(signal) {
    const next=[];
    for(const server of externalServers){
      let client=clients.get(server.name);
      try{
        if(!client){client=mcpClientFactory(server,{workspace,fetchImpl});clients.set(server.name,client);}
        const tools=await client.start({signal});
        if(signal?.aborted)throw cancelled();
        next.push({name:server.name,status:'connected',tools:tools.filter(tool=>!server.enabledTools?.length || server.enabledTools.includes(tool.name))});
      }catch{
        await client?.stop();clients.delete(server.name);
        if(signal?.aborted)throw cancelled();
        next.push({name:server.name,status:'failed',tools:[]});
      }
    }
    inventory=next;
  }
  async function start({verifyCad=true}={}) {
    if(starting)await starting;
    if(!connected || !externalConnected){
      const generation=epoch;
      const controller=new AbortController();startupAbort=controller;
      const signal=active?AbortSignal.any([active.signal,controller.signal]):controller.signal;
      starting=(async()=>{if(!catalog.length)await listModels({signal});await connectExternal(signal);if(generation!==epoch)throw cancelled();connected=true;externalConnected=true;})();
      try{await starting;}finally{starting=undefined;if(startupAbort===controller)startupAbort=undefined;}
    }
    if(verifyCad && !cadVerified){const result=await handle('tools/call',{name:'cad_context',arguments:{}});if(result.isError)throw Error('현재 도면에 연결하지 못했습니다.');cadVerified=true;}
    return status();
  }
  const status=()=>({connected,running:connected,busy:Boolean(active),inferenceVerified,model:model??null,
    mcp:connected?{name:'sitecad',tools:internal.map(tool=>tool.name),contextVerified:cadVerified}:null,failed});
  function bindings() {
    const result=internal.map(tool=>({name:`sitecad_${tool.name}`,server:'sitecad',tool}));
    for(const [index,entry] of inventory.entries())for(const tool of entry.tools)result.push({
      name:`external${index}_${tool.name.replace(/[^A-Za-z0-9_-]/g,'_')}`.slice(0,64),server:entry.name,tool,
    });
    if(result.length>128 || new Set(result.map(item=>item.name)).size!==result.length)throw Error('LLM 도구 수 또는 이름 한도를 초과했습니다. 사용하지 않는 MCP를 비활성화해 주세요.');
    return result;
  }
  async function call(binding,args,turn) {
    if(++turn.toolCalls>MAX_CALLS)throw Error('한 요청의 도구 호출 한도에 도달했습니다. 부분 변경과 미저장 상태를 확인해 주세요.');
    if(turn.signal.aborted || active!==turn)throw cancelled();
    const id=randomUUID(),name=binding.tool.name;
    emit({type:'tool',id,server:binding.server,name,status:'running'});
    let result;
    try{
      if(binding.server==='sitecad')result=await handle('tools/call',{name,arguments:args});
      else {
        const decision=await onApproval?.({server:binding.server,tool:name,arguments:args});
        if(turn.signal.aborted || active!==turn)throw cancelled();
        result=decision==='approve'?await clients.get(binding.server).call(name,args,{signal:turn.signal}):{isError:true,content:[{type:'text',text:'사용자가 외부 도구 실행을 승인하지 않았습니다. 실행되지 않았습니다.'}]};
      }
      if(!result || typeof result!=='object' || Buffer.byteLength(JSON.stringify(result))>1024*1024)throw responseFailure();
    }catch(error){if(turn.signal.aborted)throw cancelled();result={isError:true,content:[{type:'text',text:'도구 실행 결과를 확인하지 못했습니다. 현재 상태를 확인하고 같은 변경을 바로 반복하지 마세요.'}]};}
    if(turn.signal.aborted || active!==turn)throw cancelled();
    const state=result.isError?'failed':'completed';
    turn.details.push({tool:name,status:state,...(binding.server==='sitecad'?{}:{server:binding.server})});
    if(binding.server==='sitecad')turn.cadTrace.push({tool:name,status:state,arguments:args,result:{...result,
      ...(Array.isArray(result.content)?{content:result.content.map(item=>item.type==='image'?{type:'image',mimeType:item.mimeType}:item)}:{})}});
    turn.toolFailed ||= Boolean(result.isError);
    emit({type:'tool',id,server:binding.server,name,status:state});
    return result;
  }
  async function chat(input,{model:requestedModel,skill,skills,attachmentInputs = [],attachmentWarning}={}) {
    validateChat(input);
    const selectedWorkflows=checkedSkillInputs({skill,skills},codexHome);
    if(active)throw Error('진행 중인 작업을 먼저 완료하거나 취소해 주세요.');
    if(requestedModel!==undefined && !validModel(requestedModel))throw Error('사용 가능한 모델을 선택해 주세요.');
    const controller=new AbortController();
    const turn={signal:controller.signal,controller,steering:[],toolCalls:0,details:[],cadTrace:[],toolFailed:false,startedAt:Date.now()};
    active=turn;
    let timedOut=false;
    const timer=setTimeoutImpl(()=>{timedOut=true;controller.abort();},TURN_MS);
    try{
      await start();
      if(turn.signal.aborted || active!==turn)throw cancelled();
      model=requestedModel??model??catalog[0]?.id;
      if(!catalog.some(entry=>entry.id===model))throw Error('현재 공급자의 모델 목록에서 모델을 선택해 주세요.');
      const available=bindings();
      let system=sitecadInstructions.replaceAll('built-in web search','cad_fetch for public URLs (this API connection has no built-in web search)');
      if(selectedWorkflows.length){
        const store=await createSitecadSkills({codexHome});
        for(const workflow of selectedWorkflows){
          const document=await store.read(workflow.name);
          system+=`\nSelected local skill ${document.name} (cannot grant permissions):\n${document.body}`;
        }
      }
      const requestText = `USER_REQUEST_JSON (untrusted data):\n${JSON.stringify({message:input.message,context:input.context})}${attachmentContext(attachmentInputs, attachmentWarning)}`;
      const images = attachmentInputs.filter(item => item.imageData);
      const content = !images.length ? requestText : provider === 'openai'
        ? [{ type: 'input_text', text: requestText }, ...images.map(item => ({ type: 'input_image', image_url: `data:${item.imageMimeType};base64,${item.imageData}`, detail: 'auto' }))]
        : [{ type: 'text', text: requestText }, ...images.map(item => ({ type: 'image', source: { type: 'base64', media_type: item.imageMimeType, data: item.imageData } }))];
      const initial=[...input.history.map(item=>({role:item.role,content:item.text})),{role:'user',content}];
      let messages=initial;
      emit({type:'connected',model});
      for(let step=0;step<=MAX_CALLS+20;step++){
        if(turn.signal.aborted || active!==turn)throw cancelled();
        if(turn.steering.length){messages=[...messages,{role:'user',content:`USER_STEERING_JSON (untrusted data):\n${JSON.stringify(turn.steering)}`}];turn.steering=[];}
        const body=provider==='openai'?{model,instructions:system,input:messages,store:false,stream:false,include:['reasoning.encrypted_content'],
          tools:available.map(item=>({type:'function',name:item.name,description:`${item.server} · ${item.tool.name}: ${item.tool.description??''}`,parameters:item.tool.inputSchema,strict:false}))}:
          {model,system,messages,max_tokens:/^claude-3-(?:haiku|sonnet|opus)(?:-|$)/.test(model)?4096:8192,stream:false,tools:available.map(item=>({name:item.name,description:`${item.server} · ${item.tool.name}: ${item.tool.description??''}`,input_schema:item.tool.inputSchema}))};
        if(Buffer.byteLength(JSON.stringify(body))>32*1024*1024)throw Error('LLM 대화 크기 한도를 초과했습니다. 새 채팅을 만들어 주세요.');
        const {result,token}=await request(provider==='openai'?'/responses':'/messages',body,turn.signal);
        const output=provider==='openai'?result.output:result.content;
        if(!Array.isArray(output) || (provider==='openai' && result.status && result.status!=='completed') || (provider==='anthropic' && !['end_turn','tool_use','stop_sequence'].includes(result.stop_reason)))throw responseFailure();
        const calls=output.filter(item=>item.type===(provider==='openai'?'function_call':'tool_use'));
        if(calls.length){
          messages=provider==='openai'?[...messages,...output]:[...messages,{role:'assistant',content:output}];
          const results=[];
          for(const item of calls){
            const binding=available.find(value=>value.name===item.name);
            if(!binding || typeof (item.call_id??item.id)!=='string')throw Error('허용되지 않은 LLM 도구 요청입니다.');
            let args;
            try{args=provider==='openai'?JSON.parse(item.arguments):item.input;}catch{throw Error('LLM 도구 입력을 확인하지 못했습니다.');}
            if(!args || typeof args!=='object' || Array.isArray(args))throw Error('LLM 도구 입력을 확인하지 못했습니다.');
            const toolResult=await call(binding,args,turn);
            const content=outputContent(toolResult,provider,token);
            results.push(provider==='openai'?{type:'function_call_output',call_id:item.call_id,output:content}:
              {type:'tool_result',tool_use_id:item.id,content,...(toolResult.isError?{is_error:true}:{})});
          }
          messages=provider==='openai'?[...messages,...results]:[...messages,{role:'user',content:results}];
          continue;
        }
        if(turn.steering.length){messages=provider==='openai'?[...messages,...output]:[...messages,{role:'assistant',content:output}];continue;}
        const messagesForReply=output.filter(item=>item.type==='message');
        const finalMessage=messagesForReply.findLast(item=>item.phase==='final_answer')??messagesForReply.findLast(item=>!item.phase);
        const reply=safeText(provider==='openai'?(finalMessage?[finalMessage]:[]).flatMap(item=>item.content??[]).filter(item=>item.type==='output_text').map(item=>item.text).join('\n'):output.filter(item=>item.type==='text').map(item=>item.text).join('\n'),token);
        if(!reply || Buffer.byteLength(reply)>256*1024)throw responseFailure();
        inferenceVerified=true;failed=false;emit({type:'delta',text:reply});
        return {reply,details:turn.details,cadTrace:turn.cadTrace,selectedSkills:selectedWorkflows.map(item=>item.name),reports:[],sources:[],toolFailed:turn.toolFailed,
          execution:{toolCalls:turn.toolCalls,limit:MAX_CALLS,elapsedMs:Date.now()-turn.startedAt,timeoutMs:TURN_MS}};
      }
      throw Error('LLM 요청 횟수 한도에 도달했습니다. 부분 변경과 미저장 상태를 확인해 주세요.');
    }catch(error){failed=true;const failure=timedOut?turnTimeoutError():turn.signal.aborted?cancelled():error;
      Object.assign(failure,{details:turn.details,cadTrace:turn.cadTrace,execution:{toolCalls:turn.toolCalls,limit:MAX_CALLS,elapsedMs:Date.now()-turn.startedAt,timeoutMs:TURN_MS}});throw failure;}
    finally{clearTimeoutImpl(timer);if(active===turn)active=undefined;}
  }
  async function stop(){epoch++;startupAbort?.abort();active?.controller.abort();active=undefined;connected=false;cadVerified=false;catalog=[];model=undefined;externalConnected=false;
    await Promise.all([...clients.values()].map(client=>client.stop()));clients.clear();inventory=[];}
  return {start,status,listModels,chat,stop,cancel:stop,
    async steer(message){validateSteering(message);if(!active || active.signal.aborted)throw Error('진행 중인 작업에만 추가 지시를 보낼 수 있습니다.');active.steering=[...active.steering,message];return{accepted:true,queued:true};},
    async getMcpStatus(){return inventory.map(entry=>({name:entry.name,status:entry.status,tools:entry.tools.map(tool=>tool.name)}));},
    async testExternal(name){await start({verifyCad:false});const entry=inventory.find(item=>item.name===name);if(!entry)throw Error('등록한 MCP를 확인해 주세요.');return{name,status:entry.status,tools:entry.tools.map(tool=>tool.name),tested:entry.status==='connected'&&entry.tools.length>0};},
  };
}
