import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAuth } from '../lib/claude-code-auth.mjs';

async function fixture(t, behavior = async () => ({ stdout: '' })) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-claude-auth-'));
  const command = join(dataDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await writeFile(command, 'fixture'); await chmod(command, 0o700);
  const calls = [];
  const auth = createClaudeCodeAuth({ dataDir, claudePath: command, executeImpl: async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === '--help') return { stdout: 'Claude Code - starts an interactive session by default' };
    return behavior(args, options);
  } });
  t.after(async () => { await auth.cancel(); await rm(dataDir, { recursive: true, force: true }); });
  return { auth, calls, dataDir, command };
}

test('official Claude owns isolated subscription login and no tokens enter app state', async t => {
  let loggedIn = false;
  const f = await fixture(t, async args => {
    if (args[1] === 'status') return { stdout: JSON.stringify({ loggedIn, authMethod: 'claude.ai', email: 'private@example.test', subscriptionType: 'max', accessToken: 'do-not-copy' }) };
    if (args[1] === 'login') loggedIn = true;
    if (args[1] === 'logout') loggedIn = false;
    return { stdout: '' };
  });
  assert.equal((await f.auth.status()).loggedIn, false);
  await f.auth.login();
  for (let i = 0; i < 30 && (await f.auth.status()).pending; i++) await new Promise(resolve => setImmediate(resolve));
  const status = await f.auth.status();
  assert.equal(status.loggedIn, true);
  assert.equal(status.available, true);
  assert.doesNotMatch(JSON.stringify(status), /private@example|do-not-copy|accessToken/);
  const config = await f.auth.runtimeOptions();
  assert.equal(config.claudePath, await realpath(f.command));
  assert.equal(config.claudeConfigDir, join(f.dataDir, 'claude-code'));
  assert.ok(f.calls.some(call => call.args.join(' ') === 'auth login --claudeai'));
  for (const call of f.calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.CLAUDE_CONFIG_DIR, join(f.dataDir, 'claude-code'));
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(!call.args.includes('print-credentials'));
  }
  await f.auth.logout();
  assert.equal((await f.auth.status()).loggedIn, false);
});

test('missing CLI reports install guidance, and failed login never exposes stderr', async t => {
  const missing = createClaudeCodeAuth({ dataDir: '/private/tmp/sitecad-no-claude', claudePath: null });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.runtimeOptions(), /Claude Code/);
  const f = await fixture(t, async args => {
    if (args[1] === 'status') return { stdout: '{"loggedIn":false}' };
    throw Error('private-token-from-stderr');
  });
  await f.auth.login();
  for (let i = 0; i < 30 && (await f.auth.status()).pending; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.auth.status()).loggedIn, false);
  assert.doesNotMatch(JSON.stringify(await f.auth.status()), /private-token/);
});

test('foreign API authentication and cancellation do not create a subscription login', async t => {
  const f = await fixture(t, async args => {
    if (args[1] === 'status') return { stdout: '{"loggedIn":true,"authMethod":"api_key"}' };
    return { stdout: '' };
  });
  assert.equal((await f.auth.status()).loggedIn, false);
  await assert.rejects(f.auth.runtimeOptions(), /로그인/);
});

test('cancel during executable discovery prevents a late browser login', async t => {
  let release, entered; const discovered = new Promise(resolve => { entered = resolve; });
  const dataDir = await mkdtemp(join(tmpdir(), 'sitecad-claude-race-'));
  const command = join(dataDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await writeFile(command, 'fixture'); await chmod(command, 0o700);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const auth = createClaudeCodeAuth({ dataDir, claudePath: command, executeImpl: async (_file, args) => {
    calls.push(args);
    if (args[0] === '--help') { entered(); return new Promise(resolve => { release = () => resolve({ stdout: 'Claude Code - starts an interactive session' }); }); }
    return { stdout: '{"loggedIn":false,"authMethod":"none"}' };
  } });
  const login = auth.login(); await discovered; await auth.cancel(); release(); await login;
  assert.equal(calls.some(args => args[1] === 'login'), false);
  assert.equal((await auth.status()).pending, false);
});
