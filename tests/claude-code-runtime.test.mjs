import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSitecadSkills } from '../lib/sitecad-skills.mjs';
import { createClaudeCodeRuntime } from '../lib/claude-code-runtime.mjs';
const input={message:'도면 확인해줘',context:{documentId:1,revision:0,units:4,selection:[],entities:[]},history:[]};
const models=[{value:'default',displayName:'Default',description:'CLI default'},{value:'opus[1m]',displayName:'Opus'}];
function fixture(onUser=async(p)=>p.send({type:'result',subtype:'success',is_error:false,result:'확인 완료'}),extra={}){
 const processes=[],events=[],bridge=[];
 const spawnImpl=(command,args,options)=>{
  const p=new EventEmitter();p.command=command;p.args=args;p.options=options;p.stdout=new PassThrough();p.stderr=new PassThrough();p.messages=[];
  p.send=v=>p.stdout.write(JSON.stringify(v)+'\n');p.exitCode=null;p.kill=()=>{p.exitCode=0;p.emit('close',0);};
  p.stdin=new Writable({write(chunk,_enc,done){for(const line of String(chunk).trim().split('\n')){const m=JSON.parse(line);p.messages.push(m);if(m.type==='control_request')queueMicrotask(()=>p.send({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:m.request.subtype==='initialize'?{models}:{}}}));if(m.type==='user')queueMicrotask(()=>onUser(p,m));}done();}});
  processes.push(p);return p;
 };
 const runtime=createClaudeCodeRuntime({workspace:'/tmp',codexHome:'/tmp',getClaudeCodeConfig:async()=>({claudePath:'/official/claude',claudeConfigDir:'/private/app/claude-code'}),spawnImpl,
  bridgeUrl:'http://127.0.0.1:1234',bridgeToken:'x'.repeat(32),onEvent:e=>events.push(e),fetchImpl:async(_url,init)=>{bridge.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,data:input.context}));},...extra});
 return{runtime,processes,events,bridge};
}
const wait=async(fn)=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,1));assert.ok(fn());};
const mcp=(p,id,name,args={})=>p.send({type:'control_request',request_id:id,request:{subtype:'mcp_message',server_name:'sitecad',message:{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}}});
test('official CLI catalog, isolation, vision and fresh conversations use native protocol',async()=>{
 const f=fixture();const list=await f.runtime.listModels();assert.deepEqual(list.map(x=>x.id),['default','opus[1m]']);assert.equal(f.processes[0].messages.some(m=>m.type==='user'),false);
 const result=await f.runtime.chat(input,{model:'opus[1m]',attachmentInputs:[{kind:'image',name:'a.png',imageData:'aW1hZ2U=',imageMimeType:'image/png'}]});
 assert.equal(result.reply,'확인 완료');const p=f.processes.at(-1),msg=p.messages.find(m=>m.type==='user');assert.equal(msg.message.content[1].type,'image');assert.equal(msg.message.content[1].source.media_type,'image/png');
 assert.ok(p.args.includes('--no-session-persistence'));assert.equal(p.args[p.args.indexOf('--tools')+1],'');assert.ok(p.args.includes('--setting-sources='));assert.equal(p.options.env.ANTHROPIC_API_KEY,undefined);assert.equal(p.options.env.CLAUDE_CONFIG_DIR,'/private/app/claude-code');
 await f.runtime.chat({...input,message:'새 채팅'});assert.notEqual(f.processes.at(-1),p);assert.equal(f.processes.at(-1).messages.filter(m=>m.type==='user').length,1);await f.runtime.stop();
});
test('SDK MCP invokes guarded SiteCAD tools and denies arbitrary builtin permission requests',async()=>{
 const f=fixture(async p=>{p.send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'arbitrary'}}});mcp(p,'call','sitecad_cad_context');await wait(()=>p.messages.some(m=>m.response?.request_id==='call'));p.send({type:'result',subtype:'success',result:'도면 확인'});});
 const result=await f.runtime.chat(input);const p=f.processes.at(-1);assert.equal(result.details[0].tool,'cad_context');assert.equal(result.cadTrace[0].result.structuredContent.documentId,1);assert.equal(p.messages.find(m=>m.response?.request_id==='permission').response.response.behavior,'deny');assert.equal(f.bridge.length,2);await f.runtime.stop();
});
test('every external MCP call retains approval and the official process never gets external credentials',async()=>{
 let calls=0,approvals=0;
 const f=fixture(async p=>{mcp(p,'external','external0_read');await wait(()=>p.messages.some(m=>m.response?.request_id==='external'));p.send({type:'result',subtype:'success',result:'승인 거절 확인'});},{externalServers:[{name:'remote',transport:'http',url:'https://example.test/mcp',token:TEST_EXTERNAL_CREDENTIAL}],onApproval:async()=>{approvals++;return'deny';},mcpClientFactory:()=>({start:async()=>[{name:'read',inputSchema:{type:'object'}}],call:async()=>{calls++;},stop:async()=>{}})});
 await f.runtime.chat(input);assert.equal(calls,0);assert.equal(approvals,1);assert.doesNotMatch(JSON.stringify({args:f.processes.at(-1).args,env:f.processes.at(-1).options.env}),/private-fixture-credential-123|example.test/);await f.runtime.stop();
});
test('cancel suppresses late results, timeout is explicit and malformed output is safe',async()=>{
 const f=fixture(()=>{});const pending=f.runtime.chat(input);const rejected=assert.rejects(pending,/취소/);await wait(()=>f.processes.some(p=>p.messages.some(m=>m.type==='user')));await f.runtime.cancel();await rejected;assert.equal(f.events.some(e=>e.type==='delta'),false);
 const slow=fixture(()=>{},{turnTimeoutMs:15});await assert.rejects(slow.runtime.chat(input),e=>e.code==='SITECAD_TURN_TIMEOUT');await slow.runtime.stop();
 const bad=fixture(p=>p.stdout.write('secret bad output\n'));await assert.rejects(bad.runtime.chat(input),e=>!e.message.includes('secret'));await bad.runtime.stop();
});
test('steering native messages wait for the last queued result',async()=>{
 let release;
 const f=fixture((p,m)=>{if(m.message.content[0].text.includes('USER_STEERING_JSON'))p.send({type:'result',subtype:'success',result:'수정 완료'});else release=()=>p.send({type:'result',subtype:'success',result:'초안'});});
 const pending=f.runtime.chat(input);await wait(()=>release);await f.runtime.steer('짧게 답해줘');release();const result=await pending;assert.equal(result.reply,'수정 완료');await f.runtime.stop();
});

