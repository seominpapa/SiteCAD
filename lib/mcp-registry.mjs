import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = () => Error('외부 MCP 설정을 확인해 주세요.');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const reservedEnv = /^(?:HOME|PATH|ACCESS_TOKEN|CODEX_HOME|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|SITECAD_.*|DYLD_.*|LD_.*)$/;
const nameValid = name => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(name) && !['sitecad', 'research', 'constructor', 'prototype'].includes(name);
const keysOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key));

function checkedEnv(value) {
  if (!plain(value) || Object.keys(value).length > 20) throw fail();
  for (const [key, val] of Object.entries(value)) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || reservedEnv.test(key) || !text(val, 8192)) throw fail();
  return { ...value };
}

function normalize(input, legacyStored = false) {
  if (!plain(input) || !nameValid(input.name)) throw fail();
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw fail();
  const enabledTools = input.enabledTools === undefined ? [] : input.enabledTools;
  if (!Array.isArray(enabledTools) || enabledTools.length > 128 || enabledTools.some(tool => !text(tool, 128) || !/^[a-zA-Z0-9_.-]+$/.test(tool)) || new Set(enabledTools).size !== enabledTools.length) throw fail();
  const common = { name: input.name, enabled: input.enabled ?? true, enabledTools: [...enabledTools] };
  if (input.preset !== undefined) {
    if (!legacyStored || input.preset !== 'rea' || !keysOnly(input, ['name', 'preset', 'enabled', 'enabledTools'])) throw fail();
    return { ...common, preset: 'rea' };
  }
  if (input.transport === 'stdio') {
    if (!keysOnly(input, ['name', 'transport', 'command', 'args', 'env', 'enabled', 'enabledTools']) || !text(input.command, 4096) || !isAbsolute(input.command)) throw fail();
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => !text(arg, 4096)) || JSON.stringify(args).length > 65536) throw fail();
    if (input.env !== undefined) checkedEnv(input.env);
    return { ...common, transport: 'stdio', command: input.command, args: [...args] };
  }
  if (input.transport === 'http') {
    if (!keysOnly(input, ['name', 'transport', 'url', 'bearerToken', 'enabled', 'enabledTools']) || !text(input.url, 4096)) throw fail();
    let url;
    try { url = new URL(input.url); } catch { throw fail(); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw fail();
    if (input.bearerToken !== undefined && (!text(input.bearerToken, 8192) || /\s/.test(input.bearerToken))) throw fail();
    return { ...common, transport: 'http', url: url.href };
  }
  throw fail();
}

function parseStored(value) {
  if (!plain(value) || value.version !== 1 || !keysOnly(value, ['version', 'servers']) || !Array.isArray(value.servers) || value.servers.length > 8) throw fail();
  const servers = value.servers.map(server => {
    if (!plain(server)) throw fail();
    const { envKeys = [], hasBearerToken = false, secretRef, ...input } = server;
    const clean = normalize(input, true);
    if (!Array.isArray(envKeys) || envKeys.length > 20 || envKeys.some(key => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || reservedEnv.test(key)) || typeof hasBearerToken !== 'boolean' || (secretRef !== undefined && !/^[a-f0-9-]{36}$/.test(secretRef))) throw fail();
    if (clean.preset && (secretRef || envKeys.length || hasBearerToken)) throw fail();
    if (Boolean(secretRef) !== Boolean(envKeys.length || hasBearerToken) || (clean.transport === 'stdio' && hasBearerToken) || (clean.transport === 'http' && envKeys.length)) throw fail();
    return { ...clean, envKeys: [...envKeys], hasBearerToken, ...(secretRef ? { secretRef } : {}) };
  });
  if (new Set(servers.map(server => server.name)).size !== servers.length) throw fail();
  return servers;
}

const identity = server => JSON.stringify({ preset: server.preset, transport: server.transport, command: server.command, args: server.args, url: server.url });

