import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { readSkillBackground } from './sitecad-skills.mjs';

const fields = Object.freeze({ situation: '필요했던 상황', problem: '발생한 문제', changeReason: '생성·수정 이유와 변경 내용', examplePrompt: '입력 예시', expectedResult: '기대 결과' });
const maxBytes = 16 * 1024 * 1024;
const fail = message => Object.assign(Error(message), { skillExport: true });
const sameFile = (left, right) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);

function checkedInput(options, input) {
  if (!isAbsolute(options?.codexHome ?? '') || typeof options.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(options.version) || options.version.length > 64) throw fail('앱 버전과 스킬 저장 경로를 확인해 주세요.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== Object.keys(fields).length || Object.keys(input).some(key => !Object.hasOwn(fields, key))) throw fail('개선안 설명 입력을 확인해 주세요.');
  for (const value of Object.values(input)) if (typeof value !== 'string' || !value.trim() || value.length > 4000 || value.includes('\0')) throw fail('개선안 설명은 항목별 1~4000자로 입력해 주세요.');
}

function checkedName(name) {
  if (name.startsWith('.') || /(?:^|[-_.])(?:auth|credentials?|secrets?|tokens?)(?:[-_.]|$)/i.test(name) || /\.(?:enc|pem|key|p12|pfx)$/i.test(name)) throw fail('스킬 폴더의 숨김 파일이나 인증·비밀 파일을 제거한 뒤 다시 내보내 주세요.');
  if (!name || Buffer.byteLength(name) > 240 || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw fail('스킬 폴더에 ZIP으로 공유할 수 없는 파일 이름이 있습니다.');
}

async function checkedDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('스킬 폴더는 심볼릭 링크가 아닌 실제 폴더여야 합니다.');
  return info;
}

async function readResource(path, info) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(info, await handle.stat())) throw fail('내보내는 중 스킬 파일이 변경됐습니다. 다시 시도해 주세요.');
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== info.size || !sameFile(info, await handle.stat()) || !sameFile(info, await lstat(path))) throw fail('내보내는 중 스킬 파일이 변경됐습니다. 다시 시도해 주세요.');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

function notesText(title, background) {
  return `# ${title}\n\n${Object.entries(fields).map(([key, label]) => `## ${label}\n\n${background[key].trim()}\n`).join('\n')}`;
}

function backgroundDocument(name, raw) {
  const saved = readSkillBackground(raw);
  if (!saved) return `# ${name} 생성·수정 배경\n\n이 스킬의 생성·수정 배경은 미기록입니다. 기존 스킬의 과거 상황과 문제를 추정하지 않습니다.\n\n이번 제출 상황은 루트의 개선안 설명.md를 참고하세요.\n`;
  return `${notesText(`${name} 생성·수정 배경`, saved.background)}\n작업: ${saved.operation === 'update' ? '기존 스킬 수정' : '새 스킬 생성'}\n${saved.recordedAt ? `\n기록 시각: ${saved.recordedAt}\n` : ''}${saved.previousHash ? `\n수정 전 SKILL.md SHA-256: ${saved.previousHash}\n` : ''}`;
}

function zip(entries) {
  const localParts = [];
  const directoryParts = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(header, filename, bytes); directoryParts.push(central, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

export async function exportSkills(options, input) {
  checkedInput(options, input);
  try {
    await checkedDirectory(options.codexHome);
    const codexHome = await realpath(options.codexHome);
    const root = join(codexHome, 'skills');
    await checkedDirectory(root);
    const report = `${notesText('SiteCAD 스킬 개선안', input)}\n앱 버전: ${options.version}\n\n보낼 주소: seominpapa@gmail.com\n\n이 문서는 이번 제출 설명입니다. 스킬별 생성·수정 배경은 개선배경/에 있으며 과거 배경이 기록되지 않은 스킬은 미기록으로 표시합니다.\n\nskills/는 전체 스킬 폴더의 복사본입니다. 로그인·앱 설정 파일과 전체 대화 로그는 포함하지 않습니다. 설명 문서에는 관련 사용자 요청 요약과 스킬 변경 기록이 포함됩니다. 스킬 본문과 참고 자료에 개인·현장 정보가 있을 수 있으므로 ZIP 내용을 확인한 후 이메일에 직접 첨부해 주세요. 이메일은 자동 발송되지 않습니다.\n`;
    const entries = [{ name: '개선안 설명.md', bytes: Buffer.from(report) }, { name: 'skills/', bytes: Buffer.alloc(0) }];
    let totalBytes = entries[0].bytes.length;
    let entryCount = 2;
    let files = 0;
    const add = (name, bytes) => {
      if (++entryCount > 1024) throw fail('공유할 스킬 파일·폴더 개수는 1024개 이하여야 합니다.');
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) throw fail('공유할 스킬 전체 용량은 16MB 이하여야 합니다.');
      entries.push({ name, bytes });
    };
    const walk = async (path, relative = '', depth = 0) => {
      if (depth > 12) throw fail('스킬 폴더 깊이는 12단계 이하여야 합니다.');
      const previous = await checkedDirectory(path);
      const children = (await readdir(path)).sort();
      if (children.length + entryCount > 1024) throw fail('공유할 스킬 파일·폴더 개수는 1024개 이하여야 합니다.');
      for (const name of children) {
        checkedName(name);
        const child = join(path, name), archiveName = `${relative}${name}`;
        const info = await lstat(child);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw fail('스킬 폴더의 링크나 특수 파일은 공유할 수 없습니다.');
        if (info.isDirectory()) { add(`skills/${archiveName}/`, Buffer.alloc(0)); await walk(child, `${archiveName}/`, depth + 1); }
        else {
          if (info.size > maxBytes - totalBytes) throw fail('공유할 스킬 전체 용량은 16MB 이하여야 합니다.');
          const bytes = await readResource(child, info);
          add(`skills/${archiveName}`, bytes); files++;
          if (name === 'SKILL.md' && depth === 1) add(`개선배경/${relative.slice(0, -1)}.md`, Buffer.from(backgroundDocument(relative.slice(0, -1), bytes.toString('utf8'))));
        }
      }
      if (!sameFile(previous, await lstat(path))) throw fail('내보내는 중 스킬 폴더가 변경됐습니다. 다시 시도해 주세요.');
    };
    await walk(root);
    if (!files) throw fail('공유할 스킬 파일이 없습니다. 스킬을 만든 뒤 다시 내보내 주세요.');
    return { name: `SiteCAD-skills-${options.version}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.zip`, bytes: zip(entries) };
  } catch (error) {
    throw error.skillExport ? error : fail('스킬을 내보내지 못했습니다. 폴더 접근 권한과 파일 상태를 확인해 주세요.');
  }
}
