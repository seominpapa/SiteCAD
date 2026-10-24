import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createKcscInstaller, kcscFailure } from './kcsc-runtime.mjs';
import { JsonRpcProcess } from './codex-runtime.mjs';
import { isolatedProcessEnv } from './mcp-launcher.mjs';

export const KCSC_QUERY_TOOLS = Object.freeze(['kcsc_search', 'kcsc_outline', 'kcsc_read', 'kcsc_grep', 'kcsc_formula', 'kcsc_audit', 'kcsc_version']);
const validEmpty = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
const queryPolicy = server => Array.isArray(server?.enabledTools) && server.enabledTools.length === KCSC_QUERY_TOOLS.length && KCSC_QUERY_TOOLS.every(name => server.enabledTools.includes(name));
const connectionFailure = () => kcscFailure('KCSC 조회에 실패했습니다. API 키·서비스 권한·네트워크를 확인해 주세요. 기존 등록 정보는 유지했습니다.');

export async function probeKcsc(server, { dataDir, verifyKey = true, signal } = {}) {
  if (signal?.aborted) throw kcscFailure('KCSC 연결 확인을 취소했습니다.');
  const root = join(dataDir, 'mcp-runtime', 'kcsc', 'checks'); await mkdir(root, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(root, 'check-'));
  let rpc;
  const cancel = () => rpc?.fail(kcscFailure('KCSC 연결 확인을 취소했습니다.'));
  try {
    // Each check has an empty cache: a previous valid key cannot make an invalid replacement pass.
    const env = { ...isolatedProcessEnv(home, server.command), ...server.env, HOME: home, KCSC_HOME: home, KCSC_TIMEOUT: '45' };
    const child = spawn(server.command, server.args, { cwd: home, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = new JsonRpcProcess(child, { timeoutMs: 60000, killGroup: process.platform !== 'win32' });
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'SiteCAD KCSC check', version: '1.0.0' } });
    rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await rpc.request('tools/list', {});
    const tools = (result?.tools ?? []).map(tool => tool.name);
    if (tools.length > 128 || tools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(name)) || KCSC_QUERY_TOOLS.some(name => !tools.includes(name))) throw connectionFailure();
    if (verifyKey) {
      const value = await rpc.request('tools/call', { name: 'kcsc_search', arguments: { query: '일반콘크리트', code_type: 'KCS', domain: '전체', limit: 3 } });
      const text = (value?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (value?.isError || !/\|\s*KCS\s*\|\s*142010\s*\|/.test(text) || !text.includes('일반콘크리트')) throw connectionFailure();
    }
    return { tools, verified: verifyKey };
  } catch { throw signal?.aborted ? kcscFailure('KCSC 연결 확인을 취소했습니다.') : connectionFailure(); }
  finally { signal?.removeEventListener('abort', cancel); await rpc?.stop(); await rm(home, { recursive: true, force: true }); }
}

export function createKcscConnection({ dataDir, registry, installer = createKcscInstaller({ dataDir }), probe = probeKcsc, now = () => new Date() } = {}) {
  let lastCheck;
  const status = async () => {
    const server = (await registry.list()).find(item => item.name === 'kcsc');
    const installation = await installer.status();
    const installed = installation.installed;
    const configured = Boolean(server?.envKeys?.includes('KCSC_API_KEY'));
    const managed = server?.command === installation.command && JSON.stringify(server?.args) === JSON.stringify(installation.args) && queryPolicy(server);
    const checked = lastCheck?.ok && lastCheck.revision === await registry.revision('kcsc');
    const tools = checked && configured && managed ? KCSC_QUERY_TOOLS.filter(name => lastCheck.tools.includes(name)) : [];
    return { configured, installed, connected: Boolean(configured && installed && managed && server.enabled && checked), tools, count: tools.length,
      ...(checked ? { advertisedCount: lastCheck.tools.length } : {}),
      ...(lastCheck ? { lastCheck: { ok: lastCheck.ok, checkedAt: lastCheck.checkedAt, message: lastCheck.message } } : {}) };
  };
  const check = async (config, signal) => {
    try {
      const result = await probe(config, { dataDir, verifyKey: true, signal });
      if (!result.verified || KCSC_QUERY_TOOLS.some(name => !result.tools.includes(name))) throw connectionFailure();
      lastCheck = { ok: true, tools: [...result.tools], checkedAt: now().toISOString(), message: 'MCP 도구 목록과 KCSC API의 일반콘크리트 기준을 실제 조회했습니다.' };
    } catch {
      lastCheck = { ok: false, tools: [], checkedAt: now().toISOString(), message: '키·서비스 권한·네트워크를 확인해 주세요.' };
      throw signal?.aborted ? kcscFailure('KCSC 설치·연결을 취소했습니다.') : connectionFailure();
    }
  };
  return {
    status,
    async save(input, { signal } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['apiKey', 'trusted'].includes(key)) || input.trusted !== true || typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(input.apiKey)) throw kcscFailure('KCSC API 키를 입력하고 MCP 설치·실행 및 국가건설기준센터 조회에 동의해 주세요.');
      const previousRevision = await registry.revision('kcsc');
      const installed = await installer.install({ signal });
      const config = { name: 'kcsc', transport: 'stdio', command: installed.command, args: installed.args, enabled: true, enabledTools: [...KCSC_QUERY_TOOLS],
        env: { KCSC_API_KEY: input.apiKey, KCSC_HOME: join(dataDir, 'mcp-runtime', 'kcsc', 'data'), KCSC_DOMAIN: '전체', KCSC_TIMEOUT: '90' } };
      await check(config, signal);
      if (signal?.aborted) throw kcscFailure('KCSC 설치·연결을 취소했습니다.');
      if (previousRevision !== await registry.revision('kcsc')) { lastCheck = undefined; throw kcscFailure('KCSC 설정이 변경되었습니다. 다시 등록해 주세요.'); }
      try { await registry.upsert(config); }
      catch {
        // Registry cleanup can fail after its atomic config commit; confirm the exact new record before reporting failure.
        const committed = await registry.runtimeServers().then(servers => servers.find(server => server.name === 'kcsc')).catch(() => undefined);
        if (!isDeepStrictEqual(committed, config)) { lastCheck = undefined; throw kcscFailure('KCSC 인증정보를 암호화하여 저장하지 못했습니다.'); }
      }
      lastCheck = { ...lastCheck, revision: await registry.revision('kcsc') };
      return status();
    },
    async test(input = {}, { signal } = {}) {
      if (!validEmpty(input)) throw kcscFailure('KCSC 연결 확인 요청을 확인해 주세요.');
      const revision = await registry.revision('kcsc');
      const server = (await registry.runtimeServers()).find(item => item.name === 'kcsc');
      if (!server?.env?.KCSC_API_KEY) throw kcscFailure('먼저 KCSC API 키를 등록해 주세요.');
      const installed = await installer.status();
      if (!installed.installed || server.command !== installed.command || JSON.stringify(server.args) !== JSON.stringify(installed.args) || !queryPolicy(server)) throw kcscFailure('KCSC를 SiteCAD 전용 기준 조회 연결로 다시 등록해 주세요.');
      await check(server, signal);
      if (revision !== await registry.revision('kcsc')) { lastCheck = undefined; throw kcscFailure('KCSC 설정이 변경되었습니다. 다시 확인해 주세요.'); }
      lastCheck = { ...lastCheck, revision }; return status();
    },
    async remove(input = {}) {
      if (!validEmpty(input)) throw kcscFailure('KCSC 연결 삭제 요청을 확인해 주세요.');
      await registry.remove('kcsc'); lastCheck = undefined; return status();
    },
  };
}
