import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, unlink, readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

const MAX_BYTES = 32 * 1024 * 1024;
const MIME_EXTENSIONS = Object.freeze({ 'application/pdf':'pdf', 'application/acad':'dwg', 'application/x-acad':'dwg', 'image/vnd.dwg':'dwg', 'application/dwg':'dwg', 'application/dxf':'dxf', 'image/vnd.dxf':'dxf', 'application/zip':'zip', 'application/x-zip-compressed':'zip', 'application/geo+json':'geojson', 'application/json':'json', 'text/csv':'csv', 'text/plain':'txt' });
const EXTENSIONS = new Set(Object.values(MIME_EXTENSIONS));
const ERROR_DOWNLOAD = '자료를 내려받지 못했습니다. 공개 다운로드 주소와 네트워크를 확인해 주세요.';

function checkedUrl(input) {
  if (typeof input !== 'string' || !input || input.length > 4096) throw new Error('공개 HTTPS 다운로드 주소를 입력해 주세요.');
  let url;
  try { url = new URL(input); } catch { throw new Error('공개 HTTPS 다운로드 주소를 입력해 주세요.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g,'')) || !host.includes('.') || /(^|\.)(localhost|local|internal|home|lan|invalid|test)$/.test(host)) throw new Error('인증 정보가 없는 공개 HTTPS 주소만 사용할 수 있습니다.');
  if ([...url.searchParams.keys()].some(key => /key|token|secret|auth|credential|signature|password|session|^sig$/i.test(key)) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(url.pathname + url.search)) throw new Error('인증 정보가 포함된 다운로드 주소는 사용할 수 없습니다.');
  url.hostname = host;
  url.hash = '';
  return url;
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || (b===0 && (c===0 || c===2)) || (b===88 && c===99))) || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if (isIP(address)!==6 || address.includes('.') || address.includes('%')) return false;
  const first = parseInt(address.split(':')[0],16), second = parseInt(address.split(':')[1] || '0',16);
  return first>=0x2000 && first<0x4000 && first!==0x2002 && first!==0x3fff && !(first===0x2001 && (second<0x200 || second===0xdb8));
}

function requestBytes(url, {address,family,signal}) {
  return new Promise((resolve,reject) => {
    const req = httpsRequest(url, {
      agent:false, signal, rejectUnauthorized:true, servername:url.hostname, maxHeaderSize:16*1024,
      headers:{accept:'application/pdf, application/zip, application/json, application/geo+json, application/octet-stream, text/plain, text/csv, application/dxf', 'accept-encoding':'identity', 'user-agent':'SiteCAD (material downloader)'},
      // Pin checked DNS while TLS verifies the original hostname.
      lookup:(_host,options,callback) => options.all ? callback(null,[{address,family}]) : callback(null,address,family),
    }, response => resolve({status:response.statusCode,headers:new Headers(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])),body:response}));
    req.once('error',reject);
    req.end();
  });
}

