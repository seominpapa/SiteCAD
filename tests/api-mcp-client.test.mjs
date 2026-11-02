import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createApiMcpClient, boundedJson } from '../lib/api-mcp-client.mjs';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json','mcp-session-id':'session-test'}});
test('HTTP MCP initializes and lists/calls with an isolated session and bearer credential',async()=>{
  const calls=[];
  const client=createApiMcpClient({name:'test',transport:'http',url:'https://example.test/mcp',bearerToken:'private-token'}, {workspace:tmpdir(),fetchImpl:async(_url,init)=>{
    const request=JSON.parse(init.body);calls.push({request,init});
    if(!Object.hasOwn(request,'id'))return new Response(null,{status:202});
    const result=request.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}:request.method==='tools/list'?{tools:[{name:'read',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'ok'}]};
    return json({jsonrpc:'2.0',id:request.id,result});
  }});
  assert.equal((await client.start())[0].name,'read');
  assert.equal((await client.call('read',{})).content[0].text,'ok');
  assert.equal(calls.at(-1).init.headers['Mcp-Session-Id'],'session-test');
  assert.equal(calls[0].init.headers.Authorization,'Bearer private-token');
  assert.equal(calls[0].init.redirect,'error');await client.stop();
});
test('HTTP MCP parses bounded SSE responses and obeys enabled tool filtering',async()=>{
  const client=createApiMcpClient({name:'test',transport:'http',url:'https://example.test/mcp',enabledTools:['read']},{workspace:tmpdir(),fetchImpl:async(_url,init)=>{
    const r=JSON.parse(init.body);if(!Object.hasOwn(r,'id'))return new Response(null,{status:202});
    const result=r.method==='initialize'?{protocolVersion:'2025-06-18'}:{tools:[{name:'read',inputSchema:{type:'object'}},{name:'write',inputSchema:{type:'object'}}]};
    return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:r.id,result})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }});
  assert.deepEqual((await client.start()).map(x=>x.name),['read']);
  await assert.rejects(client.call('write',{}),/허용/);await client.stop();
});
test('stdio MCP uses the existing isolated launcher environment and closes its child',async()=>{
  const script=`process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(r.id){const result=r.method==='initialize'?{protocolVersion:'2025-06-18'}:r.method==='tools/list'?{tools:[{name:'read',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.ACCESS_TOKEN?'leak':'isolated'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}}});`;
  const client=createApiMcpClient({name:'test',transport:'stdio',command:process.execPath,args:['-e',script]}, {workspace:tmpdir()});
  try{assert.equal((await client.start())[0].name,'read');assert.equal((await client.call('read',{})).content[0].text,'isolated');}finally{await client.stop();}
});
test('an SSE RPC result resolves without waiting for the server to close its stream',async()=>{
  let streamController;
  const stream=new ReadableStream({start(controller){streamController=controller;controller.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'));}});
  let timer;
  try{
    const result=await Promise.race([boundedJson(new Response(stream,{headers:{'content-type':'text/event-stream'}})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSE kept waiting for close')),40);})]);
    assert.deepEqual(result.result,{});
  }finally{clearTimeout(timer);try{streamController.close();}catch{}}
});
