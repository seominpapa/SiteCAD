import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, stat, realpath, symlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createTerrainData } from '../lib/terrain-data.mjs';

const bbox = [126.978, 37.566, 126.980, 37.568];
const point = (coordinates = [126.979, 37.567], properties = { elevation_m: 23.4 }) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties });
const collection = features => ({ type: 'FeatureCollection', features });
async function fixture(data = collection([point()]), name = 'survey.geojson') {
  const dir = await mkdtemp(join(tmpdir(), 'sitecad-terrain-'));
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(data));
  const dataDir = join(dir, 'private');
  const api = await createTerrainData({ dataDir, selectFile: async () => file });
  return { dir, file, dataDir, api };
}

async function downloadFixture(data = collection([point()]), name = 'survey.geojson') {
  const dir = await mkdtemp(join(tmpdir(), 'sitecad-terrain-download-'));
  const dataDir = join(dir, 'private'), id = randomUUID();
  await mkdir(join(dataDir, 'downloads'), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(data)), path = join(dataDir, 'downloads', `${id}-${name}`);
  await writeFile(path, bytes);
  const metadata = { id, name, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://data.example.org/survey.geojson', retrievedAt: '2026-10-23T03:00:00.000Z' };
  return { dir, dataDir, metadata, api: await createTerrainData({ dataDir }) };
}

async function siblingDownload(metadata, name) {
  const id = randomUUID(), path = join(metadata.path, '..', `${id}-${name}`);
  await writeFile(path, await readFile(metadata.path));
  return { ...metadata, id, name, path };
}

test('public GeoJSON transfer-limit flag rejects an incomplete original before catalog commit', async () => {
  const { api, metadata } = await downloadFixture({ ...collection([point()]), exceededTransferLimit: true });
  await assert.rejects(api.registerDownload(metadata), /원본|제한/);
  assert.deepEqual(await api.list(), []);
});

test('public municipal contour ELE_ALT is read as metres without changing source bytes', async () => {
  const data = collection([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[126.9785, 37.5665], [126.9795, 37.5675]] }, properties: { ELE_ALT: 120 } }]);
  const { api, metadata } = await downloadFixture(data);
  const before = await readFile(metadata.path);
  const dataset = await api.registerDownload(metadata);
  const result = await api.query({ datasetId: dataset.id, bbox });
  assert.equal(result.features[0].properties.elevation_m, 120);
  assert.deepEqual(await readFile(metadata.path), before);
  for (const properties of [{ ELE_ALT: 'invalid' }, { ELE_ALT: 120, HEIGHT: 121 }]) {
    const bad = await downloadFixture(collection([{ ...data.features[0], properties }]));
    await assert.rejects(bad.api.registerDownload(bad.metadata), /원본/);
  }
});

test('parallel download registrations preserve both entries in memory and after restart', async () => {
  const { api, metadata, dataDir } = await downloadFixture();
  const second = await siblingDownload(metadata, 'second.geojson');
  const entries = await Promise.all([api.registerDownload(metadata), api.registerDownload(second)]);
  assert.deepEqual((await api.list()).map(row => row.id).sort(), entries.map(row => row.id).sort());
  const reopened = await createTerrainData({ dataDir });
  assert.deepEqual((await reopened.list()).map(row => row.id).sort(), entries.map(row => row.id).sort());
});

test('parallel registrations enforce the catalog limit at commit time', async () => {
  const { api, metadata, dataDir } = await downloadFixture();
  const additional = await Promise.all(Array.from({ length: 20 }, (_, i) => siblingDownload(metadata, `survey-${i}.geojson`)));
  const results = await Promise.allSettled([metadata, ...additional].map(row => api.registerDownload(row)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 20);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await api.list()).length, 20);
  assert.equal((await (await createTerrainData({ dataDir })).list()).length, 20);
});

