import { constants } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const testDrawingNames = Object.freeze([
  'box-culvert-2x3-foundation-progress.dwg',
  'box-culvert-2x3-noncompliant.dwg',
  'box-culvert-2x3-normal-corrected.dwg',
  'box-culvert-2x3-normal.dwg',
  'retaining-wall-3m-foundation-progress.dwg',
  'retaining-wall-3m-noncompliant.dwg',
  'retaining-wall-3m-normal.dwg',
  '테스트_안내.md',
]);

export async function copyTestDrawings(sourceRoot, destinationRoot) {
  const source = join(sourceRoot, 'drawings', 'Test');
  for (const path of [join(sourceRoot, 'drawings'), source, ...testDrawingNames.map(name => join(source, name))]) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error('Test drawing source must not contain a symbolic link');
    if (path === source || path === join(sourceRoot, 'drawings')) {
      if (!info.isDirectory()) throw Error('Test drawing source must be a directory');
    } else if (!info.isFile()) throw Error('Test drawing must be a regular file');
  }
  const destination = join(destinationRoot, 'drawings', 'Test');
  await mkdir(destination, { recursive: true });
  for (const name of testDrawingNames) await copyFile(join(source, name), join(destination, name), constants.COPYFILE_EXCL);
}
