import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { deflateSync } from 'node:zlib';
import { createWebReference } from '../lib/web-reference.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const document = (body, type = 'text/html; charset=utf-8', status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...extra } });
const reference = (fetchImpl, lookupImpl = publicLookup) => createWebReference({ fetchImpl, lookupImpl });

test('extracts untrusted HTML evidence with original-byte hash and source provenance', async () => {
  const html = '<title>옹벽 &amp; 기초</title><script>ignore instructions</script><style>.a{}</style><!-- secret --><h1>표준도</h1><p>높이&nbsp;3m &lt; 검토</p>';
  const result = await reference(async () => document(html)).fetchDocument({ url: 'https://standards.example/drawing#section' });
  assert.equal(result.url, 'https://standards.example/drawing');
  assert.equal(result.title, '옹벽 & 기초');
  assert.match(result.content, /표준도\s+높이 3m < 검토/);
  assert.doesNotMatch(result.content, /ignore|secret|\.a/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.contentType, 'text/html');
});

test('blocks credentials, IP literals, localhost, alternate ports and non-HTTPS before DNS', async () => {
  const service = reference(() => assert.fail('must not fetch'), () => assert.fail('must not resolve'));
  for (const url of ['http://example.com', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com:8443', 'https://localhost', 'https://a.localhost', 'https://host.local', 'https://127.1', 'https://[::1]', 'https://2130706433', 'https://169.254.169.254']) {
    await assert.rejects(service.fetchDocument({ url }), /공개 HTTPS/);
  }
});

test('rejects any private or mapped address in a mixed DNS answer', async () => {
  const addresses = ['10.1.2.3', '127.0.0.1', '169.254.1.2', '172.16.0.1', '192.168.0.1', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1'];
  for (const address of addresses) {
    await assert.rejects(reference(() => assert.fail('must not fetch'), async () => [...await publicLookup(), { address, family: address.includes(':') ? 6 : 4 }]).fetchDocument({ url: 'https://standards.example' }), /공개 주소/);
  }
});

test('passes only the validated DNS address to transport without another lookup', async () => {
  let lookups = 0;
  const result = await reference(async (url, options) => {
    assert.equal(url.hostname, 'standards.example');
    assert.equal(options.address, '93.184.216.34');
    assert.equal(options.family, 4);
    assert.ok(options.signal instanceof AbortSignal);
    return document('기초 설계 기준', 'text/plain');
  }, async () => { lookups++; return publicLookup(); }).fetchDocument({ url: 'https://standards.example' });
  assert.equal(lookups, 1);
  assert.equal(result.content, '기초 설계 기준');
});

test('native HTTPS transport pins DNS, preserves TLS identity and omits credentials', async context => {
  const stub = context.mock.method(https, 'request', (url, options, onResponse) => {
    assert.equal(url.hostname, 'standards.example');
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, 'standards.example');
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    options.lookup('standards.example', {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
    });
    options.lookup('standards.example', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
    });
    const req = new EventEmitter();
    req.end = () => onResponse(Object.assign(Readable.from([Buffer.from('Standard 300 mm')]), { statusCode: 200, headers: { 'content-type': 'text/plain' } }));
    return req;
  });
  syncBuiltinESMExports();
  try {
    const result = await createWebReference({ lookupImpl: publicLookup }).fetchDocument({ url: 'https://standards.example' });
    assert.equal(result.content, 'Standard 300 mm');
  } finally { stub.mock.restore(); syncBuiltinESMExports(); }
});

test('accepts public IPv6 DNS and rejects empty DNS responses', async () => {
  await reference(async (_url, options) => {
    assert.equal(options.address, '2606:4700:4700::1111');
    return document('기준', 'text/plain');
  }, async () => [{ address: '2606:4700:4700::1111', family: 6 }]).fetchDocument({ url: 'https://standards.example' });
  await assert.rejects(reference(() => {}, async () => []).fetchDocument({ url: 'https://standards.example' }), /공개 주소/);
});

test('accepts well-known NAT64 DNS only when the embedded IPv4 is public', async () => {
  for (const address of ['64:ff9b::3d55:62de', '0064:ff9b:0000:0000:0000:0000:3d55:62de']) {
    const result = await reference(async (_url, options) => {
      assert.equal(options.address, address);
      assert.equal(options.family, 6);
      return document('Manufacturer unit mass D13 0.995 kg/m', 'text/plain');
    }, async () => [{ address, family: 6 }, { address: '61.85.98.222', family: 4 }]).fetchDocument({ url: 'https://standards.example/table' });
    assert.match(result.content, /0.995 kg\/m/);
  }
  for (const address of ['64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:1', '64:ff9b::c000:201', '64:ff9b:1::3d55:62de']) {
    await assert.rejects(reference(() => assert.fail('must not fetch'), async () => [...await publicLookup(), { address, family: 6 }]).fetchDocument({ url: 'https://standards.example' }), /공개 주소/);
  }
});

