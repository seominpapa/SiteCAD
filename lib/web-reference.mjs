import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 32_000;
const MAX_PAGES = 30;
const MAX_PAGE_IMAGE_BYTES = 512 * 1024;
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/html', 'application/xhtml+xml', 'application/rss+xml', 'application/xml', 'text/xml']);

function publicUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('공개 HTTPS 문서 URL을 입력해 주세요.');
  let url;
  try { url = new URL(value); } catch { throw new Error('공개 HTTPS 문서 URL을 입력해 주세요.'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|home|lan|invalid|test)$/.test(hostname)) {
    throw new Error('인증 정보나 IP 주소가 없는 공개 HTTPS 문서 URL만 사용할 수 있습니다.');
  }
  url.hostname = hostname;
  url.hash = '';
  return url;
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  // DNS64 networks synthesize public destinations under RFC 6052's /96 prefix.
  // Validate the embedded IPv4 too: NAT64 must never disguise a private target.
  const [head, tail] = address.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = (tail === undefined ? leading : [...leading, ...Array(8 - leading.length - trailing.length).fill('0'), ...trailing]).map(part => parseInt(part, 16));
  if (groups.slice(0, 6).every((part, index) => part === [0x64, 0xff9b, 0, 0, 0, 0][index])) {
    return publicAddress([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.'));
  }
  const first = parseInt(address.split(':')[0], 16);
  const second = parseInt(address.split(':')[1] || '0', 16);
  return first >= 0x2000 && first < 0x4000 && first !== 0x2002 && first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

function requestDocument(url, { address, family, signal }) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, signal, rejectUnauthorized: true, servername: url.hostname, maxHeaderSize: 16 * 1024,
      headers: { accept: 'text/html, text/plain, text/markdown, application/pdf, application/rss+xml, application/xml, text/xml', 'accept-encoding': 'identity', 'user-agent': 'SiteCAD/0.3 (reference reader)' },
      // Pin the checked address while TLS still verifies the original host.
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
    }, response => resolve({ status: response.statusCode, headers: new Headers(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])), body: response }));
    req.once('error', reject);
    req.end();
  });
}

async function discard(response) {
  if (typeof response.body?.destroy === 'function') response.body.destroy();
  else await response.body?.cancel?.().catch(() => {});
}

async function readDocument(response, limit = MAX_BYTES) {
  const tooLarge = () => new Error(`참고 문서는 ${limit / 1024 / 1024}MB 이하만 읽을 수 있습니다.`);
  if (Number(response.headers.get('content-length')) > limit) {
    await discard(response);
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await discard(response);
    throw error;
  }
  return Buffer.concat(chunks, size);
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const value = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
  });
}

function cleanText(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t\r\f]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

function htmlText(text) {
  const parts = [];
  const titleParts = [];
  const blockedTags = new Set(['script', 'style', 'noscript', 'template', 'svg']);
  const breakTags = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'table']);
  let cursor = 0, blocked = '', inTitle = false, titleComplete = false, titleLength = 0;
  const append = value => {
    if (blocked) return;
    parts.push(value);
    if (inTitle && titleLength < 240) {
      titleParts.push(value.slice(0, 240 - titleLength));
      titleLength += value.length;
    }
  };
  // Each character is scanned once, including unterminated tags and comments.
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) { append(text.slice(cursor)); break; }
    append(text.slice(cursor, start));
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      cursor = end < 0 ? text.length : end + 3;
      continue;
    }
    let end = start + 1, quote = '';
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === text.length) { append(text.slice(start)); break; }
    const tag = text.slice(start + 1, end);
    const name = /^\/?\s*([a-z][a-z0-9:-]*)/i.exec(tag)?.[1]?.toLowerCase();
    const closing = tag[0] === '/';
    cursor = end + 1;
    if (blocked) { if (closing && name === blocked) blocked = ''; continue; }
    if (!closing && blockedTags.has(name)) { blocked = name; continue; }
    if (name === 'title') {
      if (closing && inTitle) { inTitle = false; titleComplete = true; }
      else if (!closing && !titleComplete) inTitle = true;
    }
    append(name === 'br' || (closing && breakTags.has(name)) ? '\n' : ' ');
  }
  return { content: cleanText(decodeEntities(parts.join(''))), title: titleComplete ? cleanText(decodeEntities(titleParts.join(''))).slice(0, 240) : '' };
}

