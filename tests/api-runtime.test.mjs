import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRuntime } from '../lib/api-runtime.mjs';

const input = {message:'현재 도면을 확인해줘',context:{documentId:1,revision:0,units:4,selection:[],entities:[]},history:[]};
const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function fixture(provider, responses = [], extra = {}) {
  const calls=[], events=[], bridge=[];
  const runtime=createApiRuntime({provider,getApiKey:async()=>'secret-test-key',workspace:'/tmp',codexHome:'/tmp',nodePath:process.execPath,
    bridgeUrl:'http://127.0.0.1:1234',bridgeToken:'x'.repeat(32),onEvent:event=>events.push(event),
    fetchImpl:async(url,init={})=>{
      calls.push({url,init,body:init.body?JSON.parse(init.body):undefined});
      if(url.startsWith('http://127.0.0.1:1234')) { bridge.push(JSON.parse(init.body));return json({ok:true,data:input.context}); }
      if(url.includes('/models'))return json({data:[{id:provider==='openai'?'gpt-test':'claude-test',display_name:'테스트 모델'}],has_more:false});
      const next=responses.shift();return typeof next==='function'?next(url,init):json(next);
    },...extra});
  return {runtime,calls,events,bridge};
}
test('OpenAI Responses runs real guarded internal tools and returns their result to the provider',async()=>{
  const f=fixture('openai',[{output:[{type:'function_call',call_id:'c1',name:'sitecad_cad_context',arguments:'{}'}]},
    {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'도면 확인 완료'}]}]}]);
  const result=await f.runtime.chat(input);
  const requests=f.calls.filter(x=>x.url.endsWith('/responses'));
  assert.equal(requests[0].init.headers.Authorization,'Bearer secret-test-key');
  assert.equal(requests[0].body.store,false);
  assert.equal(requests[1].body.input.at(-1).type,'function_call_output');
  assert.equal(JSON.parse(requests[1].body.input.at(-1).output).structuredContent.documentId,1);
  assert.equal(result.reply,'도면 확인 완료');
  assert.equal(f.bridge.length,2);
  assert.deepEqual(f.events.filter(x=>x.type==='tool').map(x=>x.status),['running','completed']);
});
test('Anthropic Messages uses OAuth bearer credentials, workspace and tool-result blocks',async()=>{
  const f=fixture('anthropic',[{stop_reason:'tool_use',content:[{type:'tool_use',id:'c1',name:'sitecad_cad_context',input:{}}]},
    {stop_reason:'end_turn',content:[{type:'text',text:'Claude 확인 완료'}]}],
    {getCredentials:async()=>({accessToken:'oauth-test-token',workspaceId:'workspace-test'})});
  const result=await f.runtime.chat(input);
  const requests=f.calls.filter(x=>x.url.endsWith('/messages'));
  assert.equal(requests[0].init.headers.Authorization,'Bearer oauth-test-token');
  assert.equal(requests[0].init.headers['anthropic-workspace-id'],'workspace-test');
  assert.equal(requests[0].init.headers['x-api-key'],undefined);
  assert.equal(requests[0].body.max_tokens,8192);
  assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id,'c1');
  assert.equal(result.reply,'Claude 확인 완료');
});
test('model-list tests use no inference and restrict compatible text models',async()=>{
  const f=fixture('openai');
  const list=await f.runtime.listModels();
  assert.equal(list[0].id,'gpt-test');
  assert.equal(list[0].model,'gpt-test');
  assert.equal(f.bridge.length,0);
  assert.equal(f.calls.length,1);
  assert.equal(f.runtime.status().inferenceVerified,false);
});
test('legacy GPT and early o1 models cannot become the Responses tool-runtime default',async()=>{
  const ids=['gpt-3.5-turbo','gpt-3.5-turbo-0125','gpt-4','gpt-4-0613','gpt-4-32k','gpt-4-turbo','gpt-4-1106-preview','o1-mini','o1-mini-2024-09-12','o1-preview','o1-preview-2024-09-12','gpt-4.1','gpt-4o-mini','gpt-5.1'];
  const f=fixture('openai',[],{fetchImpl:async()=>json({data:ids.map(id=>({id}))})});
  const models=await f.runtime.listModels();
  assert.deepEqual(models.map(item=>item.id),['gpt-4.1','gpt-4o-mini','gpt-5.1']);
  assert.equal(models.find(item=>item.isDefault).id,'gpt-4.1');
  assert.equal(f.runtime.status().model,'gpt-4.1');
});
test('failed API responses never expose provider secrets or response bodies',async()=>{
  const f=fixture('anthropic',[()=>new Response('secret-test-key private traceback',{status:401})]);
  await assert.rejects(f.runtime.chat(input),error=>/인증|키/.test(error.message)&&!error.message.includes('secret-test-key'));
  assert.equal(JSON.stringify(f.events).includes('secret-test-key'),false);
});
test('cancel aborts an active request and suppresses late successful output',async()=>{
  let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const f=fixture('openai',[(_url,init)=>new Promise((_resolve,reject)=>{entered();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});})]);
  const running=f.runtime.chat(input);
  const rejected=assert.rejects(running,/취소|중지/);
  await ready;await f.runtime.cancel();await rejected;
  assert.equal(f.events.some(x=>x.type==='delta'),false);
  assert.equal(f.runtime.status().connected,false);
});
test('steering queues only for the active turn and is included before the next request',async()=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=fixture('anthropic',[()=>{entered();return new Promise(resolve=>{release=()=>resolve(json({stop_reason:'end_turn',content:[{type:'text',text:'초안'}]}));});},
    {stop_reason:'end_turn',content:[{type:'text',text:'3줄 최종 답변'}]}]);
  await assert.rejects(f.runtime.steer('3줄로 답해줘'),/진행/);
  const running=f.runtime.chat(input);await ready;
  await f.runtime.steer('3줄로 답해줘');release();
  const result=await running;
  const requests=f.calls.filter(x=>x.url.endsWith('/messages'));
  assert.match(JSON.stringify(requests[1].body.messages),/3줄로 답해줘/);
  assert.equal(result.reply,'3줄 최종 답변');
});
test('every external call requires approval and refusal never invokes its client',async()=>{
  let called=0;
  const f=fixture('anthropic',[{stop_reason:'tool_use',content:[{type:'tool_use',id:'c1',name:'external0_read',input:{}}]},
    {stop_reason:'end_turn',content:[{type:'text',text:'사용자가 거절했습니다.'}]}],{
    externalServers:[{name:'remote',transport:'http',url:'https://example.test/mcp',enabledTools:['read']}],
    onApproval:async item=>{assert.equal(item.server,'remote');return 'deny';},
    mcpClientFactory:()=>({start:async()=>[{name:'read',inputSchema:{type:'object'}}],call:async()=>{called++;},stop:async()=>{}})});
  const result=await f.runtime.chat(input);
  assert.equal(called,0);assert.equal(result.reply,'사용자가 거절했습니다.');
});
test('external approval is checked again on repeated calls and tool output errors fail the turn',async()=>{
  let approvals=0,calls=0;
  const f=fixture('openai',[{output:[{type:'function_call',call_id:'c1',name:'external0_read',arguments:'{}'},{type:'function_call',call_id:'c2',name:'external0_read',arguments:'{}'}]},
    {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'완료'}]}]}],{
    externalServers:[{name:'remote',transport:'http',url:'https://example.test/mcp'}],onApproval:async()=>{approvals++;return 'approve';},
    mcpClientFactory:()=>({start:async()=>[{name:'read',inputSchema:{type:'object'}}],call:async()=>{calls++;return{content:[{type:'text',text:'확인'}]};},stop:async()=>{}})});
  await f.runtime.chat(input);assert.equal(approvals,2);assert.equal(calls,2);
});
test('Anthropic API keys are sent only to the official API endpoint using x-api-key',async()=>{
  const f=fixture('anthropic',[{stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}]);
  await f.runtime.chat(input);
  const call=f.calls.find(item=>item.url.endsWith('/messages'));
  assert.equal(call.init.headers['x-api-key'],'secret-test-key');assert.equal(call.init.headers.Authorization,undefined);
  assert.equal(call.init.redirect,'error');
});
test('legacy Claude 3 output budgets stay within their 4096-token limit',async()=>{
  let sent;
  const f=fixture('anthropic',[],{fetchImpl:async(url,init)=>{
    if(url.startsWith('http://127.0.0.1:'))return json({ok:true,data:input.context});
    if(url.includes('/models'))return json({data:[{id:'claude-3-haiku-20240307'}],has_more:false});
    sent=JSON.parse(init.body);return json({stop_reason:'end_turn',content:[{type:'text',text:'완료'}]});
  }});
  await f.runtime.chat(input);assert.equal(sent.max_tokens,4096);
});
test('a separate model-list refresh does not skip later external MCP connections',async()=>{
  let connected=0;
  const f=fixture('openai',[],{externalServers:[{name:'remote',transport:'http',url:'https://example.test/mcp'}],
    mcpClientFactory:()=>({start:async()=>{connected++;return[{name:'read',inputSchema:{type:'object'}}];},stop:async()=>{}})});
  await f.runtime.listModels();await f.runtime.start({verifyCad:false});
  assert.equal(connected,1);assert.equal((await f.runtime.getMcpStatus())[0].status,'connected');
});
test('startup cancellation aborts model discovery without accepting stale results',async()=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=fixture('openai',[],{fetchImpl:async(_url,init)=>new Promise((_resolve,reject)=>{entered();init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
  const opening=f.runtime.start({verifyCad:false});const rejected=assert.rejects(opening,/취소/);
  await ready;await f.runtime.stop();await rejected;assert.equal(f.runtime.status().connected,false);
});
test('Anthropic model pagination retrieves actual later pages and rejects repetition',async()=>{
  const requests=[];
  const f=fixture('anthropic',[],{fetchImpl:async(url)=>{requests.push(url);return json(requests.length===1?{data:[{id:'claude-first'}],has_more:true,last_id:'claude-first'}:{data:[{id:'claude-second'}],has_more:false});}});
  assert.deepEqual((await f.runtime.listModels()).map(x=>x.id),['claude-first','claude-second']);
  assert.match(requests[1],/after_id=claude-first/);
  const repeated=fixture('anthropic',[],{fetchImpl:async()=>json({data:[{id:'claude-first'}],has_more:true,last_id:'claude-first'})});
  await assert.rejects(repeated.runtime.listModels(),/응답/);
});
test('external images are passed as actual Anthropic image blocks instead of base64 prose',async()=>{
  const f=fixture('anthropic',[{stop_reason:'tool_use',content:[{type:'tool_use',id:'c1',name:'external0_formula',input:{}}]},
    {stop_reason:'end_turn',content:[{type:'text',text:'수식 확인'}]}],{
    externalServers:[{name:'remote',transport:'http',url:'https://example.test/mcp'}],onApproval:async()=>'approve',
    mcpClientFactory:()=>({start:async()=>[{name:'formula',inputSchema:{type:'object'}}],call:async()=>({content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]}),stop:async()=>{}})});
  await f.runtime.chat(input);
  const result=f.calls.filter(x=>x.url.endsWith('/messages'))[1].body.messages.at(-1).content[0];
  assert.equal(result.content[1].type,'image');assert.equal(result.content[1].source.data,'aGVsbG8=');
  assert.equal(result.content[0].text.includes('aGVsbG8='),false);
});
test('unknown model tool calls are rejected before reaching any tool',async()=>{
  const f=fixture('openai',[{output:[{type:'function_call',call_id:'c1',name:'not_allowed',arguments:'{}'}]}]);
  await assert.rejects(f.runtime.chat(input),/허용되지/);
  assert.equal(f.events.some(item=>item.type==='tool'),false);
});