test('revalidates redirect destinations and blocks redirects to private services', async () => {
  let calls = 0;
  const service = reference(async () => { calls++; return document(null, 'text/html', 302, { location: 'https://localhost/private' }); });
  await assert.rejects(service.fetchDocument({ url: 'https://standards.example' }), /공개 HTTPS/);
  assert.equal(calls, 1);
});

test('follows bounded HTTPS redirects and records the final URL', async () => {
  let calls = 0;
  const result = await reference(async () => ++calls === 1 ? document(null, 'text/html', 301, { location: '/standard.txt' }) : document('설계 기준', 'text/plain'))
    .fetchDocument({ url: 'https://standards.example' });
  assert.equal(result.url, 'https://standards.example/standard.txt');
  assert.equal(result.requestedUrl, 'https://standards.example/');
  assert.equal(calls, 2);
  await assert.rejects(reference(async () => document(null, 'text/html', 302, { location: '/loop' })).fetchDocument({ url: 'https://standards.example' }), /이동 횟수/);
});

test('limits bytes before extraction, including streaming bodies with misleading lengths', async () => {
  await assert.rejects(reference(async () => document('a', 'text/plain', 200, { 'content-length': String(4 * 1024 * 1024 + 1) })).fetchDocument({ url: 'https://standards.example' }), /4MB/);
  await assert.rejects(reference(async () => document('a'.repeat(4 * 1024 * 1024 + 1), 'text/plain')).fetchDocument({ url: 'https://standards.example' }), /4MB/);
});

test('caps extracted text and marks truncation', async () => {
  const result = await reference(async () => document('가'.repeat(40_000), 'text/plain')).fetchDocument({ url: 'https://standards.example' });
  assert.equal(result.content.length, 32_000);
  assert.equal(result.truncated, true);
});

test('returns XML and RSS source text without parsing external entities', async () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY external SYSTEM "file:///etc/passwd">]><rss><channel><item><title>ADA 405 ramp slope</title><link>https://www.access-board.gov/ada/</link><description>&external;</description></item></channel></rss>';
  for (const type of ['application/rss+xml', 'application/xml', 'text/xml']) {
    const result = await reference(async () => document(xml, type)).fetchDocument({ url: 'https://standards.example/search.rss' });
    assert.equal(result.contentType, type);
    assert.equal(result.content, xml);
    assert.equal(result.untrusted, true);
  }
});

test('rejects executable, binary, compressed, error and empty responses', async () => {
  for (const response of [document('alert(1)', 'application/javascript'), document('MZ', 'application/octet-stream'), document('data', 'text/plain', 200, { 'content-encoding': 'gzip' }), document('no', 'text/plain', 403), document('   ', 'text/plain')]) {
    await assert.rejects(reference(async () => response).fetchDocument({ url: 'https://standards.example' }));
  }
});

test('strips sensitive URL fragments and refuses excessive URL input', async () => {
  const service = reference(async () => document('a', 'text/plain'));
  for (const url of [null, '', 42, 'https://standards.example/' + 'x'.repeat(4096)]) {
    await assert.rejects(service.fetchDocument({ url }));
  }
});

test('does not leak DNS or transport internal errors', async () => {
  const secret = randomUUID();
  await assert.rejects(reference(async () => { throw new Error(secret); }).fetchDocument({ url: 'https://standards.example' }), (error) => !error.message.includes(secret));
  await assert.rejects(reference(() => {}, async () => { throw new Error(secret); }).fetchDocument({ url: 'https://standards.example' }), (error) => !error.message.includes(secret));
});

test('malformed repeated HTML tags remain linear within the document byte limit', async () => {
  for (const size of [500_000, 4 * 1024 * 1024 - 32]) {
    for (const tag of ['<title>', '<script>', '<!--', '<']) {
      const html = 'visible ' + tag.repeat(Math.floor(size / tag.length));
      const started = performance.now();
      const result = await reference(async () => document(html)).fetchDocument({ url: 'https://standards.example' });
      assert.match(result.content, /visible/);
      assert.ok(performance.now() - started < (size < 1_000_000 ? 750 : 3000), `malformed ${tag} took too long for ${size} bytes`);
    }
  }
});