function extractText(bytes, type, charset) {
  let text;
  try { text = new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { throw new Error('이 문서의 문자 인코딩을 읽을 수 없습니다.'); }
  if (type !== 'text/html' && type !== 'application/xhtml+xml') return { content: cleanText(text), title: '' };
  return htmlText(text);
}

function documentDeadline() {
  const controller = new AbortController();
  const started = Date.now();
  let timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref();
  return {
    signal: controller.signal,
    allowPdf() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), Math.max(0, 45_000 - (Date.now() - started)));
      timer.unref();
    },
    dispose() { clearTimeout(timer); },
  };
}

async function pdfText(bytes, signal, page) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { sitecadPdf: true, bytes, page }, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('참고 문서를 읽는 시간이 초과되었습니다.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    worker.once('message', message => message.error ? finish(new Error(message.error)) : finish(null, message));
    worker.once('error', () => finish(new Error('PDF 문서를 안전하게 읽지 못했습니다.')));
    worker.once('exit', () => finish(new Error('PDF 문서를 안전하게 읽지 못했습니다.')));
  });
}

async function renderPdfPage(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const scale = 1600 / Math.max(original.width, original.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.canvasFactory.create(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
  try {
    await page.render({ canvasContext: canvas.context, viewport, background: 'rgb(255,255,255)' }).promise;
    for (const quality of [85, 60, 40]) {
      const encoded = canvas.canvas.toBuffer('image/jpeg', quality);
      if (encoded.length <= MAX_PAGE_IMAGE_BYTES) return { page: pageNumber, mimeType: 'image/jpeg', width: canvas.canvas.width, height: canvas.canvas.height, data: encoded.toString('base64') };
    }
    throw new Error('PDF 페이지 이미지가 제한을 초과했습니다.');
  } finally { document.canvasFactory.destroy(canvas); page.cleanup(); }
}

async function extractPdfWorker(bytes, requestedPage) {
  let loading;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 16 * 1024 * 1024, stopAtErrors: true, verbosity: 0 });
    const document = await loading.promise;
    if (requestedPage !== undefined && requestedPage > document.numPages) return { error: '요청한 PDF 페이지가 문서 범위를 벗어났습니다.' };
    const pagesRead = Math.min(document.numPages, MAX_PAGES);
    let content = '';
    let count = 0;
    for (let pageNumber = 1; pageNumber <= pagesRead && content.length <= MAX_TEXT; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const pageText = text.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      if (pageText.trim()) content += `[PDF page ${pageNumber}]\n${pageText}\n`;
      count++;
      page.cleanup();
    }
    const images = requestedPage !== undefined || !content.trim() ? [await renderPdfPage(document, requestedPage ?? 1)] : [];
    const guidance = 'PDF 이미지 원문을 첨부했습니다. 수치는 이미지에서 실제 판독한 경우만 인용하세요. 다른 쪽은 cad_fetch의 page에 PDF 페이지 번호를 지정해 조회하세요. 렌더링 한도나 손상으로 일부 내용이 표시되지 않을 수 있으므로, 보이지 않는 항목이 원문에도 없다고 단정하지 마세요. 도면 형상·치수·스케일과 OCR 정확도는 별도 검증이 필요합니다.';
    return { content: cleanText(content) || guidance, title: '', pages: document.numPages, pagesRead: count, truncated: document.numPages > count, ...(images.length ? { images } : {}), limitation: images.length ? guidance : 'PDF 텍스트만 추출했습니다. 스캔 이미지와 도면 형상·치수는 별도 검증이 필요합니다. 표가 없거나 깨졌으면 cad_fetch에 page를 지정해 원문 페이지 이미지를 확인하세요.' };
  } catch {
    throw new Error('PDF 텍스트를 읽지 못했습니다. 암호화·손상·스캔 PDF이거나 PDF 읽기 구성요소가 준비되지 않았습니다.');
  } finally { await loading?.destroy(); }
}

if (!isMainThread && workerData?.sitecadPdf) {
  extractPdfWorker(workerData.bytes, workerData.page).then(result => parentPort.postMessage(result), error => parentPort.postMessage({ error: error.message }));
}