export async function createMcpRegistry({ dataDir, nodePath, secretStore }) {
  if (!isAbsolute(dataDir ?? '') || !isAbsolute(nodePath ?? '')) throw fail();
  const file = join(dataDir, 'external-mcp.json');
  let servers = [];
  try {
    const raw = await readFile(file, 'utf8');
    if (raw.length > 128 * 1024) throw fail();
    servers = parseStored(JSON.parse(raw));
  } catch (error) { if (error.code !== 'ENOENT') throw fail(); }
  let pending = Promise.resolve();
  const serialize = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const save = async next => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, servers: next }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    servers = next;
  };
  const readSecrets = async () => {
    if (!secretStore) throw fail();
    const stored = await secretStore.read();
    if (stored !== null && (!plain(stored) || !plain(stored.records))) throw fail();
    return stored?.records ?? {};
  };
  const writeSecrets = async (next, addition = {}) => {
    const records = await readSecrets();
    const refs = new Set(next.map(server => server.secretRef));
    const retained = Object.fromEntries(Object.entries(records).filter(([key]) => refs.has(key)));
    await secretStore.write({ records: { ...retained, ...addition } });
  };
  const visible = server => {
    const { secretRef, ...safe } = server;
    // Preserve old records for removal without reviving a development-only bundled preset.
    if (safe.preset) return { ...safe, enabled: false, status: 'unavailable', unavailableReason: 'bundled-preset-removed' };
    return safe;
  };
  return {
    async list() { await pending; return structuredClone(servers.map(visible)); },
    upsert(input) {
      let clean; let values; let suppliedSecret;
      try {
        clean = normalize(input);
        suppliedSecret = clean.transport === 'stdio' ? input.env !== undefined : input.bearerToken !== undefined;
        values = clean.transport === 'stdio' ? { env: checkedEnv(input.env ?? {}) } : { bearerToken: input.bearerToken || undefined };
      } catch { return Promise.reject(fail()); }
      return serialize(async () => {
        try {
          const previous = servers.find(server => server.name === clean.name);
          if (!previous && servers.length >= 8) throw fail();
          const same = previous && identity(previous) === identity(clean);
          const hasSecret = values.env ? Object.keys(values.env).length > 0 : Boolean(values.bearerToken);
          const secretRef = suppliedSecret && hasSecret ? randomUUID() : (!suppliedSecret && same ? previous.secretRef : undefined);
          const envKeys = suppliedSecret ? Object.keys(values.env ?? {}) : (same ? previous.envKeys : []);
          const hasBearerToken = suppliedSecret ? Boolean(values.bearerToken) : Boolean(same && previous.hasBearerToken);
          const entry = { ...clean, envKeys, hasBearerToken, ...(secretRef ? { secretRef } : {}) };
          const next = previous ? servers.map(server => server.name === clean.name ? entry : server) : [...servers, entry];
          // Keep the old record until the config commit, so a failed write preserves the previous connection.
          if (suppliedSecret && hasSecret) await writeSecrets([...servers, entry], { [secretRef]: values });
          await save(next);
          if (previous?.secretRef && previous.secretRef !== secretRef) await writeSecrets(next);
          return structuredClone(visible(entry));
        } catch { throw fail(); }
      });
    },
    remove(name) {
      if (!nameValid(name)) return Promise.reject(fail());
      return serialize(async () => {
        try {
          const previous = servers.find(server => server.name === name);
          if (!previous) return;
          const next = servers.filter(server => server.name !== name);
          await save(next);
          if (previous.secretRef) await writeSecrets(next);
        } catch { throw fail(); }
      });
    },
    async runtimeServers() {
      await pending;
      try {
        const active = servers.filter(server => server.enabled && !server.preset);
        const secrets = active.some(server => server.secretRef) ? await readSecrets() : {};
        return active.map(server => {
          const { envKeys, hasBearerToken, preset, secretRef, ...runtime } = visible(server);
          const privateValues = server.secretRef ? secrets[server.secretRef] : {};
          if (!plain(privateValues)) throw fail();
          if (runtime.transport === 'stdio') {
            const env = checkedEnv(privateValues.env ?? {});
            if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify([...envKeys].sort())) throw fail();
            return { ...runtime, env };
          }
          if (privateValues.bearerToken !== undefined && (!text(privateValues.bearerToken, 8192) || /\s/.test(privateValues.bearerToken))) throw fail();
          if (Boolean(privateValues.bearerToken) !== hasBearerToken) throw fail();
          return { ...runtime, ...(privateValues.bearerToken ? { bearerToken: privateValues.bearerToken } : {}) };
        });
      } catch { throw fail(); }
    },
  };
}