function interrupted(promise, signal) {
  return new Promise((resolve,reject) => {
    const abort = () => reject(new Error('자료 다운로드가 취소되었거나 제한 시간을 초과했습니다.'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

function discard(response) {
  if (typeof response.body?.destroy==='function') response.body.destroy();
  else void response.body?.cancel?.().catch(()=>{});
}

async function retrieve(url, request, lookup, signal) {
  for (let redirects=0; redirects<=3; redirects++) {
    signal.throwIfAborted();
    let addresses;
    try { addresses = await interrupted(lookup(url.hostname,{all:true,verbatim:true}),signal); }
    catch { throw new Error('다운로드 서버의 공개 주소를 확인하지 못했습니다.'); }
    if (!addresses.length || addresses.some(({address})=>!publicAddress(address))) throw new Error('공개 주소로만 다운로드할 수 있습니다.');
    let response;
    try { response = await interrupted(request(url,{...addresses[0],signal,maxBytes:MAX_BYTES}),signal); }
    catch { throw new Error(ERROR_DOWNLOAD); }
    if (![301,302,303,307,308].includes(response.status)) return {response,url};
    const location = response.headers.get('location');
    discard(response);
    if (redirects===3) throw new Error('다운로드 주소 이동 횟수가 너무 많습니다.');
    if (!location) throw new Error(ERROR_DOWNLOAD);
    url = checkedUrl(new URL(location,url).href);
  }
}

function downloadName(url, name, type) {
  const source = name ?? decodeURIComponent(basename(url.pathname));
  if (typeof source!=='string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,95}$/u.test(source) || /[. ]$/.test(source)) throw new Error('자료 이름은 경로 문자가 없는 96자 이하의 파일명이어야 합니다.');
  const extension = extname(source).slice(1).toLowerCase();
  if (extension && !EXTENSIONS.has(extension)) throw new Error('PDF·DWG·DXF·ZIP·GeoJSON·JSON·CSV·TXT 파일만 다운로드할 수 있습니다.');
  const inferred = MIME_EXTENSIONS[type];
  const resultExtension = extension || inferred;
  if (!resultExtension) throw new Error('다운로드 자료의 파일 형식을 확인할 수 없습니다.');
  if (inferred && inferred!==resultExtension && !((inferred==='txt' && ['csv','dxf','geojson','json'].includes(resultExtension)) || (inferred==='json' && resultExtension==='geojson'))) throw new Error('파일명과 서버의 자료 형식이 일치하지 않습니다.');
  return {name:extension ? source.slice(0,-extension.length)+resultExtension : `${source}.${resultExtension}`,extension:resultExtension};
}

async function writeDownload(response, path, signal) {
  let file;
  try {
    file = await open(path,'wx',0o600);
    const hash = createHash('sha256');
    let size = 0;
    const iterator = response.body?.[Symbol.asyncIterator]?.();
    if (!iterator) throw new Error(ERROR_DOWNLOAD);
    while (true) {
      const {value,done} = await interrupted(iterator.next(),signal);
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size>MAX_BYTES) throw new Error('자료는 32MB 이하만 다운로드할 수 있습니다.');
      signal.throwIfAborted();
      await file.writeFile(chunk);
      hash.update(chunk);
    }
    if (!size) throw new Error('다운로드 자료가 비어 있습니다.');
    return {bytes:size,sha256:hash.digest('hex')};
  } catch (error) { discard(response); throw error; }
  finally { await file?.close(); }
}

async function checkSignature(path, extension) {
  const bytes = await readFile(path);
  const prefix = bytes.subarray(0,4096).toString('utf8').replace(/^\uFEFF/,'').trimStart();
  if (/^<(?:!doctype\s+html|html|head|body|script|\?xml)/i.test(prefix)) throw new Error('자료 대신 HTML·로그인 페이지가 반환되었습니다.');
  let valid;
  if (extension==='pdf') valid = bytes.subarray(0,5).toString()==='%PDF-';
  else if (extension==='dwg') valid = /^AC10\d{2}/.test(bytes.subarray(0,6).toString());
  else if (extension==='zip') valid = ['504b0304','504b0506','504b0708'].includes(bytes.subarray(0,4).toString('hex'));
  else if (extension==='dxf') valid = prefix.startsWith('AutoCAD Binary DXF\r\n\x1a\0') || /^0\s+SECTION\b/.test(prefix);
  else if (extension==='json' || extension==='geojson') {
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('다운로드 자료가 올바른 JSON이 아닙니다.'); }
    valid = extension==='json' || ['FeatureCollection','Feature','Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon','GeometryCollection'].includes(data?.type);
  } else valid = !bytes.includes(0) && !/^(?:MZ|\x7fELF|#!)/.test(prefix);
  if (!valid) throw new Error('다운로드 자료의 실제 내용과 파일 형식이 일치하지 않습니다.');
}

const FUNCTIONS = Object.freeze({
  sqrt:[Math.sqrt,1,1], abs:[Math.abs,1,1], sin:[Math.sin,1,1], cos:[Math.cos,1,1], tan:[Math.tan,1,1],
  floor:[Math.floor,1,1], ceil:[Math.ceil,1,1], round:[Math.round,1,1], pow:[Math.pow,2,2], atan2:[Math.atan2,2,2],
  min:[Math.min,1,32], max:[Math.max,1,32],
});
const identifier = value => typeof value==='string' && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value) && !['constructor','prototype','__proto__'].includes(value);
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
function finite(value) { if (!Number.isFinite(value)) throw new Error('계산 결과가 유한한 숫자가 아닙니다. 입력값과 수식을 확인해 주세요.'); return value; }
function exactObject(value,keys) { return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>keys.includes(key)); }

function evaluate(expression, variables) {
  if (typeof expression!=='string' || !expression.trim() || expression.length>2048) throw new Error('수식은 1~2048자로 입력해 주세요.');
  const tokens = [];
  const pattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|([A-Za-z][A-Za-z0-9_]*)|(\*\*|[+*/^(),%-]))/y;
  let offset = 0;
  while (offset<expression.trimEnd().length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match || tokens.length>=512) throw new Error('수식에 지원하지 않는 문자 또는 너무 많은 연산이 있습니다.');
    tokens.push(match[0].trim());
    offset = pattern.lastIndex;
  }
  let cursor=0, depth=0;
  const take = token => tokens[cursor]===token ? (++cursor,true) : false;
  const primary = () => {
    if (++depth>32) throw new Error('수식 괄호와 함수의 중첩은 32단계 이하여야 합니다.');
    try {
      const token = tokens[cursor++];
      if (token==='(') { const value = sum(); if (!take(')')) throw new Error('수식의 닫는 괄호가 필요합니다.'); return value; }
      if (/^(?:\d|\.)/.test(token || '')) return finite(Number(token));
      if (token==='pi') return Math.PI;
      if (token==='e') return Math.E;
      if (own(variables,token)) return variables[token];
      if (!own(FUNCTIONS,token) || !take('(')) throw new Error('수식에 알 수 없는 변수나 함수가 있습니다.');
      const args = [];
      if (!take(')')) { do { args.push(sum()); if (args.length>32) throw new Error('함수 인수는 32개 이하여야 합니다.'); } while (take(',')); if (!take(')')) throw new Error('함수의 닫는 괄호가 필요합니다.'); }
      const [fn,min,max] = FUNCTIONS[token];
      if (args.length<min || args.length>max) throw new Error('함수 인수 개수가 올바르지 않습니다.');
      return finite(fn(...args));
    } finally { depth--; }
  };
  const power = () => { const base = primary(); return take('^') || take('**') ? finite(base ** unary()) : base; };
  const unary = () => take('+') ? unary() : take('-') ? -unary() : power();
  const product = () => { let value=unary(); while (['*','/','%'].includes(tokens[cursor])) { const op=tokens[cursor++], next=unary(); value=finite(op==='*' ? value*next : op==='/' ? value/next : value%next); } return value; };
  const sum = () => { let value=product(); while (['+','-'].includes(tokens[cursor])) { const op=tokens[cursor++], next=product(); value=finite(op==='+' ? value+next : value-next); } return value; };
  const result = finite(sum());
  if (cursor!==tokens.length) throw new Error('수식 끝에 지원하지 않는 내용이 있습니다.');
  return result;
}

export function createAgentUtilities({dataDir, request=requestBytes, lookup=dnsLookup} = {}) {
  return {
    async download(input = {}, options = {}) {
      if (!exactObject(input,['url','name']) || !exactObject(options,['signal']) || (options.signal!==undefined && !(options.signal instanceof AbortSignal))) throw new Error('다운로드 입력값은 URL과 파일명만 지정할 수 있습니다.');
      const {url:sourceUrl,name}=input, {signal:callerSignal}=options;
      const initial = checkedUrl(sourceUrl);
      const signal = callerSignal ? AbortSignal.any([callerSignal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const {response,url} = await retrieve(initial,request,lookup,signal);
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const encoding = response.headers.get('content-encoding');
      if (response.status!==200 || (encoding && encoding!=='identity') || (!own(MIME_EXTENSIONS,contentType) && contentType!=='application/octet-stream')) { discard(response); throw new Error(ERROR_DOWNLOAD); }
      if (Number(response.headers.get('content-length'))>MAX_BYTES) { discard(response); throw new Error('자료는 32MB 이하만 다운로드할 수 있습니다.'); }
      let path;
      try {
        const fileName = downloadName(url,name,contentType);
        const folder = join(dataDir,'downloads');
        await mkdir(folder,{recursive:true,mode:0o700});
        const directory = await lstat(folder);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(ERROR_DOWNLOAD);
        const id = randomUUID();
        path = join(folder,`${id}-${fileName.name}`);
        const metadata = await writeDownload(response,path,signal);
        await checkSignature(path,fileName.extension);
        signal.throwIfAborted();
        return {id,name:fileName.name,path,...metadata,contentType,url:url.href,retrievedAt:new Date().toISOString(),untrusted:true};
      } catch (error) {
        discard(response);
        if (path) await unlink(path).catch(()=>{});
        if (error.code) throw new Error(ERROR_DOWNLOAD);
        throw error;
      }
    },
    calculate(input = {}) {
      if (!exactObject(input,['expressions','variables'])) throw new Error('계산 입력값은 수식과 숫자 변수만 지정할 수 있습니다.');
      const {expressions,variables={}} = input ?? {};
      if (!Array.isArray(expressions) || !expressions.length || expressions.length>32 || !variables || typeof variables!=='object' || Array.isArray(variables) || Object.keys(variables).length>64) throw new Error('수식 1~32개와 숫자 변수를 입력해 주세요.');
      const checked = Object.fromEntries(Object.entries(variables).map(([name,value]) => {
        if (!identifier(name) || own(FUNCTIONS,name) || ['pi','e'].includes(name) || typeof value!=='number') throw new Error('변수 이름 또는 숫자 값이 올바르지 않습니다.');
        return [name,finite(value)];
      }));
      let scope = checked;
      const results = expressions.map(item => {
        if (!exactObject(item,['name','expression']) || !identifier(item.name) || own(scope,item.name) || own(FUNCTIONS,item.name) || ['pi','e'].includes(item.name)) throw new Error('수식 이름은 기존 변수·함수와 겹치지 않는 영문 식별자여야 합니다.');
        const value=evaluate(item.expression,scope);
        scope={...scope,[item.name]:value};
        return {name:item.name,expression:item.expression,value};
      });
      return {results,variables:checked,angleUnit:'radian'};
    },
  };
}