export function createWebReference({ fetchImpl = requestDocument, lookupImpl = lookup } = {}) {
  return {
    async fetchDocument({ url: input, page } = {}) {
      if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 500)) throw new Error('PDF 페이지는 1~500의 정수로 지정해 주세요.');
      const initial = publicUrl(input);
      const requestedUrl = initial.href;
      const deadline = documentDeadline();
      const { signal } = deadline;
      let url = initial;
      try {
        for (let redirects = 0; redirects <= 3; redirects++) {
          if (signal.aborted) throw new Error('참고 문서를 읽는 시간이 초과되었습니다.');
          let addresses;
          try { addresses = await Promise.race([lookupImpl(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))]); }
          catch { throw new Error('문서 서버의 공개 주소를 확인하지 못했습니다.'); }
          if (!addresses.length || addresses.some(record => !publicAddress(record.address))) throw new Error('공개 주소로만 연결할 수 있습니다.');
          let response;
          try { response = await fetchImpl(url, { address: addresses[0].address, family: addresses[0].family, signal }); }
          catch { throw new Error('공개 문서를 가져오지 못했습니다. URL과 네트워크를 확인해 주세요.'); }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await discard(response);
            if (redirects === 3) throw new Error('문서 주소 이동 횟수가 너무 많습니다.');
            try { url = publicUrl(new URL(location || '', url).href); }
            catch { throw new Error('문서 이동 주소도 공개 HTTPS URL이어야 합니다.'); }
            continue;
          }
          const typeHeader = response.headers.get('content-type') ?? '';
          const responseContentType = typeHeader.split(';')[0].trim().toLowerCase();
          const pdfAttachment = responseContentType === 'application/octet-stream' && (/\.pdf$/i.test(url.pathname) || /filename\*?\s*=\s*(?:UTF-8''|"?)[^;\r\n]*\.pdf(?:"?)(?:\s*;|\s*$)/i.test(response.headers.get('content-disposition') || ''));
          const contentType = pdfAttachment ? 'application/pdf' : responseContentType;
          const encoding = response.headers.get('content-encoding');
          if (response.status < 200 || response.status >= 300 || (!TEXT_TYPES.has(contentType) && contentType !== 'application/pdf') || (encoding && encoding !== 'identity')) {
            await discard(response);
            throw new Error('HTML·텍스트·XML·PDF 공개 문서만 읽을 수 있습니다. 서버 응답 형식과 접근 권한을 확인해 주세요.');
          }
          if (contentType === 'application/pdf') deadline.allowPdf();
          let bytes;
          try { bytes = await readDocument(response, contentType === 'application/pdf' ? MAX_PDF_BYTES : MAX_BYTES); }
          catch (error) { if (/\d+MB/.test(error.message)) throw error; throw new Error(signal.aborted ? '참고 문서를 읽는 시간이 초과되었습니다.' : '문서를 끝까지 읽지 못했습니다.'); }
          if (pdfAttachment && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF 다운로드의 실제 파일 형식이 PDF가 아닙니다.');
          if (page !== undefined && contentType !== 'application/pdf') throw new Error('페이지 조회는 PDF 문서에서만 사용할 수 있습니다.');
          const extracted = contentType === 'application/pdf' ? await pdfText(bytes, signal, page) : extractText(bytes, contentType, typeHeader.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]);
          if (!extracted.content.trim()) throw new Error('읽을 수 있는 텍스트가 없습니다. 이미지 도면이나 스캔 문서는 별도 판독이 필요합니다.');
          return Object.freeze({
            requestedUrl, url: url.href, title: extracted.title || (url.pathname.split('/').at(-1) || url.hostname).slice(0, 240),
            content: extracted.content.slice(0, MAX_TEXT), contentType, bytes: bytes.length,
            ...(responseContentType === contentType ? {} : { responseContentType }),
            sha256: createHash('sha256').update(bytes).digest('hex'), retrievedAt: new Date().toISOString(),
            truncated: Boolean(extracted.truncated || extracted.content.length > MAX_TEXT), untrusted: true,
            ...(extracted.pages === undefined ? {} : { pages: extracted.pages, pagesRead: extracted.pagesRead, limitation: extracted.limitation }),
            ...(extracted.images ? { images: extracted.images } : {}),
          });
        }
        throw new Error('참고 문서를 가져오지 못했습니다.');
      } finally { deadline.dispose(); }
    },
  };
}