test('a registration cancelled while queued does not commit after the previous registration', async context => {
  const { api, metadata, dataDir } = await downloadFixture();
  const second = await siblingDownload(metadata, 'second.geojson'), controller = new AbortController();
  let releaseWrite, writing, validated;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const started = new Promise(resolve => { writing = resolve; });
  const secondValidated = new Promise(resolve => { validated = resolve; });
  const actualWrite = fsPromises.writeFile, actualLstat = fsPromises.lstat;
  let writes = 0, secondChecks = 0;
  const mockedWrite = context.mock.method(fsPromises, 'writeFile', async (path, ...args) => {
    if (typeof path === 'string' && path.endsWith('.tmp') && ++writes === 1) { writing(); await writeGate; }
    return actualWrite(path, ...args);
  });
  const mockedLstat = context.mock.method(fsPromises, 'lstat', async (path, ...args) => {
    const result = await actualLstat(path, ...args);
    if (path === second.path && ++secondChecks === 2) validated();
    return result;
  });
  syncBuiltinESMExports();
  try {
    const first = api.registerDownload(metadata);
    await started;
    const next = api.registerDownload(second, { signal: controller.signal });
    const rejected = assert.rejects(next, /취소/);
    await secondValidated;
    await new Promise(setImmediate);
    controller.abort(); releaseWrite();
    const entry = await first;
    await rejected;
    assert.deepEqual(await api.list(), [entry]);
    assert.deepEqual(await (await createTerrainData({ dataDir })).list(), [entry]);
  } finally { releaseWrite(); mockedWrite.mock.restore(); mockedLstat.mock.restore(); syncBuiltinESMExports(); }
});

test('registers app downloads with persistent original URL, hash, CRS and elevation provenance', async () => {
  const { api, dataDir, metadata } = await downloadFixture({ ...collection([point([953945.6294420916, 1952087.3083653094, 25.5], {})]), crs: 'EPSG:5179' });
  const entry = await api.registerDownload(metadata);
  assert.equal(entry.sourceKind, 'public-download');
  assert.match(entry.sourceLabel, /미검증/);
  assert.equal(entry.sourceUrl, metadata.url);
  assert.equal(entry.downloadedAt, metadata.retrievedAt);
  assert.equal(entry.sourceSha256, metadata.sha256);
  assert.ok(!JSON.stringify(entry).includes(metadata.path));
  assert.deepEqual(await api.registerDownload(metadata), entry);
  const reopened = await createTerrainData({ dataDir });
  assert.deepEqual(await reopened.list(), [entry]);
  const result = await reopened.query({ bbox, datasetId: entry.id });
  assert.equal(result.sourceUrl, metadata.url);
  assert.equal(result.downloadedAt, metadata.retrievedAt);
  assert.equal(result.sourceSha256, metadata.sha256);
  assert.equal(result.originalCRS, 'EPSG:5179');
  assert.equal(result.features[0].properties.elevation_m, 25.5);
  assert.ok(Math.abs(result.features[0].geometry.coordinates[0] - 126.9785) < 1e-9);
  assert.equal((await stat(join(dataDir, 'terrain-data.json'))).mode & 0o777, 0o600);
});

test('rejects downloads outside owned storage, mismatched bytes/hash and unsafe provenance without mutation', async () => {
  const { api, metadata, dataDir } = await downloadFixture();
  const existing = await api.registerDownload(metadata);
  const before = await readFile(join(dataDir, 'terrain-data.json'), 'utf8');
  for (const change of [
    { path: join(dataDir, 'elsewhere.geojson') }, { id: randomUUID() }, { name: '../survey.geojson' },
    { bytes: metadata.bytes + 1 }, { sha256: '0'.repeat(64) }, { name: 'survey.shp' },
    { url: 'http://data.example.org/survey.geojson' }, { url: 'https://user:password@data.example.org/survey.geojson' },
    { url: 'https://localhost/survey.geojson' }, { url: 'https://127.0.0.1/survey.geojson' },
    { url: 'https://data.example.org/survey.geojson?api_key=secret' }, { retrievedAt: 'invalid' },
    { url: 'https://data.internal/survey.geojson' }, { url: 'https://data.example.org/%65yJtoken.payload.signature/survey.geojson' },
    { url: `https://data.example.org/${'x'.repeat(2048)}` },
  ]) await assert.rejects(api.registerDownload({ ...metadata, ...change }), error => !error.message.includes(dataDir));
  assert.deepEqual(await api.list(), [existing]);
  assert.equal(await readFile(join(dataDir, 'terrain-data.json'), 'utf8'), before);
});

test('download registration upgrades a previously picker-registered copy with its verified download provenance', async () => {
  const { dataDir, metadata } = await downloadFixture();
  const api = await createTerrainData({ dataDir, selectFile: async () => metadata.path });
  assert.equal((await api.importFile()).sourceKind, 'local-file');
  const registered = await api.registerDownload(metadata);
  assert.equal(registered.sourceKind, 'public-download');
  assert.equal((await api.list()).length, 1);
  assert.equal((await api.query({ bbox })).sourceUrl, metadata.url);
});

