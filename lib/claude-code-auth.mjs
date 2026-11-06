import { execFile } from 'node:child_process';
import { access, chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const CLAUDE_CODE_INSTALL_URL = 'https://code.claude.com/docs/en/quickstart';
export const CLAUDE_CODE_NOTICE = '공식 Claude Code가 사용자 본인의 Claude 계정으로 로그인합니다. 지원되는 Claude 구독과 계정 사용 한도가 적용됩니다. API 키 연결은 별도의 API 사용 요금이 적용됩니다. SiteCAD는 구독 토큰을 읽거나 복사하지 않습니다.';
const required = () => Error('공식 Claude Code를 설치하고 설정에서 Claude OAuth 로그인을 완료해 주세요.');

export function claudeCodeEnv(command, configDir, source = process.env) {
  const home = homedir(), windows = process.platform === 'win32';
  const systemRoot = source.SystemRoot || source.SYSTEMROOT || 'C:\\Windows';
  return { HOME: home, LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: configDir,
    PATH: windows ? [dirname(command), join(systemRoot, 'System32'), systemRoot].join(';') : `${dirname(command)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ...(windows ? { SystemRoot: systemRoot, WINDIR: systemRoot, USERPROFILE: home, APPDATA: source.APPDATA || join(home, 'AppData', 'Roaming'), LOCALAPPDATA: source.LOCALAPPDATA || join(home, 'AppData', 'Local'), TEMP: source.TEMP || configDir } : {}),
    ...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

export function createClaudeCodeAuth({ dataDir, claudePath, executeImpl = execute } = {}) {
  if (!isAbsolute(dataDir ?? '') || dataDir.includes('\0')) throw required();
  const configDir = join(dataDir, 'claude-code');
  let pending, failure, generation = 0, finding;
  const identities = new Map();
  async function directory() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if ((await lstat(dataDir)).isSymbolicLink()) throw required();
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const info = await lstat(configDir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(configDir) !== join(await realpath(dataDir), 'claude-code')) throw required();
    await chmod(configDir, 0o700);
  }
  async function findCommand() {
    if (claudePath === null) return null;
    if (finding) return finding;
    finding = (async () => {
      const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
      const standard = process.platform === 'win32' ? [join(homedir(), '.local', 'bin', name)] :
        [join(homedir(), '.local', 'bin', name), join('/opt/homebrew/bin', name), join('/usr/local/bin', name)];
      const pathDirs = String(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).slice(0, 80);
      for (const path of new Set(claudePath === undefined ? [...standard, ...pathDirs.map(path => join(path, name))] : [claudePath])) {
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || process.platform === 'win32' && !/\.exe$/i.test(path)) continue;
        try {
          const command = await realpath(path), info = await stat(command);
          if (!info.isFile()) continue;
          await access(command, constants.X_OK);
          const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          const cached = identities.get(command);
          if (cached?.signature === signature) { if (cached.official) return command; continue; }
          const result = await executeImpl(command, ['--help'], { env: claudeCodeEnv(command, configDir), shell: false, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
          const official = /Claude Code - starts an interactive session/i.test(result.stdout ?? '');
          identities.set(command, { signature, official });
          if (official) return command;
        } catch { /* Continue through installed native CLI candidates. */ }
      }
      return null;
    })();
    try { return await finding; } finally { finding = undefined; }
  }
  async function run(args, { signal, timeout = 15000 } = {}) {
    const command = await findCommand();
    if (!command) throw required();
    await directory();
    if (signal?.aborted) throw required();
    return executeImpl(command, args, { cwd: configDir, env: claudeCodeEnv(command, configDir), shell: false, windowsHide: true, timeout, maxBuffer: 128 * 1024, ...(signal ? { signal } : {}) });
  }
  async function status() {
    const available = Boolean(await findCommand());
    let loggedIn = false;
    const profileExists = await lstat(configDir).then(info => info.isDirectory() && !info.isSymbolicLink()).catch(() => false);
    if (available && profileExists) {
      try {
        let result;
        try { result = await run(['auth', 'status', '--json']); } catch (error) { result = { stdout: error.stdout }; }
        const value = JSON.parse(result.stdout ?? '');
        loggedIn = value?.loggedIn === true && ['claude.ai', 'oauth'].includes(value.authMethod);
      } catch { /* Authentication details remain owned by the official CLI. */ }
    }
    return { available, loggedIn, pending: Boolean(pending), installUrl: CLAUDE_CODE_INSTALL_URL, notice: CLAUDE_CODE_NOTICE, ...(failure ? { error: failure } : {}) };
  }
  const cancel = async () => { generation++; const previous = pending; pending = undefined; previous?.controller.abort(); await previous?.task; };
  return {
    status, cancel,
    async runtimeOptions() {
      if (!(await status()).loggedIn) throw required();
      return { claudePath: await findCommand(), claudeConfigDir: configDir };
    },
    async login() {
      const epoch = generation;
      if (pending) return { ...await status(), pending: true };
      if (!await findCommand()) return { ...await status(), actionNeeded: 'install-claude-code', message: '공식 Claude Code를 설치한 뒤 OAuth 로그인을 다시 눌러 주세요.' };
      if (epoch !== generation) return status();
      if (pending) return { ...await status(), pending: true };
      const controller = new AbortController(), attempt = { controller };
      pending = attempt; failure = undefined;
      attempt.task = (async () => {
        try { await run(['auth', 'login', '--claudeai'], { signal: controller.signal, timeout: 300000 }); }
        catch { if (epoch === generation && !controller.signal.aborted) failure = 'Claude Code 로그인을 완료하지 못했습니다. 공식 CLI 설치·브라우저·계정 사용 권한을 확인해 주세요.'; }
        finally { if (pending === attempt) pending = undefined; }
      })();
      return { ...await status(), pending: true };
    },
    async logout() {
      await cancel();
      if (!await findCommand()) throw required();
      try { await run(['auth', 'logout']); failure = undefined; }
      catch { throw Error('Claude Code 로그아웃을 완료하지 못했습니다. 앱 전용 인증 프로필은 보존되어 있습니다.'); }
    },
  };
}
