import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createAgentUtilities } from '../lib/agent-utilities.mjs';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body, type = 'application/pdf', status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': type, ...headers } });
async function setup(t, request, resolve = lookup) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-utilities-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, ...createAgentUtilities({ dataDir, request, lookup: resolve }) };
}

test('downloads original bytes privately with provenance and never overwrites', async t => {
  const bytes = Buffer.from('%PDF-1.7\noriginal drawing');
  const service = await setup(t, async (url, options) => {
    assert.equal(url.href, 'https://drawings.example/a.pdf');
    assert.equal(options.address, '93.184.216.34');
    assert.equal(options.family, 4);
    assert.ok(options.signal instanceof AbortSignal);
    return response(bytes);
  });
  const first = await service.download({ url: 'https://drawings.example/a.pdf#private', name: '표준도.pdf' });
  const second = await service.download({ url: 'https://drawings.example/a.pdf', name: '표준도.pdf' });
  assert.notEqual(first.path, second.path);
  assert.equal(first.name, '표준도.pdf');
  assert.equal(first.bytes, bytes.length);
  assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.untrusted, true);
  assert.deepEqual(await readFile(first.path), bytes);
  assert.ok(first.path.startsWith(join(service.dataDir, 'downloads') + '/'));
});

test('accepts supported signatures and gives MIME-based extensions to endpoint URLs', async t => {
  for (const [body, type, extension] of [
    ['AC1032drawing', 'application/octet-stream', 'dwg'],
    ['0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n', 'application/dxf', 'dxf'],
    [Buffer.from([80,75,3,4,0,0,0,0]), 'application/zip', 'zip'],
    ['{"type":"FeatureCollection","features":[]}', 'application/geo+json', 'geojson'],
    ['{"height":3}', 'application/json', 'json'],
    ['layer,count\nA,2', 'text/csv', 'csv'], ['기준 높이 3m', 'text/plain', 'txt'],
  ]) {
    const service = await setup(t, async () => response(body, type));
    const result = await service.download({ url: `https://drawings.example/${extension === 'dwg' ? 'a.dwg' : 'download'}` });
    assert.ok(result.name.endsWith('.' + extension));
  }
});

test('rejects unsafe URLs and credential-bearing queries before DNS or transport', async t => {
  const service = await setup(t, () => assert.fail('network'), () => assert.fail('DNS'));
  for (const url of ['', null, 42, 'https://x.example/' + 'a'.repeat(4096), 'http://a.example/a.pdf', 'https://u:p@a.example/a.pdf', 'https://127.0.0.1/a.pdf', 'https://localhost/a.pdf', 'https://a.internal/a.pdf', 'https://a.example:8443/a.pdf', 'https://a.example/a.pdf?api_key=SECRET', 'https://a.example/a.pdf?X-Amz-Signature=SECRET', 'https://a.example/a.pdf?accessToken=SECRET']) {
    await assert.rejects(service.download({ url }), /HTTPS|인증/);
  }
});

test('rejects all private DNS answers and rechecks every redirect hop', async t => {
  for (const address of ['10.1.2.3','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.2','100.64.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','2001:db8::1']) {
    const service = await setup(t, () => assert.fail('network'), async () => [...await lookup(), { address, family: 4 }]);
    await assert.rejects(service.download({ url: 'https://a.example/a.pdf' }), /공개 주소/);
  }
  let calls = 0;
  const service = await setup(t, async () => ++calls === 1 ? response(null, 'text/plain', 302, { location: 'https://other.example/a.pdf' }) : response('%PDF-1.7\nhi'), async host => host === 'other.example' ? [{ address:'127.0.0.1', family:4 }] : lookup());
  await assert.rejects(service.download({ url: 'https://a.example/a.pdf' }), /공개 주소/);
  assert.equal(calls, 1);
});

test('redirects remain bounded and final URL is recorded', async t => {
  let calls = 0;
  const service = await setup(t, async () => ++calls === 1 ? response(null, 'text/plain', 302, { location: '/final.pdf' }) : response('%PDF-1.7\nhi'));
  assert.equal((await service.download({ url:'https://a.example/a.pdf' })).url, 'https://a.example/final.pdf');
  const loop = await setup(t, async () => response(null,'text/plain',302,{location:'/loop'}));
  await assert.rejects(loop.download({url:'https://a.example/a.pdf'}), /이동 횟수/);
});