test('persisted download provenance is validated before exposing catalog entries', async () => {
  const { api, metadata, dataDir } = await downloadFixture();
  await api.registerDownload(metadata);
  const registryPath = join(dataDir, 'terrain-data.json');
  const stored = JSON.parse(await readFile(registryPath, 'utf8'));
  for (const change of [{ sourceUrl: 'http://localhost/private' }, { downloadedAt: 'bad' }, { sourceKind: 'verified-official' }]) {
    await writeFile(registryPath, JSON.stringify({ ...stored, datasets: [{ ...stored.datasets[0], ...change }] }));
    await assert.rejects(createTerrainData({ dataDir }), /등록 정보/);
  }
});

test('failed atomic commit preserves the previous catalog and removes temporary files', async context => {
  const { api, metadata, dataDir } = await downloadFixture();
  const actualRename = fsPromises.rename;
  const mocked = context.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === join(dataDir, 'terrain-data.json')) throw new Error('private path must not leak');
    return actualRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(api.registerDownload(metadata), error => !error.message.includes('private path')); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await api.list(), []);
  await assert.rejects(readFile(join(dataDir, 'terrain-data.json')), { code: 'ENOENT' });
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  assert.equal((await api.registerDownload(metadata)).sourceKind, 'public-download');
});

test('rejects symlink download files and download directories', async () => {
  const { api, metadata, dataDir, dir } = await downloadFixture();
  const id = randomUUID(), link = join(dataDir, 'downloads', `${id}-linked.geojson`);
  await symlink(metadata.path, link);
  await assert.rejects(api.registerDownload({ ...metadata, id, name: 'linked.geojson', path: link }));
  const otherDir = join(dir, 'other');
  await mkdir(otherDir);
  await symlink(join(dataDir, 'downloads'), join(otherDir, 'downloads'));
  const other = await createTerrainData({ dataDir: otherDir });
  await assert.rejects(other.registerDownload({ ...metadata, path: join(otherDir, 'downloads', `${metadata.id}-${metadata.name}`) }));
  assert.deepEqual(await api.list(), []);
  assert.deepEqual(await other.list(), []);
});

test('download registration validates actual GeoJSON CRS and elevations and leaves no catalog on rejection', async () => {
  for (const data of [
    { ...collection([point()]), crs: 'EPSG:999999' }, collection([point(undefined, {})]),
    collection([point([126.979, 37.567, 3], { elevation_m: 7 })]), { arbitrary: true },
  ]) {
    const { api, metadata, dataDir } = await downloadFixture(data);
    await assert.rejects(api.registerDownload(metadata));
    assert.deepEqual(await api.list(), []);
    await assert.rejects(readFile(join(dataDir, 'terrain-data.json')), { code: 'ENOENT' });
  }
});

