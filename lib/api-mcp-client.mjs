import { spawn } from 'node:child_process';
import { launcherOptions, stopProcessTree } from './mcp-launcher.mjs';

const failure = () => Error('외부 MCP 연결·응답을 확인하지 못했습니다. 설정과 서버 상태를 확인해 주세요.');
export async function boundedJson(response, limit = 2 * 1024 * 1024, expectedId) {
  if (!response.body) throw failure();
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  const sse=(response.headers.get('content-type')??'').includes('text/event-stream');
  const decoder=new TextDecoder();let events='';
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw failure();
      chunks.push(value);
      if(sse){
        events+=decoder.decode(value,{stream:true});
        let separator;
        while((separator=/\r?\n\r?\n/.exec(events))){
          const event=events.slice(0,separator.index);events=events.slice(separator.index+separator[0].length);
          const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if(!data)continue;
          const result=JSON.parse(data);
          if((expectedId===undefined || result.id===expectedId) && (Object.hasOwn(result,'result') || result.error))return result;
        }
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (sse) {
      const messages = text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean);
      for (const message of messages.reverse()) {
        const value = JSON.parse(message);
        if ((expectedId===undefined || value.id===expectedId) && (Object.hasOwn(value,'result') || value.error)) return value;
      }
      throw failure();
    }
    return JSON.parse(text);
  } finally { await reader.cancel().catch(()=>{}); }
}

export function createApiMcpClient(server, {workspace, fetchImpl = fetch, spawnImpl = spawn} = {}) {
  let child, session, sequence = 0, closed = false, started, protocol='2025-06-18';
  let tools = [], buffer = '';
  const pending = new Map(), requests = new Set();
  const failAll = () => { for (const item of pending.values()) item.reject(failure()); pending.clear(); };
  const stop = async () => {
    if (closed) return;
    closed = true; failAll();
    for(const controller of requests)controller.abort();
    if (child) {
      stopProcessTree(child,'SIGTERM',{killGroup:process.platform!=='win32'});
      const timer=setTimeout(()=>stopProcessTree(child,'SIGKILL',{killGroup:process.platform!=='win32'}),2000);
      timer.unref();
      child.once('close',()=>clearTimeout(timer));
    }
  };
  function spawnServer() {
    const launch = launcherOptions({...server,cwd:workspace});
    child = spawnImpl(server.command,server.args ?? [],{...launch,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    child.on('error',failAll); child.on('close',()=>{closed=true;failAll();});
    // stderr is drained without exposing a third-party program's private diagnostics.
    child.stderr.on('data',()=>{});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer += chunk;
      if(Buffer.byteLength(buffer)>2*1024*1024){void stop();return;}
      let newline;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        if(!line.trim())continue;
        try {
          const message=JSON.parse(line);
          if(message.jsonrpc!=='2.0')throw failure();
          if(message.method){
            if(Object.hasOwn(message,'id'))child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client requests are unsupported'}})}\n`);
            continue;
          }
          const item=pending.get(message.id);
          if(item){pending.delete(message.id);message.error?item.reject(failure()):item.resolve(message.result);}
        }catch{void stop();return;}
      }
    });
  }
  async function request(method, params = {}, {signal,notification = false} = {}) {
    if(closed || signal?.aborted)throw failure();
    const id = ++sequence;
    const body = {jsonrpc:'2.0',...(notification?{}:{id}),method,params};
    const controller=new AbortController();
    requests.add(controller);
    const abort=()=>{controller.abort();if(server.transport==='stdio')void stop();};
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,120000);
    try {
      if(server.transport==='stdio'){
        if(notification){child.stdin.write(`${JSON.stringify(body)}\n`);return;}
        return await new Promise((resolve,reject)=>{
          pending.set(id,{resolve,reject});
          controller.signal.addEventListener('abort',()=>reject(failure()),{once:true});
          child.stdin.write(`${JSON.stringify(body)}\n`,error=>{if(error){pending.delete(id);reject(failure());}});
        });
      }
      if(server.transport!=='http')throw failure();
      const response=await fetchImpl(server.url,{method:'POST',redirect:'error',signal:controller.signal,headers:{
        'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        ...(server.bearerToken?{Authorization:`Bearer ${server.bearerToken}`} : {}),
        ...(session?{'Mcp-Session-Id':session}:{}),'MCP-Protocol-Version':protocol,
      },body:JSON.stringify(body)});
      if(!response.ok)throw failure();
      const nextSession=response.headers.get('mcp-session-id');
      if(nextSession){if(nextSession.length>256 || /[\r\n]/.test(nextSession))throw failure();session=nextSession;}
      if(notification){await response.body?.cancel();return;}
      const message=await boundedJson(response,2*1024*1024,id);
      if(message.id!==id || message.jsonrpc!=='2.0' || message.error || !Object.hasOwn(message,'result'))throw failure();
      return message.result;
    }catch{throw failure();}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);requests.delete(controller);}
  }
  const start = async ({signal} = {}) => {
    if(started)return started;
    started=(async()=>{
      if(server.transport==='stdio')spawnServer();
      else {
        const url=new URL(server.url);
        if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash)throw failure();
      }
      const initialized=await request('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'sitecad',version:'0.16.0'}},{signal});
      if(!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(initialized.protocolVersion))throw failure();
      protocol=initialized.protocolVersion;
      await request('notifications/initialized',{}, {signal,notification:true});
      let cursor;
      for(let page=0;page<10;page++){
        const result=await request('tools/list',cursor?{cursor}:{},{signal});
        if(!Array.isArray(result.tools))throw failure();
        for(const tool of result.tools){
          if(typeof tool.name!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) || !tool.inputSchema || tool.inputSchema.type!=='object')throw failure();
          if(server.enabledTools?.length && !server.enabledTools.includes(tool.name))continue;
          if(!tools.some(item=>item.name===tool.name))tools=[...tools,tool];
          if(tools.length>128)throw failure();
        }
        cursor=result.nextCursor;
        if(!cursor) return tools;
        if(typeof cursor!=='string' || cursor.length>2048)throw failure();
      }
      throw failure();
    })();
    try{return await started;}catch{await stop();throw failure();}
  };
  return {start,stop,async call(name,args,{signal}={}){
    if(!tools.some(tool=>tool.name===name))throw Error('허용되지 않은 MCP 도구입니다.');
    return request('tools/call',{name,arguments:args},{signal});
  }};
}