test('rejects spoofed files, executable extensions, unsafe names and HTML login responses', async t => {
  for (const [url,body,type,name] of [
    ['a.dwg','<html>login</html>','application/octet-stream'], ['a.zip','login required','application/zip'],
    ['a.dwg','%PDF-1.7','application/octet-stream'], ['a.exe','MZ','application/octet-stream'],
    ['a.pdf','%PDF-1.7','application/pdf','../escape.pdf'], ['a.pdf','%PDF-1.7','application/pdf','wrong.dwg'],
    ['a.txt','<!DOCTYPE html><html>login</html>','text/plain'], ['a.json','not-json','application/json'],
    ['a.geojson','{"error":"login"}','application/geo+json'], ['a.txt','\u0000binary','text/plain'],
  ]) {
    const service = await setup(t, async () => response(body,type));
    await assert.rejects(service.download({url:'https://a.example/'+url,...(name?{name}:{})}));
    assert.deepEqual(await readdir(join(service.dataDir,'downloads')).catch(() => []), []);
  }
});

test('bounds declared and streamed bytes and cleans partial files', async t => {
  for (const result of [response('%PDF-', 'application/pdf', 200, {'content-length':String(32*1024*1024+1)}), response(Buffer.alloc(32*1024*1024+1,65),'text/plain')]) {
    const service = await setup(t, async () => result);
    await assert.rejects(service.download({url:'https://a.example/a.txt'}), /32MB/);
    assert.deepEqual(await readdir(join(service.dataDir,'downloads')).catch(()=>[]), []);
  }
});

test('fails closed on cancellation, network errors, bad statuses and compression without leaking details', async t => {
  for (const request of [async()=>{throw new Error('SECRET');}, async()=>response('no','text/plain',403), async()=>response('%PDF-','application/pdf',200,{'content-encoding':'gzip'}), async()=>response('','text/plain')]) {
    const service = await setup(t,request);
    await assert.rejects(service.download({url:'https://a.example/a.pdf'}), e=>!e.message.includes('SECRET'));
  }
  const service = await setup(t,()=>assert.fail('network'));
  await assert.rejects(service.download({url:'https://a.example/a.pdf'}, {signal:AbortSignal.abort()}));
});

test('native transport pins checked IP with TLS and sends no cookies or authorization', async t => {
  const stub = t.mock.method(https,'request',(url,options,respond) => {
    assert.equal(url.hostname,'a.example');
    assert.equal(options.servername,'a.example');
    assert.equal(options.rejectUnauthorized,true);
    assert.equal(options.agent,false);
    assert.equal(options.headers.authorization,undefined);
    assert.equal(options.headers.cookie,undefined);
    options.lookup(url.hostname,{},(error,address,family)=>{
      assert.equal(error,null);
      assert.equal(address,'93.184.216.34');
      assert.equal(family,4);
    });
    options.lookup(url.hostname,{all:true},(error,addresses)=>{
      assert.equal(error,null);
      assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);
    });
    const req = new EventEmitter();
    req.end=()=>respond(Object.assign(Readable.from([Buffer.from('%PDF-1.7\nhi')]),{statusCode:200,headers:{'content-type':'application/pdf'}}));
    return req;
  });
  syncBuiltinESMExports();
  try {
    const service = await setup(t,undefined);
    assert.equal((await service.download({url:'https://a.example/a.pdf'})).bytes,11);
  } finally { stub.mock.restore(); syncBuiltinESMExports(); }
});

test('rejects symlink destinations and handles DNS failure without disclosing details', async t => {
  const service = await setup(t,async()=>response('%PDF-1.7'));
  const other = join(service.dataDir,'other');
  await mkdir(other);
  await symlink(other,join(service.dataDir,'downloads'));
  await assert.rejects(service.download({url:'https://a.example/a.pdf'}));
  assert.deepEqual(await readdir(other),[]);
  for (const resolve of [async()=>[],async()=>{throw new Error('SECRET');}]) {
    const fail = await setup(t,()=>assert.fail('transport'),resolve);
    await assert.rejects(fail.download({url:'https://a.example/a.pdf'}),e=>!e.message.includes('SECRET'));
  }
});

test('cancels a stalled stream and removes its partial file', async t => {
  const body = new ReadableStream({start(controller){controller.enqueue(Buffer.from('%PDF-1.7\nhi'));}});
  const service = await setup(t,async()=>new Response(body,{headers:{'content-type':'application/pdf'}}));
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),15);
  try { await assert.rejects(service.download({url:'https://a.example/a.pdf'},{signal:controller.signal})); }
  finally {clearTimeout(timer);}
  assert.deepEqual(await readdir(join(service.dataDir,'downloads')),[]);
});