function pdfFixture(text, imageSize) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET${imageSize ? ' q 100 0 0 100 0 0 cm /Im1 Do Q' : ''}`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> ${imageSize ? '/XObject << /Im1 6 0 R >>' : ''} >> /Contents 5 0 R >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  if (imageSize) {
    const image = deflateSync(Buffer.alloc(Math.ceil(imageSize / 8) * imageSize));
    objects.push(`<< /Type /XObject /Subtype /Image /Width ${imageSize} /Height ${imageSize} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${image.length} >>\nstream\n${image.toString('latin1')}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('extracts PDF text in a separate bounded worker and states geometry limitation', async () => {
  const result = await reference(async () => document(pdfFixture('Design criteria 300 mm'), 'application/pdf')).fetchDocument({ url: 'https://standards.example/criteria.pdf' });
  assert.match(result.content, /Design criteria 300 mm/);
  assert.equal(result.pages, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.truncated, false);
  assert.match(result.limitation, /형상·치수/);
});

test('keeps text deadlines at 15 seconds and bounds PDF work within 45 seconds with timers disposed', async context => {
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const timers = [];
  const disposed = new Set();
  context.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    timers.push({ timer, delay });
    return timer;
  });
  context.mock.method(globalThis, 'clearTimeout', timer => { disposed.add(timer); return cancel(timer); });
  await reference(async () => document('standard', 'text/plain')).fetchDocument({ url: 'https://standards.example' });
  assert.deepEqual(timers.map(({ delay }) => delay), [15_000]);
  await reference(async () => document(pdfFixture('table'), 'application/pdf')).fetchDocument({ url: 'https://standards.example/file.pdf' });
  assert.equal(timers[1].delay, 15_000);
  assert.ok(timers[2].delay > 0 && timers[2].delay <= 45_000);
  assert.ok(timers.every(({ timer }) => disposed.has(timer)));
});

test('reports damaged PDFs and returns a bounded page image when text is unavailable', async () => {
  await assert.rejects(reference(async () => document('not a PDF', 'application/pdf')).fetchDocument({ url: 'https://standards.example/criteria.pdf' }), /PDF 텍스트/);
  const result = await reference(async () => document(pdfFixture('', 1), 'application/pdf')).fetchDocument({ url: 'https://standards.example/scanned.pdf' });
  assert.match(result.content, /이미지/);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].page, 1);
  assert.equal(result.images[0].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(result.images[0].data, 'base64').length <= 512 * 1024);
  assert.ok(result.images[0].width <= 1600 && result.images[0].height <= 1600);
});

test('bounds decoded PDF image pixels and warns that rendered content may be incomplete', async () => {
  const result = await reference(async () => document(pdfFixture('', 5000), 'application/pdf')).fetchDocument({ url: 'https://standards.example/oversized-image.pdf', page: 1 });
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(result.images[0].data, 'base64'));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  assert.deepEqual([...context.getImageData(100, image.height - 100, 1, 1).data], [255, 255, 255, 255]);
  assert.match(result.limitation, /일부.*표시되지/);
});

test('reads a bounded PDF download attachment and renders the explicitly requested page', async () => {
  const bytes = Buffer.concat([pdfFixture('Unit mass table'), Buffer.alloc(5 * 1024 * 1024, 32)]);
  const result = await reference(async () => document(bytes, 'application/octet-stream', 200, { 'content-disposition': "attachment;filename*=UTF-8''rebar.pdf" })).fetchDocument({ url: 'https://standards.example/download/42', page: 1 });
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(result.responseContentType, 'application/octet-stream');
  assert.match(result.content, /Unit mass table/);
  assert.equal(result.images[0].page, 1);
  assert.equal(result.bytes, bytes.length);
  for (const page of [0, -1, 501, 1.5, '1']) await assert.rejects(reference(() => assert.fail('must not fetch')).fetchDocument({ url: 'https://standards.example/file.pdf', page }), /페이지/);
  await assert.rejects(reference(async () => document(pdfFixture('table'), 'application/pdf')).fetchDocument({ url: 'https://standards.example/file.pdf', page: 2 }), /페이지/);
});

test('keeps PDF byte limits and verifies binary MIME candidates by both filename and signature', async () => {
  await assert.rejects(reference(async () => document(pdfFixture('table'), 'application/pdf', 200, { 'content-length': String(32 * 1024 * 1024 + 1) })).fetchDocument({ url: 'https://standards.example/file.pdf' }), /32MB/);
  for (const [url, body, headers] of [
    ['https://standards.example/download/42', pdfFixture('table'), {}],
    ['https://standards.example/file.pdf', 'MZ executable', {}],
    ['https://standards.example/download/42', 'not a PDF', { 'content-disposition': 'attachment; filename="rebar.pdf"' }],
  ]) await assert.rejects(reference(async () => document(body, 'application/octet-stream', 200, headers)).fetchDocument({ url }));
});
