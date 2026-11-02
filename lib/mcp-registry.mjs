import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const fail = () => Error('외부 MCP 설정을 확인해 주세요.');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const reservedEnv = /^(?:HOME|PATH|ACCESS_TOKEN|CODEX_HOME|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|SHELL|USER|LOGNAME|TMPDIR|TEMP|TMP|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|BASH_ENV|ENV|COMSPEC|PATHEXT|WINDIR|SYSTEMROOT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SITECAD_.*|DYLD_.*|LD_.*)$/;
const nameValid = name => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(name) && !['sitecad', 'research', 'constructor', 'prototype'].includes(name);
const keysOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key));

export function checkedMcpCredentials(value, transport) {
  if (value === undefined) return undefined;
  if (!plain(value) || !keysOnly(value, ['envKeys', 'bearerToken', 'issuanceUrl'])) throw fail();
  const envKeys = value.envKeys ?? [], bearerToken = value.bearerToken ?? false;
  if (!Array.isArray(envKeys) || envKeys.length > 20 || new Set(envKeys).size !== envKeys.length || envKeys.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || reservedEnv.test(key)) || typeof bearerToken !== 'boolean' || !envKeys.length && !bearerToken || (transport === 'stdio' && bearerToken) || (transport === 'http' && envKeys.length)) throw fail();
  let issuanceUrl;
  if (value.issuanceUrl !== undefined) {
    let url; try { url = new URL(value.issuanceUrl); } catch { throw fail(); }
    if (!text(value.issuanceUrl, 2048) || /[\s\x00-\x1f\x7f]/.test(value.issuanceUrl) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(url.hostname)) throw fail();
    issuanceUrl = url.href;
  }
  return { envKeys: [...envKeys], bearerToken, ...(issuanceUrl ? { issuanceUrl } : {}) };
}

const credentialsMissing = server => Boolean(server.credentialRequirements && (server.credentialRequirements.envKeys.some(key => !server.envKeys.includes(key)) || server.credentialRequirements.bearerToken && !server.hasBearerToken));

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
  const credentialRequirements = checkedMcpCredentials(input.credentialRequirements, input.transport);
  const common = { name: input.name, enabled: input.enabled ?? true, enabledTools: [...enabledTools], ...(credentialRequirements ? { credentialRequirements } : {}) };
  if (input.preset !== undefined) {
    if (!legacyStored || input.preset !== 'rea' || !keysOnly(input, ['name', 'preset', 'enabled', 'enabledTools'])) throw fail();
    return { ...common, preset: 'rea' };
  }
  if (input.transport === 'stdio') {
    if (!keysOnly(input, ['name', 'transport', 'command', 'args', 'env', 'enabled', 'enabledTools', 'credentialRequirements']) || !text(input.command, 4096) || !isAbsolute(input.command)) throw fail();
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => !text(arg, 4096)) || JSON.stringify(args).length > 65536) throw fail();
    if (input.env !== undefined) checkedEnv(input.env);
    return { ...common, transport: 'stdio', command: input.command, args: [...args] };
  }
  if (input.transport === 'http') {
    if (!keysOnly(input, ['name', 'transport', 'url', 'bearerToken', 'enabled', 'enabledTools', 'credentialRequirements']) || !text(input.url, 4096)) throw fail();
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
    return safe.credentialRequirements ? { ...safe, credentialsRequired: credentialsMissing(server), ...(credentialsMissing(server) ? { enabled: false, status: 'key_required' } : {}) } : safe;
  };
  const commit = async (clean, values, suppliedSecret) => {
    try {
      const previous = servers.find(server => server.name === clean.name);
      if (!previous && servers.length >= 8) throw fail();
      const same = previous && identity(previous) === identity(clean);
      const hasSecret = values.env ? Object.keys(values.env).length > 0 : Boolean(values.bearerToken);
      const secretRef = suppliedSecret && hasSecret ? randomUUID() : (!suppliedSecret && same ? previous.secretRef : undefined);
      const envKeys = suppliedSecret ? Object.keys(values.env ?? {}) : (same ? previous.envKeys : []);
      const hasBearerToken = suppliedSecret ? Boolean(values.bearerToken) : Boolean(same && previous.hasBearerToken);
      const credentialRequirements = clean.credentialRequirements ?? (same ? previous.credentialRequirements : undefined);
      const entry = { ...clean, ...(credentialRequirements ? { credentialRequirements } : {}), envKeys, hasBearerToken, ...(secretRef ? { secretRef } : {}) };
      const pendingEntry = credentialsMissing(entry) ? { ...entry, enabled: false } : entry;
      const next = previous ? servers.map(server => server.name === clean.name ? pendingEntry : server) : [...servers, pendingEntry];
      // Keep the old record until the config commit, so a failed write preserves the previous connection.
      if (suppliedSecret && hasSecret) await writeSecrets([...servers, pendingEntry], { [secretRef]: values });
      await save(next);
      if (previous?.secretRef && previous.secretRef !== secretRef) await writeSecrets(next);
      return structuredClone(visible(pendingEntry));
    } catch { throw fail(); }
  };
  return {
    async list() { await pending; return structuredClone(servers.map(visible)); },
    // Private change identity includes the opaque secret reference, without unlocking or exposing credentials.
    async revision(name) { await pending; return createHash('sha256').update(JSON.stringify(servers.find(server => server.name === name) ?? null)).digest('hex'); },
    upsert(input) {
      let clean; let values; let suppliedSecret;
      try {
        clean = normalize(input);
        suppliedSecret = clean.transport === 'stdio' ? input.env !== undefined : input.bearerToken !== undefined;
        values = clean.transport === 'stdio' ? { env: checkedEnv(input.env ?? {}) } : { bearerToken: input.bearerToken || undefined };
      } catch { return Promise.reject(fail()); }
      return serialize(() => commit(clean, values, suppliedSecret));
    },
    saveCredentials(input) {
      return serialize(async () => {
        if (!plain(input) || !keysOnly(input, ['name', 'env', 'bearerToken', 'trusted']) || input.trusted !== true || !nameValid(input.name)) throw fail();
        const server = servers.find(item => item.name === input.name), requirement = server?.credentialRequirements;
        if (!server || !requirement) throw fail();
        let values;
        if (server.transport === 'stdio') {
          if (input.bearerToken !== undefined) throw fail();
          const env = checkedEnv(input.env);
          if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify([...requirement.envKeys].sort()) || Object.values(env).some(value => !/^[\x21-\x7e]{1,8192}$/.test(value))) throw fail();
          values = { env };
        } else {
          if (input.env !== undefined || !requirement.bearerToken || typeof input.bearerToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(input.bearerToken)) throw fail();
          values = { bearerToken: input.bearerToken };
        }
        const { envKeys, hasBearerToken, secretRef, ...config } = server;
        return commit({ ...config, enabled: true }, values, true);
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
        const active = servers.filter(server => server.enabled && !server.preset && !credentialsMissing(server));
        const secrets = active.some(server => server.secretRef) ? await readSecrets() : {};
        return active.map(server => {
          const { envKeys, hasBearerToken, preset, secretRef, credentialRequirements, credentialsRequired, status, ...runtime } = visible(server);
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