test('supports binary DXF and public IPv6, rejects malformed redirects and nested syntax', async t => {
  const service = await setup(t,async()=>response('AutoCAD Binary DXF\r\n\x1a\0data','application/dxf'),async()=>[{address:'2606:4700:4700::1111',family:6}]);
  assert.equal((await service.download({url:'https://a.example/a.dxf'})).name,'a.dxf');
  const redirect = await setup(t,async()=>response(null,'text/plain',302));
  await assert.rejects(redirect.download({url:'https://a.example/a.pdf'}));
  const {calculate}=service;
  assert.equal(calculate({expressions:[{name:'ok',expression:' +(1 + (2*3)) + e - e + 5%2'}]}).results[0].value,8);
  for (const expression of ['(1','sqrt(1','min('+Array(33).fill('1').join(',')+')']) assert.throws(()=>calculate({expressions:[{name:'bad',expression}]}));
});

test('calculates arithmetic, named values and geometry functions without executable code', () => {
  const {calculate} = createAgentUtilities({dataDir:'/unused'});
  assert.deepEqual(calculate({variables:{width:3,height:4}, expressions:[
    {name:'area',expression:'width * height'}, {name:'diagonal',expression:'sqrt(width^2+height**2)'},
    {name:'trig',expression:'sin(pi/2)+cos(0)+tan(0)'}, {name:'power',expression:'-2^2 + 2^3^2'},
    {name:'more',expression:'min(3,4)+max(2,5)+abs(-3)+round(2.6)+floor(2.9)+ceil(2.1)+pow(2,3)+atan2(0,1)'},
  ]}).results.map(({name,value})=>({name,value})), [
    {name:'area',value:12}, {name:'diagonal',value:5}, {name:'trig',value:2}, {name:'power',value:508}, {name:'more',value:27},
  ]);
});

test('calculator rejects code, inherited properties, nonfinite results and excessive complexity', () => {
  const {calculate} = createAgentUtilities({dataDir:'/unused'});
  for (const expression of ['process.exit()', 'constructor.constructor(1)', 'globalThis', '1;2', 'a=2', '1/0', 'sqrt(-1)', '2^99999', 'NaN', 'Infinity', 'min()', 'pow(2)', '1 2', '1+', '(', 'foo(2)', 'constructor', '1e999', '('.repeat(40)+'1'+')'.repeat(40), '1+'.repeat(600)+'1']) {
    assert.throws(()=>calculate({expressions:[{name:'bad',expression}]}));
  }
  for (const input of [null,{}, {expressions:[]}, {expressions:Array(33).fill({name:'x',expression:'1'})}, {expressions:[{name:'../x',expression:'1'}]}, {variables:{x:Infinity},expressions:[{name:'a',expression:'1'}]}, {variables:{sin:3},expressions:[{name:'a',expression:'1'}]}, {expressions:[{name:'x',expression:'1'},{name:'x',expression:'2'}]}]) assert.throws(()=>calculate(input));
});

test('supports named dependent expressions and rejects collisions or extra arguments', async t => {
  const service=await setup(t,()=>assert.fail('network'));
  const variables={width:3,depth:2,length:10};
  assert.deepEqual(service.calculate({variables,expressions:[
    {name:'trench_area',expression:'width * depth'},
    {name:'volume',expression:'trench_area * length'},
  ]}).results.map(item=>item.value),[6,60]);
  assert.deepEqual(variables,{width:3,depth:2,length:10});
  for (const input of [
    {variables,expressions:[{name:'width',expression:'2'}]},
    {expressions:[{name:'sin',expression:'2'}]}, {expressions:[{name:'pi',expression:'2'}]},
    {expressions:[{name:'x',expression:'1',code:'bad'}]},
    {expressions:[{name:'x',expression:'1'}],code:'bad'},
  ]) assert.throws(()=>service.calculate(input));
  for (const input of [null,[],{url:'https://a.example/a.pdf',headers:{Authorization:'bad'}},{url:'https://a.example/a.pdf',path:'/tmp/overwrite'}]) await assert.rejects(service.download(input));
  await assert.rejects(service.download({url:'https://a.example/a.pdf'},{headers:{}}));
});