test('cancellation before verification or at commit keeps the previous catalog unchanged', async context => {
  const { api, metadata, dataDir } = await downloadFixture();
  const preCanceled = AbortSignal.abort();
  await assert.rejects(api.registerDownload(metadata, { signal: preCanceled }));
  assert.deepEqual(await api.list(), []);
  const first = await api.registerDownload(metadata);
  const before = await readFile(join(dataDir, 'terrain-data.json'), 'utf8');
  const next = await downloadFixture();
  const secondId = randomUUID(), secondPath = join(dataDir, 'downloads', `${secondId}-second.geojson`);
  await writeFile(secondPath, await readFile(next.metadata.path));
  const controller = new AbortController(), actualWrite = fsPromises.writeFile;
  const mocked = context.mock.method(fsPromises, 'writeFile', async (path, ...args) => {
    const result = await actualWrite(path, ...args);
    if (typeof path === 'string' && path.endsWith('.tmp')) controller.abort();
    return result;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(api.registerDownload({ ...next.metadata, id: secondId, name: 'second.geojson', path: secondPath }, { signal: controller.signal })); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await api.list(), [first]);
  assert.equal(await readFile(join(dataDir, 'terrain-data.json'), 'utf8'), before);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

async function pointShp(dir, name = 'contours', height = '25.500') {
  const path = join(dir, `${name}.shp`);
  const shp = Buffer.alloc(128);
  shp.writeInt32BE(9994, 0); shp.writeInt32BE(64, 24); shp.writeInt32LE(1000, 28); shp.writeInt32LE(1, 32);
  for (const [offset, value] of [[36, 126.979], [44, 37.567], [52, 126.979], [60, 37.567]]) shp.writeDoubleLE(value, offset);
  shp.writeInt32BE(1, 100); shp.writeInt32BE(10, 104); shp.writeInt32LE(1, 108); shp.writeDoubleLE(126.979, 112); shp.writeDoubleLE(37.567, 120);
  const dbf = Buffer.alloc(78, 0);
  dbf[0] = 3; dbf.writeUInt32LE(1, 4); dbf.writeUInt16LE(65, 8); dbf.writeUInt16LE(12, 10);
  dbf.write('CONT', 32); dbf[43] = 'N'.charCodeAt(0); dbf[48] = 11; dbf[49] = 3; dbf[64] = 13; dbf[65] = 32;
  dbf.write(height.padStart(11), 66); dbf[77] = 26;
  await writeFile(path, shp);
  await writeFile(join(dir, `${name}.dbf`), dbf);
  await writeFile(join(dir, `${name}.prj`), 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]');
  return path;
}

test('registers user-selected terrain privately and returns safe catalog entries', async () => {
  const { api, file, dataDir } = await fixture();
  assert.deepEqual(await api.list(), []);
  const imported = await api.importFile();
  assert.match(imported.id, /^terrain-[a-f0-9-]+$/);
  assert.equal(imported.title, 'survey.geojson');
  assert.equal(imported.originalCRS, 'EPSG:4326');
  assert.equal(imported.verticalDatum, 'unknown');
  assert.ok(!JSON.stringify(imported).includes(file));
  assert.equal((await stat(join(dataDir, 'terrain-data.json'))).mode & 0o777, 0o600);
  const reopened = await createTerrainData({ dataDir });
  assert.deepEqual(await reopened.list(), [imported]);
  const result = await reopened.query({ bbox, datasetId: imported.id });
  assert.deepEqual(result.features, [point()]);
  assert.equal(result.crs, 'EPSG:4326');
  assert.equal(result.sourceSha256.length, 64);
  assert.equal(result.count, 1);
  assert.equal(result.possiblyTruncated, false);
  assert.ok(!JSON.stringify(result).includes(file));
});

test('canceled selection does not register anything; importing same file reuses entry', async () => {
  const { api, dataDir } = await fixture();
  const first = await api.importFile();
  assert.deepEqual(await api.importFile(), first);
  const canceled = await createTerrainData({ dataDir, selectFile: async () => undefined });
  assert.equal(await canceled.importFile(), null);
  const noPicker = await createTerrainData({ dataDir });
  await assert.rejects(noPicker.importFile(), /파일 선택/);
});

test('clips crossing contours to query area without changing original elevation', async () => {
  const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[126.977, 37.567], [126.981, 37.567]] }, properties: { CONT: '30' } };
  const { api } = await fixture(collection([feature, point([127, 37])]));
  await api.importFile();
  const result = await api.query({ bbox });
  assert.equal(result.count, 1);
  assert.deepEqual(result.features[0], { type: 'Feature', geometry: { type: 'LineString', coordinates: [[126.978, 37.567], [126.980, 37.567]] }, properties: { elevation_m: 30 } });
});

test('reprojects declared metric CRS and preserves true point Z without interpolation', async () => {
  const { api } = await fixture({ ...collection([point([953945.6294420916, 1952087.3083653094, 25.5], {})]), crs: 'EPSG:5179' });
  await api.importFile();
  const result = await api.query({ bbox });
  assert.ok(Math.abs(result.features[0].geometry.coordinates[0] - 126.9785) < 1e-9);
  assert.ok(Math.abs(result.features[0].geometry.coordinates[1] - 37.567) < 1e-9);
  assert.equal(result.features[0].properties.elevation_m, 25.5);
  assert.deepEqual(result.features[0].geometry.coordinates.length, 2);
});

test('rejects unknown CRS, absent elevation, nonfinite or conflicting heights', async () => {
  for (const data of [
    { ...collection([point()]), crs: 'EPSG:999999' },
    collection([point(undefined, {})]),
    collection([point(undefined, { elevation_m: 10000 })]),
    collection([point(undefined, { elevation_m: 'NaN' })]),
    collection([point([126.979, 37.567, 3], { elevation_m: 7 })]),
    collection([point([126.979, 37.567], { elevation_m: 3, CONT: 4 })]),
  ]) {
    const { api } = await fixture(data);
    await assert.rejects(api.importFile(), /좌표|표고|자료/);
  }
});

test('limits feature count explicitly and never returns paths or arbitrary properties', async () => {
  const { api } = await fixture(collection([point(undefined, { elevation_m: 20, owner: 'private', url: 'http://localhost' }), point(), point()]));
  await api.importFile();
  const result = await api.query({ bbox, maxFeatures: 2 });
  assert.equal(result.count, 2);
  assert.equal(result.possiblyTruncated, true);
  assert.deepEqual(Object.keys(result.features[0].properties), ['elevation_m']);
  for (const input of [{ bbox: [0, 0, 1, 1] }, { bbox: [126, 37, 127, 38] }, { bbox, maxFeatures: 0 }, { bbox, datasetId: '/tmp/private' }, { bbox, filename: 'anything' }]) await assert.rejects(api.query(input));
});

