import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

export const MAX_TERRAIN_UPLOAD_BYTES = 128 * 1024 * 1024;
const INVALID = 'GeoJSON 파일 1개 또는 같은 이름의 SHP·DBF·PRJ 파일 3개를 선택해 주세요.';

function checkedFiles(files) {
  if (!Array.isArray(files) || ![1, 3].includes(files.length)) throw Error(INVALID);
  const checked = files.map(file => {
    if (!file || typeof file.name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u.test(file.name) || !Buffer.isBuffer(file.bytes) || !file.bytes.length) throw Error(INVALID);
    const extension = extname(file.name).toLowerCase();
    return { extension, stem: file.name.slice(0, -extension.length), bytes: file.bytes };
  });
  if (checked.reduce((total, file) => total + file.bytes.length, 0) > MAX_TERRAIN_UPLOAD_BYTES) throw Error('지형 업로드 파일의 합계는 128 MiB 이하여야 합니다.');
  if (checked.length === 1) {
    if (!['.json', '.geojson'].includes(checked[0].extension)) throw Error(INVALID);
    return checked.map(file => ({ name: file.stem + file.extension, bytes: file.bytes }));
  }
  const main = checked.find(file => file.extension === '.shp');
  if (!main || new Set(checked.map(file => file.extension)).size !== 3 || checked.some(file => !['.shp', '.dbf', '.prj'].includes(file.extension) || file.stem.toLowerCase() !== main.stem.toLowerCase())) throw Error(INVALID);
  return checked.map(file => ({ name: main.stem + file.extension, bytes: file.bytes }));
}

export async function importTerrainUpload({ dataDir, files, importFile }) {
  const sources = checkedFiles(files);
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || typeof importFile !== 'function') throw Error('지형 파일 저장 환경을 확인해 주세요.');
  const root = join(dataDir, 'TerrainUploads');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== join(await realpath(dataDir), 'TerrainUploads')) throw Error('지형 파일 저장 폴더를 확인해 주세요.');
  const folder = join(root, randomUUID());
  await mkdir(folder, { mode: 0o700 });
  try {
    for (const file of sources) await writeFile(join(folder, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    const main = sources.find(file => file.name.endsWith('.shp')) ?? sources[0];
    const dataset = await importFile(join(folder, main.name));
    if (!dataset) throw Error('지형 파일 등록을 완료하지 못했습니다.');
    return dataset;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
