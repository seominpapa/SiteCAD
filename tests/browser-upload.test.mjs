import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { importTerrainUpload, MAX_TERRAIN_UPLOAD_BYTES } from '../lib/terrain-upload.mjs';
import { createTerrainData } from '../lib/terrain-data.mjs';

const json = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [126.979, 37.567] }, properties: { elevation_m: 25 } }] }));
const file = (name, bytes = json) => ({ name, bytes });
const directory = () => mkdtemp(join(tmpdir(), 'sitecad-upload-'));

test('browser GeoJSON is stored privately, registered and remains usable after restart without a native picker', async () => {
  const dataDir = await directory(), terrain = await createTerrainData({ dataDir });
  const dataset = await importTerrainUpload({ dataDir, files: [file('측량.geojson')], importFile: path => terrain.importFile(path) });
  assert.equal(dataset.title, '측량.geojson');
  const folders = await readdir(join(dataDir, 'TerrainUploads'));
  const folder = join(dataDir, 'TerrainUploads', folders[0]);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  assert.equal((await stat(join(folder, '측량.geojson'))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(join(folder, '측량.geojson')), json);
  const restarted = await createTerrainData({ dataDir });
  assert.equal((await restarted.query({ datasetId: dataset.id, bbox: [126.978, 37.566, 126.980, 37.568] })).features[0].properties.elevation_m, 25);
});

test('SHP companion names are canonicalized together without overwriting another import', async () => {
  const dataDir = await directory();
  const files = [file('Terrain.SHP', Buffer.from('shp')), file('terrain.DBF', Buffer.from('dbf')), file('TERRAIN.PRJ', Buffer.from('prj'))];
  const paths = [];
  const importFile = async path => { paths.push(path); assert.deepEqual((await readdir(dirname(path))).sort(), ['Terrain.dbf', 'Terrain.prj', 'Terrain.shp']); return { path }; };
  await importTerrainUpload({ dataDir, files, importFile });
  await importTerrainUpload({ dataDir, files, importFile });
  assert.notEqual(paths[0], paths[1]);
  assert.equal((await readdir(join(dataDir, 'TerrainUploads'))).length, 2);
  assert.equal(await readFile(paths[0], 'utf8'), 'shp');
});

test('invalid names, incomplete companions, duplicates and mixed formats fail before writing', async () => {
  const dataDir = await directory();
  const invalid = [[], [file('../survey.geojson')], [file('..\\survey.geojson')], [file('/survey.geojson')], [file('survey\u0000.geojson')], [file('.hidden.geojson')], [file('survey.zip')], [file('survey.shp')], [file('a.shp'), file('b.dbf'), file('a.prj')], [file('a.shp'), file('a.SHP'), file('a.prj')], [file('a.geojson'), file('a.dbf'), file('a.prj')], [file('a.geojson', Buffer.alloc(0))], [{ name: 'a.geojson', bytes: '../local-file' }]];
  for (const files of invalid) await assert.rejects(importTerrainUpload({ dataDir, files, importFile: () => assert.fail('must not register') }), /파일|SHP|GeoJSON/);
  assert.deepEqual(await readdir(dataDir), []);
});

test('total upload bytes are bounded before persistence', async () => {
  const dataDir = await directory();
  const bytes = Buffer.alloc(MAX_TERRAIN_UPLOAD_BYTES + 1);
  await assert.rejects(importTerrainUpload({ dataDir, files: [file('survey.geojson', bytes)], importFile: () => assert.fail('must not register') }), /128 MiB/);
  assert.deepEqual(await readdir(dataDir), []);
});

test('failed terrain validation removes staged source files and does not commit a catalog entry', async () => {
  const dataDir = await directory(), terrain = await createTerrainData({ dataDir });
  await assert.rejects(importTerrainUpload({ dataDir, files: [file('invalid.geojson', Buffer.from('{}'))], importFile: path => terrain.importFile(path) }), /지형|GeoJSON/);
  assert.deepEqual(await readdir(join(dataDir, 'TerrainUploads')), []);
  assert.deepEqual(await terrain.list(), []);
});

test('an upload-root symlink is rejected instead of writing outside SiteCAD data', async () => {
  const dataDir = await directory(), outside = await directory();
  await symlink(outside, join(dataDir, 'TerrainUploads'));
  await assert.rejects(importTerrainUpload({ dataDir, files: [file('survey.geojson')], importFile: () => assert.fail('must not register') }), /저장/);
  assert.deepEqual(await readdir(outside), []);
});

test('native terrain selection still works when no trusted import path is supplied', async () => {
  const dataDir = await directory();
  let selections = 0;
  const terrain = await createTerrainData({ dataDir, selectFile: async () => { selections++; return null; } });
  assert.equal(await terrain.importFile(), null);
  assert.equal(selections, 1);
});
