import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { claudeCodeEnv } from './claude-code-auth.mjs';
import { stopProcessTree } from './mcp-launcher.mjs';

export const claudeProtocolFailure = () => Error('Claude Code 응답을 완료하지 못했습니다. 공식 CLI 로그인·모델 사용 권한·네트워크와 도면 상태를 확인해 주세요.');

/** The official CLI owns OAuth and inference; only its documented SDK JSON protocol crosses this boundary. */
export function createClaudeCodeTransport({ config, workspace, systemPrompt, onControl, onMessage, onFailure,
  spawnImpl = spawn, controlTimeoutMs = 60000 }) {
  if (!isAbsolute(config?.claudePath ?? '') || !isAbsolute(config?.claudeConfigDir ?? '') || !isAbsolute(workspace ?? '')) throw claudeProtocolFailure();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--setting-sources=', '--tools', '', '--disable-slash-commands', '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: { sitecad: { type: 'sdk', name: 'sitecad' } } }),
    '--permission-prompt-tool', 'stdio', '--system-prompt', systemPrompt, '--no-chrome'];
  const child = spawnImpl(config.claudePath, args, { cwd: workspace, env: claudeCodeEnv(config.claudePath, config.claudeConfigDir),
    shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', closed = false;
  const failure = () => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(claudeProtocolFailure()); }
    pending.clear();
    onFailure?.(claudeProtocolFailure());
    stopProcessTree(child, 'SIGTERM', { killGroup: true });
    const timer = setTimeout(() => stopProcessTree(child, 'SIGKILL', { killGroup: true }), 1000); timer.unref();
  };
  function write(value) {
    if (closed || child.stdin.destroyed) throw claudeProtocolFailure();
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw Error('첨부 파일과 대화 크기 한도를 초과했습니다.');
    child.stdin.write(line, error => { if (error) failure(); });
  }
  async function receive(value) {
    if (closed) return;
    if (value?.type === 'control_response') {
      const waiter = pending.get(value.response?.request_id);
      if (!waiter) return;
      pending.delete(value.response.request_id); clearTimeout(waiter.timer);
      if (value.response.subtype === 'success') waiter.resolve(value.response.response);
      else waiter.reject(claudeProtocolFailure());
    } else if (value?.type === 'control_request') {
      if (typeof value.request_id !== 'string' || value.request_id.length > 256) throw claudeProtocolFailure();
      try {
        const result = await onControl(value.request);
        if (!closed) write({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id, response: result } });
      } catch {
        if (!closed) write({ type: 'control_response', response: { subtype: 'error', request_id: value.request_id, error: 'SiteCAD refused an invalid or unavailable operation.' } });
      }
    } else await onMessage?.(value);
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (closed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return failure();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { const value = JSON.parse(line); Promise.resolve(receive(value)).catch(failure); }
      catch { failure(); return; }
    }
  });
  child.stderr.on('data', () => { /* CLI diagnostics can contain private account data and are never forwarded. */ });
  child.stdin.on('error', failure); child.on('error', failure); child.on('close', failure);
  function request(request) {
    if (closed) return Promise.reject(claudeProtocolFailure());
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(request_id); reject(claudeProtocolFailure()); failure(); }, controlTimeoutMs);
      pending.set(request_id, { resolve, reject, timer });
      try { write({ type: 'control_request', request_id, request }); }
      catch (error) { clearTimeout(timer); pending.delete(request_id); reject(error); }
    });
  }
  return {
    initialize: () => request({ subtype: 'initialize', hooks: null, skills: [] }),
    setModel: model => request({ subtype: 'set_model', model }),
    user: content => write({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } }),
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(claudeProtocolFailure()); }
      pending.clear();
      stopProcessTree(child, 'SIGTERM', { killGroup: true });
      const timer = setTimeout(() => stopProcessTree(child, 'SIGKILL', { killGroup: true }), 1000); timer.unref();
    },
  };
}
