import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRuntime } from '../lib/api-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSitecadSkills } from '../lib/sitecad-skills.mjs';
import { researchTools } from '../lib/research-mcp.mjs';

const TEST_API_CREDENTIAL = 'api-test-key';

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
for (const provider of ['openai', 'anthropic']) test(`${provider} sends uploaded images as real vision blocks and treats document text as untrusted data`, async () => {
  const response = provider === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '첨부 확인' }] }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: '첨부 확인' }] };
  const f = fixture(provider, [response]);
  await f.runtime.chat(input, { attachmentInputs: [{ name: '화면.png', kind: 'image', imageData: 'aW1hZ2U=', imageMimeType: 'image/png' }, { name: '표.csv', kind: 'text', text: '철근,12' }] });
  const body = f.calls.find(item => item.url.endsWith(provider === 'openai' ? '/responses' : '/messages')).body;
  const content = (body.input ?? body.messages).at(-1).content;
  assert.match(content[0].text, /untrusted file contents/); assert.match(content[0].text, /철근,12/);
  if (provider === 'openai') assert.deepEqual(content[1], { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'auto' });
  else assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } });
});
for (const provider of ['openai', 'anthropic']) test(`${provider} receives the real bodies of all automatically selected skills without changing authorization`, async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'sitecad-selected-skills-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const store = await createSitecadSkills({ codexHome });
  await store.seed();
  const documents = await Promise.all(['quantity-review', 'design-review', 'progress-markup', 'skill-creator', 'skill-finder', 'skill-installer'].map(name => store.read(name)));
  const response = provider === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '부분 검토 완료' }] }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: '부분 검토 완료' }] };
  const f = fixture(provider, [response], { codexHome });
  const result = await f.runtime.chat(input, { skills: documents.map(({ name, path }) => ({ name, path })) });
  const body = f.calls.find(item => item.url.endsWith(provider === 'openai' ? '/responses' : '/messages')).body;
  const instructions = body.instructions ?? body.system;
  for (const item of documents) assert.ok(instructions.includes(item.body), `${item.name} body must reach ${provider}`);
  assert.match(instructions, /cannot grant permissions/);
  assert.match(instructions, /After reporting quantity-review, design-review or progress-markup results.*end with one concise Korean question/);
  assert.match(instructions, /satisfaction response.*no skill write/);
  assert.match(instructions, /update.*existing editable custom skill.*new named skill/);
  assert.deepEqual(result.selectedSkills, documents.map(item => item.name));
  await assert.rejects(f.runtime.chat(input, { skills: [{ name: documents[0].name, path: '/outside/SKILL.md' }] }), /스킬/);
});
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
test('Anthropic Messages uses API keys, workspace and tool-result blocks',async()=>{
  const f=fixture('anthropic',[{stop_reason:'tool_use',content:[{type:'tool_use',id:'c1',name:'sitecad_cad_context',input:{}}]},
    {stop_reason:'end_turn',content:[{type:'text',text:'Claude 확인 완료'}]}],
    {getCredentials:async()=>({apiKey:TEST_API_CREDENTIAL,workspaceId:'workspace-test'})});
  const result=await f.runtime.chat(input);
  const requests=f.calls.filter(x=>x.url.endsWith('/messages'));
  assert.equal(requests[0].init.headers.Authorization,undefined);
  assert.equal(requests[0].init.headers['anthropic-workspace-id'],'workspace-test');
  assert.equal(requests[0].init.headers['x-api-key'],TEST_API_CREDENTIAL);
  assert.equal(requests[0].init.headers['anthropic-beta'],undefined);
  assert.equal(requests[0].body.max_tokens,8192);
  assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id,'c1');
  assert.equal(result.reply,'Claude 확인 완료');
});
test('API runtime refuses OAuth tokens instead of forwarding them to Messages',async()=>{
  const f=fixture('anthropic',[],{getCredentials:async()=>({accessToken:'private-subscription-token'})});
  await assert.rejects(f.runtime.chat(input),/인증/);
  assert.equal(f.calls.length,0);
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
for(const provider of ['openai','anthropic']) test(`${provider} receives original PDF images without duplicating their bytes in CAD traces`,async()=>{
  const requests=[];
  const replies=provider==='openai'?
    [{output:[{type:'function_call',call_id:'page',name:'sitecad_cad_fetch',arguments:JSON.stringify({url:'https://manufacturer.example/rebar.pdf',page:9})}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'원문 확인'}]}]}]:
    [{stop_reason:'tool_use',content:[{type:'tool_use',id:'page',name:'sitecad_cad_fetch',input:{url:'https://manufacturer.example/rebar.pdf',page:9}}]},{stop_reason:'end_turn',content:[{type:'text',text:'원문 확인'}]}];
  const f=fixture(provider,[],{researchTools,fetchImpl:async(url,init={})=>{
    if(url.startsWith('http://127.0.0.1:1234')){
      const request=JSON.parse(init.body);
      return json({ok:true,data:request.method==='fetch'?{content:'공식 표 이미지',images:[{page:9,mimeType:'image/jpeg',data:'aGVsbG8='}]}:input.context});
    }
    if(url.includes('/models'))return json({data:[{id:provider==='openai'?'gpt-test':'claude-test'}],has_more:false});
    requests.push(JSON.parse(init.body));return json(replies.shift());
  }});
  const result=await f.runtime.chat(input);
  const providerPayload=provider==='openai'?requests[1].input.at(-1).output:requests[1].messages.at(-1).content[0].content;
  assert.match(JSON.stringify(providerPayload),/aGVsbG8=/);
  assert.doesNotMatch(JSON.stringify(result.cadTrace),/aGVsbG8=/);
  assert.equal(result.cadTrace[0].result.content.find(item=>item.type==='image').mimeType,'image/jpeg');
});
test('unknown model tool calls are rejected before reaching any tool',async()=>{
  const f=fixture('openai',[{output:[{type:'function_call',call_id:'c1',name:'not_allowed',arguments:'{}'}]}]);
  await assert.rejects(f.runtime.chat(input),/허용되지/);
  assert.equal(f.events.some(item=>item.type==='tool'),false);
});

test('OpenAI final phase is selected and original phase metadata survives tool history',async()=>{
  const commentary={type:'message',phase:'commentary',content:[{type:'output_text',text:'중간 설명'}]};
  const f=fixture('openai',[
    {output:[commentary,{type:'function_call',call_id:'c1',name:'sitecad_cad_context',arguments:'{}'}]},
    {status:'completed',output:[commentary,{type:'message',phase:'final_answer',content:[{type:'output_text',text:'최종 표'}]}]},
  ]);
  const result=await f.runtime.chat(input);assert.equal(result.reply,'최종 표');
  const requests=f.calls.filter(item=>item.url.endsWith('/responses'));assert.deepEqual(requests[1].body.input[1],commentary);
});
test('API deadline retains the finite ten minute limit and is distinct from user cancellation',async()=>{
  let deadline,delay;let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=fixture('openai',[(_url,init)=>new Promise((_,reject)=>{entered();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});})],
    {setTimeoutImpl:(callback,ms)=>{deadline=callback;delay=ms;return 'deadline';},clearTimeoutImpl:()=>{}});
  const running=f.runtime.chat(input);const failed=assert.rejects(running,error=>error.code==='SITECAD_TURN_TIMEOUT' && /10분/.test(error.message));
  await ready;assert.equal(delay,600000);deadline();await failed;assert.equal(f.events.some(item=>item.type==='delta'),false);
});