test('rejects a changed registered file and does not silently change source provenance', async () => {
  const { api, file } = await fixture();
  await api.importFile();
  await writeFile(file, JSON.stringify(collection([point(undefined, { elevation_m: 100 })])));
  await assert.rejects(api.query({ bbox }), /변경|등록/);
});

test('rejects a source modified after reading before returning its recorded hash', async context => {
  const { api, file } = await fixture();
  await api.importFile();
  const actualStat = fsPromises.stat;
  const canonical = await realpath(file);
  let calls = 0, modified = false;
  const mocked = context.mock.method(fsPromises, 'stat', async (path, ...options) => {
    if (path === canonical && ++calls === 3) {
      modified = true;
      await writeFile(file, JSON.stringify(collection([point(undefined, { elevation_m: 999 })])));
    }
    return actualStat(path, ...options);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(api.query({ bbox }), /변경|등록/); assert.equal(modified, true); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('reports absent and ambiguous datasets or empty coverage explicitly', async () => {
  const { api, dir, dataDir } = await fixture();
  await assert.rejects(api.query({ bbox }), /등록/);
  await api.importFile();
  await assert.rejects(api.query({ bbox: [127, 37, 127.001, 37.001] }), /자료.*없|없.*자료/);
  const file2 = join(dir, 'second.geojson');
  await writeFile(file2, JSON.stringify(collection([point()])));
  const second = await createTerrainData({ dataDir, selectFile: async () => file2 });
  await second.importFile();
  await assert.rejects(second.query({ bbox }), /선택|datasetId/);
});

test('bundled source is read-only catalog data, does not copy into registry', async () => {
  const { file, dataDir } = await fixture();
  const api = await createTerrainData({ dataDir, bundledPath: file });
  const entries = await api.list();
  assert.equal(entries.length, 1);
  assert.equal((await api.query({ bbox })).count, 1);
  await assert.rejects(readFile(join(dataDir, 'terrain-data.json')));
});

test('malformed registry and unsupported input do not expose local paths', async () => {
  const { dir, dataDir } = await fixture();
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'terrain-data.json'), '{}');
  await assert.rejects(createTerrainData({ dataDir }), error => !error.message.includes(dir));
  const bad = await createTerrainData({ dataDir: join(dir, 'other'), selectFile: async () => join(dir, 'input.exe') });
  await assert.rejects(bad.importFile(), /SHP|GeoJSON/);
});

test('reads SHP with sibling DBF height and actual PRJ and returns normalized source hash', async () => {
  const { dir, dataDir } = await fixture();
  const shp = await pointShp(dir);
  const api = await createTerrainData({ dataDir, selectFile: async () => shp });
  const entry = await api.importFile();
  assert.match(entry.originalCRS, /^GEOGCS\[/);
  const result = await api.query({ bbox });
  assert.deepEqual(result.features[0], point(undefined, { elevation_m: 25.5 }));
  assert.equal(result.sourceSha256.length, 64);
  assert.equal(result.sourceKind, 'local-file');
  assert.match(result.sourceLabel, /미검증/);
});

test('rejects missing SHP companion files with safe errors', async () => {
  const { dir, dataDir } = await fixture();
  const path = join(dir, 'missing.shp');
  await writeFile(path, 'bad');
  const api = await createTerrainData({ dataDir, selectFile: async () => path });
  await assert.rejects(api.importFile(), error => /자료/.test(error.message) && !error.message.includes(dir));
});

test('rejects oversized SHP records before parser allocation', async () => {
  const { dir, dataDir } = await fixture();
  const path = await pointShp(dir);
  const bytes = await readFile(path);
  bytes.writeInt32BE(0x30000000, 104);
  await writeFile(path, bytes);
  const api = await createTerrainData({ dataDir, selectFile: async () => path });
  await assert.rejects(api.importFile(), /資料|자료|좌표/);
});

test('splits exiting and returning lines and retains MultiLineString sections', async () => {
  const feature = { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [
    [[126.9785, 37.5665], [126.981, 37.5665], [126.981, 37.5675], [126.9785, 37.5675]],
    [[126.979, 37.566], [126.979, 37.568]],
  ] }, properties: { HEIGHT: 30 } };
  const { api } = await fixture(collection([feature]));
  await api.importFile();
  const result = await api.query({ bbox });
  assert.equal(result.features[0].geometry.type, 'MultiLineString');
  assert.equal(result.features[0].geometry.coordinates.length, 3);
  assert.equal(result.features[0].properties.elevation_m, 30);
});
