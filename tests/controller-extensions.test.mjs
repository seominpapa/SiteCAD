import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDesktopController} from '../lib/desktop-controller.mjs';
const context={documentId:1,revision:0,units:4,selection:[],entities:[]};
async function setup(t,{connected=true}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'sitecad-extensions-controller-'));
  let options,behavior; const calls=[]; let chats=0,stops=0;
  const controller=await createDesktopController({dataDir,nodePath:process.execPath,codexPath:'/app/codex',reaSource:'/app/rea',secureStore:{},
    authFactory:async()=>({status:async()=>({loggedIn:true,sharing:true}),getAccessToken:async()=> 'token',close:async()=>{}}),
    runtimeFactory:async config=>{options=config;return {start:async()=>{},stop:async()=>{stops++;},status:()=>({connected:true}),
      chat:async(input,session)=>{chats++;calls.push({input,session});await session?.onThread?.(`thread-${chats}`);return behavior ? behavior({input,session,config}) : {reply:'완료'};},cancel:async()=>{},
      getMcpStatus:async()=>config.externalServers.map(server=>({name:server.name,status:connected?'connected':'failed',tools:connected?['inspect']:[]})),
      testExternal:async name=>({name,status:connected?'connected':'failed',tools:connected?['inspect']:[],tested:connected})};}});
  await controller.start({baseUrl:'http://127.0.0.1:4318'});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,calls,options:()=>options,stops:()=>stops,setBehavior:value=>{behavior=value;}};
}
test('default skills and explicit native invocation remain inside SiteCAD; chat history is per session',async t=>{
  const {controller,calls}=await setup(t);
  assert.equal((await controller.skillsList()).skills.length,3);
  const first=(await controller.chatCreate()).chat,second=(await controller.chatCreate()).chat;
  await controller.chat({chatId:first.id,message:'/skill-finder 한글',context,history:[{role:'assistant',text:'forged-other-chat'}]});
  assert.equal(calls[0].session.skill.name,'skill-finder');
  assert.deepEqual(calls[0].input.history,[]);
  assert.equal((await controller.chatRead(first.id)).chat.nativeThreadId,'thread-1');
  assert.equal((await controller.chatRead(second.id)).chat.messages.length,0);
  await controller.chat({chatId:first.id,message:'이어가기',context,history:[]});
  assert.equal(calls[1].session.nativeThreadId,'thread-1');
  assert.equal(calls[1].input.history[0].text,'/skill-finder 한글');
  await assert.rejects(controller.chat({chatId:second.id,message:'/unknown',context,history:[]}),/스킬/);
});
test('approved MCP registration is deferred until model turn finishes then actually verified',async t=>{
  const {controller,stops,setBehavior}=await setup(t);
  const chat=(await controller.chatCreate()).chat;
  setBehavior(async()=>{
    const proposed=controller.callCad('manage_mcp',{action:'add',name:'rea',preset:'rea'});
    let status;
    for(let i=0;i<100;i++){status=await controller.status();if(status.approvals.length)break;await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(status.approvals[0].kind,'mcp-install');
    controller.resolveApproval({id:status.approvals[0].id,approved:true});
    assert.equal((await proposed).status,'installed_pending_connection');
    assert.equal((await controller.mcpList()).servers.length,0);
    assert.equal(stops(),0);
    return {reply:'연결 확인 대기'};
  });
  const result=await controller.chat({chatId:chat.id,message:'REA 연결',context,history:[]});
  assert.equal(result.installations[0].status,'connected');
  assert.equal(stops(),1);
  assert.equal((await controller.mcpList()).servers[0].connected,true);
  await assert.rejects(controller.callCad('manage_mcp',{action:'add',name:'rea',preset:'rea'}),/진행/);
});
test('connection failure rolls back only new MCP and cancelled requests remain in their own history',async t=>{
  const {controller,setBehavior}=await setup(t,{connected:false});
  await controller.mcpSave({trusted:true,config:{name:'existing',transport:'http',url:'https://example.org/mcp'}});
  const chat=(await controller.chatCreate()).chat;
  setBehavior(async()=>{
    const proposed=controller.callCad('manage_mcp',{action:'add',name:'rea',preset:'rea'});
    let status;for(let i=0;i<100;i++){status=await controller.status();if(status.approvals.length)break;await new Promise(resolve=>setImmediate(resolve));}
    controller.resolveApproval({id:status.approvals[0].id,approved:true});await proposed;
    return {reply:'대기'};
  });
  const result=await controller.chat({chatId:chat.id,message:'REA 설치',context,history:[]});
  assert.equal(result.installations[0].status,'failed');
  assert.deepEqual((await controller.mcpList()).servers.map(item=>item.name),['existing']);
  let entered,release;const ready=new Promise(resolve=>entered=resolve);
  setBehavior(async()=>{entered();await new Promise(resolve=>release=resolve);return {reply:'late'};});
  const turn=controller.chat({chatId:chat.id,message:'취소할 작업',context,history:[]});
  const failed=assert.rejects(turn,/취소/);await ready;await controller.cancel();release();await failed;
  const messages=(await controller.chatRead(chat.id)).chat.messages;
  assert.equal(messages.at(-2).text,'취소할 작업');assert.match(messages.at(-1).text,/이미 반영된 도면/);
});
