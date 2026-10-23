import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const magic = Buffer.from('SITECADWEB1\0');
const keychainMessage = 'SiteCAD 웹앱 키체인에 접근하지 못했습니다. 로그인 키체인을 확인한 뒤 실행기를 다시 시작해 주세요. 기존 데스크톱 로그인은 변경되지 않습니다.';

export function createNodeSecretStores({ dataDir, entry, platform = process.platform } = {}) {
  if (!isAbsolute(dataDir)) throw Error('SiteCAD data path must be absolute');
  let keyPromise;
  async function masterKey(required) {
    // Cache failures as well as successes: an API retry must not repeatedly trigger Keychain prompts.
    keyPromise ??= (async () => {
      try {
        if (!entry) {
          if (platform !== 'darwin') throw Error('macOS required');
          const { AsyncEntry } = await import('@napi-rs/keyring');
          entry = new AsyncEntry('SiteCAD Web', createHash('sha256').update(dataDir).digest('hex'));
        }
        const saved = await entry.getPassword();
        if (saved !== null && saved !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(saved)) throw Error('invalid key');
          return Buffer.from(saved, 'hex');
        }
        const existing = required || (await Promise.all(['credentials.enc', 'mcp-secrets.enc', 'vworld-secrets.enc'].map(name => lstat(join(dataDir, name)).then(() => true).catch(cause => { if (cause.code === 'ENOENT') return false; throw cause; })))).some(Boolean);
        if (existing) throw Error('missing key');
        const generated = randomBytes(32);
        await entry.setPassword(generated.toString('hex'));
        return generated;
      } catch { throw Error(keychainMessage); }
    })();
    return keyPromise;
  }
  function store(name) {
    const file = join(dataDir, name);
    async function encrypted() {
      let info;
      try { info = await lstat(file); }
      catch (cause) { if (cause.code === 'ENOENT') return null; throw Error('SiteCAD 암호화 파일을 읽지 못했습니다.'); }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('SiteCAD 암호화 파일 형식을 확인해 주세요.');
      const bytes = await readFile(file);
      if (bytes.length < magic.length + 28 || !bytes.subarray(0, magic.length).equals(magic)) {
        throw Error('기존 Electron 암호화 또는 알 수 없는 형식입니다. 원본을 보존하고 SiteCAD Web의 별도 데이터 폴더에서 다시 로그인해 주세요.');
      }
      return bytes;
    }
    async function decrypt(bytes) {
      const key = await masterKey(true);
      try {
        const offset = magic.length;
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(offset, offset + 12));
        decipher.setAAD(Buffer.from(file));
        decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(offset + 28)), decipher.final()]).toString('utf8'));
      } catch { throw Error('SiteCAD 암호화 정보를 열지 못했습니다. 원본 파일을 보존하고 키체인과 데이터 폴더를 확인해 주세요.'); }
    }
    return {
      async read() { const bytes = await encrypted(); return bytes ? decrypt(bytes) : null; },
      async write(value) {
        const prior = await encrypted();
        if (prior) await decrypt(prior);
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 1000000) throw Error('SiteCAD 보관 정보 크기를 확인해 주세요.');
        const key = await masterKey(Boolean(prior));
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(file));
        const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, Buffer.concat([magic, nonce, cipher.getAuthTag(), ciphertext]), { flag: 'wx', mode: 0o600 });
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
      },
      async remove() { await rm(file, { force: true }); },
    };
  }
  return { auth: store('credentials.enc'), mcp: store('mcp-secrets.enc'), references: store('vworld-secrets.enc') };
}