const TEST_EXTERNAL_CREDENTIAL = 'private-fixture-credential-123';

test('deadline aborts slow external startup promptly, cleans clients and suppresses late startup success',async()=>{
 let startupSignal,stopped=0,finish;
 const f=fixture(()=>{},{turnTimeoutMs:20,externalServers:[{name:'slow'}],mcpClientFactory:()=>({start:({signal})=>{startupSignal=signal;return new Promise(resolve=>{finish=resolve;});},stop:async()=>{stopped++;}})});
 const running=f.runtime.chat(input);const rejected=assert.rejects(running,e=>e.code==='SITECAD_TURN_TIMEOUT');
 await wait(()=>startupSignal);await rejected;assert.equal(startupSignal.aborted,true);assert.equal(f.runtime.status().busy,false);finish([]);await new Promise(resolve=>setTimeout(resolve,1));assert.equal(f.runtime.status().connected,false);await f.runtime.stop();assert.ok(stopped>0);
});

test('selected skill bodies reach CLI instructions and only discovered models are accepted',async t=>{
 const codexHome=await mkdtemp(join(tmpdir(),'sitecad-claude-skills-'));t.after(()=>rm(codexHome,{recursive:true,force:true}));
 const store=await createSitecadSkills({codexHome});await store.seed();const document=await store.read('quantity-review');
 const f=fixture(undefined,{codexHome});await f.runtime.chat(input,{skills:[{name:document.name,path:document.path}]});
 const p=f.processes.at(-1);assert.ok(p.args[p.args.indexOf('--system-prompt')+1].includes(document.body));
 await assert.rejects(f.runtime.chat(input,{model:'unknown-model'}),/모델 목록/);await f.runtime.stop();
});
