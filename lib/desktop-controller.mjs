import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChat, validatePlan } from './plan.mjs';
import { createMcpRegistry } from './mcp-registry.mjs';
import { createWebReference } from './web-reference.mjs';
import { createResearch, researchTools } from './research-mcp.mjs';
import { createReferenceConnections } from './reference-connections.mjs';
import { projectParcels } from './parcel-projection.mjs';
import { projectTerrain } from './terrain-projection.mjs';
import { createTerrainData } from './terrain-data.mjs';
import { importTerrainUpload } from './terrain-upload.mjs';
import { createAgentUtilities } from './agent-utilities.mjs';
import { siteRequest, siteArea, publicTerrainSource } from './site-source.mjs';
import { validateDiscoverRequest, validateQueryRequest, validateControlRequest } from '../public/control-schema.js';
import { parseGeoReference } from '../public/geo-reference.js';

function checkedContext(value) {
  const context = { documentId: value?.documentId, revision: value?.revision,
    units: value?.units, selection: value?.selection, entities: value?.entities ?? [],
    ...(value?.geometryRevision !== undefined ? { geometryRevision:value.geometryRevision } : {}),
    ...(value?.layout !== undefined ? { layout:value.layout } : {}) };
  try { validateChat({ message: '도면 확인', context, history: [] }); }
  catch { throw Error('도면 상태를 다시 확인해 주세요.'); }
  if (value?.command !== undefined) {
    const bounded = (item, depth = 0) => {
      if (depth > 5) return false;
      if (item === null || typeof item === 'boolean') return true;
      if (typeof item === 'number') return Number.isFinite(item);
      if (typeof item === 'string') return item.length <= 4000;
      if (Array.isArray(item)) return item.length <= 100 && item.every(child => bounded(child, depth + 1));
      return item && typeof item === 'object' && Object.keys(item).length <= 30 && Object.entries(item).every(([key, child]) => key.length <= 60 && !['__proto__', 'constructor', 'prototype'].includes(key) && bounded(child, depth + 1));
    };
    if (value.command !== null && (typeof value.command?.name !== 'string' || !value.command.name || value.command.name.length > 100 || !bounded(value.command) || JSON.stringify(value.command).length > 16000)) throw Error('도면 상태를 다시 확인해 주세요.');
    return { ...context, command: structuredClone(value.command) };
  }
  return context;
}

function checkedName(name) {
  if (typeof name !== 'string' || name.length > 120 || !name.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(name) || !/\.dwg$/i.test(name)) {
    throw Error('저장 이름은 경로를 제외한 .dwg 파일명이어야 합니다.');
  }
  return name;
}

function checkedSaveContext(result, expected) {
  const before = checkedContext(expected), after = checkedContext(result?.context);
  if (['documentId', 'units', 'geometryRevision', 'layout'].some(key => before[key] !== undefined && after[key] !== before[key]) ||
    JSON.stringify(after.selection) !== JSON.stringify(before.selection) || after.revision < before.revision || after.command) {
    throw Error('저장 결과와 요청 도면 상태가 일치하지 않습니다. 도면 변경과 미저장 상태를 확인해 주세요.');
  }
}

export async function createDesktopController({ dataDir, codexPath, nodePath, nodeEnv = {},
  secureStore, mcpSecretStore, referenceSecretStore, referenceApiFactory, terrainData, selectTerrainFile, agentUtilities, reaSource, modelCatalogPath, webReference = createWebReference(), openExternal, authFactory, runtimeFactory, bridgeTimeoutMs = 45000 } = {}) {
  authFactory ??= (await import('./desktop-auth.mjs')).createDesktopAuth;
  runtimeFactory ??= (await import('./codex-runtime.mjs')).createCodexRuntime;
  const auth = await authFactory({ store: secureStore, openExternal });
  const registry = await createMcpRegistry({ dataDir, nodePath, nodeEnv, secretStore: mcpSecretStore, reaSource });
  const references = createReferenceConnections({ store: referenceSecretStore, ...(referenceApiFactory ? { apiFactory: referenceApiFactory } : {}) });
  const terrain = terrainData ?? await createTerrainData({ dataDir, selectFile: selectTerrainFile });
  const utilities = agentUtilities ?? createAgentUtilities({ dataDir });
  let turnAbort;
  let utilityCalls = 0;
  let controlAttempted = false;
  const bridgeToken = randomBytes(32).toString('hex');
  const jobs = new Map();
  const queue = [];
  let waiter;
  let runtime;
  let baseUrl;
  let active = false;
  let closed = false;
  let turnContext;
  let generation = 0;
  let turnResults = [];
  let lastEvent = '';
  let changingMcp = false;
  let research;
  let insertedSources = new Set();
  const approvals = new Map();
  const paths = { codexHome: join(dataDir, 'codex-home'), workspace: join(dataDir, 'workspace'), drawings: join(dataDir, 'Drawings') };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });

  function rejectJobs(message) {
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(Error(message)); }
    jobs.clear(); queue.splice(0);
    waiter?.(null); waiter = undefined;
    for (const item of approvals.values()) { clearTimeout(item.timer); item.resolve('deny'); }
    approvals.clear();
  }
  function onApproval(request) {
    if (!active || !turnContext || closed || approvals.size >= 4) return Promise.resolve('deny');
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { approvals.delete(id); resolve('deny'); }, 90000);
      approvals.set(id, { ...structuredClone(request), id, expiresAt: Date.now() + 90000, timer, resolve });
    });
  }
  function resolveApproval({ id, approved } = {}) {
    const item = approvals.get(id);
    if (!item || typeof approved !== 'boolean') throw Error('실행 승인이 만료되었습니다.');
    approvals.delete(id); clearTimeout(item.timer); item.resolve(approved ? 'approve' : 'deny');
    return { resolved: true };
  }
  async function mcpList() {
    const statuses = runtime ? await runtime.getMcpStatus?.().catch(() => []) ?? [] : [];
    const servers = (await registry.list()).map(server => {
      const status = statuses.find(item => item.name === server.name);
      return { ...server, ...(status ?? {}), connected: status?.status === 'connected' || status?.status === 'ready' };
    });
    return { servers, presets: { rea: { name: 'rea', preset: 'rea' } },
      ...(reaSource ? { presetDetails: { rea: { command: nodePath, args: [join(reaSource, 'scripts/rea.mjs'), 'mcp'] } } } : {}) };
  }
  async function changeMcp(operation) {
    if (active || changingMcp) throw Error('진행 중인 작업이 끝난 뒤 MCP 설정을 변경해 주세요.');
    changingMcp = true;
    try { await operation(); await runtime?.stop(); runtime = undefined; return await mcpList(); }
    finally { changingMcp = false; }
  }
  async function ensureRuntime() {
    if (runtime) return runtime;
    if (!baseUrl || closed) throw Error('SiteCAD 실행 환경을 준비해 주세요.');
    const epoch = generation;
    const next = await runtimeFactory({ codexPath, nodePath, nodeEnv,
      codexHome: paths.codexHome, workspace: paths.workspace,
      mcpPath: fileURLToPath(new URL('./sitecad-mcp.mjs', import.meta.url)),
      bridgeUrl: baseUrl, bridgeToken, getAccessToken: () => auth.getAccessToken(),
      externalServers: await registry.runtimeServers(), researchTools, onApproval, ...(modelCatalogPath ? { modelCatalogPath } : {}),
      onEvent: event => { lastEvent = String(event?.type ?? event?.method ?? '').slice(0, 120); } });
    if (epoch !== generation || closed) { await next.stop(); throw Error('작업을 취소했습니다.'); }
    runtime = next;
    try {
      await next.start();
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      return next;
    } catch (error) { await next.stop().catch(() => {}); if (runtime === next) runtime = undefined; throw error; }
  }
  async function pollCad({ waitMs = 15000 } = {}) {
    if (queue.length) return queue.shift();
    if (closed || waitMs <= 0) return null;
    if (waiter) throw Error('이미 도면 연결을 확인하고 있습니다.');
    return new Promise(resolve => {
      const timer = setTimeout(() => { waiter = undefined; resolve(null); }, Math.min(waitMs, 15000));
      waiter = value => { clearTimeout(timer); waiter = undefined; resolve(value); };
    });
  }
  async function enqueue(method, payload) {
    if (closed || jobs.size >= 4) throw Error('도면 작업을 잠시 후 다시 요청해 주세요.');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const job = { id, method, payload };
      const timer = setTimeout(() => {
        jobs.delete(id);
        const index = queue.findIndex(item => item.id === id);
        if (index >= 0) queue.splice(index, 1);
        reject(Error('도면 응답 시간이 초과되었습니다. 편집기 연결을 확인해 주세요.'));
      }, bridgeTimeoutMs);
      jobs.set(id, { resolve, reject, timer });
      if (waiter) waiter(job); else queue.push(job);
    });
  }
  async function saveBytes(result, name) {
    if (result?.audit?.errors !== 0 || result.audit.droppedOnSave !== 0) throw Error('DWG 저장 감사 결과를 확인하지 못했습니다.');
    if (typeof result?.dataBase64 !== 'string' || result.dataBase64.length > 42 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.dataBase64)) throw Error('저장된 DWG 데이터를 확인하지 못했습니다.');
    const bytes = Buffer.from(result.dataBase64, 'base64');
    if (!/^AC10\d\d$/.test(result.version) || bytes.length < 6 || bytes.length > 30 * 1024 * 1024 ||
      bytes.subarray(0, 6).toString() !== result.version) throw Error('저장된 DWG 버전을 확인하지 못했습니다.');
    const context = checkedContext(result.context);
    if (result.georeferences !== undefined && (!Array.isArray(result.georeferences) || result.georeferences.length > 100)) throw Error('공간 기준 정보를 확인하지 못했습니다.');
    const georeferences = (result.georeferences ?? []).map(value => {
      const metadata = parseGeoReference(value);
      if (!metadata || metadata.units !== context.units) throw Error('공간 기준 정보와 도면 단위가 다릅니다.');
      return metadata;
    });
    let path = join(paths.drawings, name);
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw Error('DWG 파일을 저장하지 못했습니다.');
      path = join(paths.drawings, `${name.slice(0, -4)}-${randomUUID().slice(0, 8)}.dwg`);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let metadataPath;
    let metadataWarning;
    if (georeferences.length) {
      try {
        metadataPath = `${path}.sitecad.json`;
        await writeFile(metadataPath, JSON.stringify({ version: 1, dwgSha256: sha256, georeferences }, null, 2), { flag: 'wx', mode: 0o600 });
      } catch { metadataPath = undefined; metadataWarning = 'DWG는 저장됐지만 공간 정보 보조 파일을 저장하지 못했습니다. 기준 정보는 DWG 내부에도 보존됩니다.'; }
    }
    return { path, name: path.split('/').pop(), downloadUrl: `/api/local/drawings/${encodeURIComponent(path.split('/').pop())}`, bytes: bytes.length, version: result.version,
      sha256, audit: result.audit, context, ...(metadataPath ? { metadataPath } : {}), ...(metadataWarning ? { metadataWarning } : {}) };
  }
  async function callCad(method, payload = {}) {
    if (method === 'prepare_site') {
      const input = siteRequest(payload);
      if (!active || !turnContext || !research || !turnAbort || turnAbort.signal.aborted) throw Error('진행 중인 채팅에서만 주소 자료를 준비할 수 있습니다.');
      const epoch = generation;
      const context = await callCad('context');
      const anchor = await enqueue('parcel_context', { expectedContext: context });
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      const current = checkedContext(anchor?.context);
      if (JSON.stringify(current) !== JSON.stringify(context)) throw Error('자료 준비 전 도면이 변경되었습니다.');
      const unavailable = message => ({ status: 'unavailable', message });
      if (context.units === 0) return unavailable('먼저 도면 단위를 지정해 주세요.');
      if (context.entities.length && !parseGeoReference(anchor.georeference)) return unavailable('기존 도면의 위치 기준을 확인할 수 없습니다. 새 도면에서 주소를 입력하거나 먼저 위치 기준을 확인해 주세요.');
      let geocoded;
      try { geocoded = await callCad('geocode', { address: input.address, type: 'ROAD' }); }
      catch (error) {
        if (epoch !== generation || closed || error.message !== '해당 주소의 좌표를 찾지 못했습니다.') throw error;
        geocoded = await callCad('geocode', { address: input.address, type: 'PARCEL' });
      }
      const bbox = siteArea(geocoded, input.radius_m), provider = publicTerrainSource(geocoded, bbox);
      if (!provider.supported) return unavailable(provider.message);
      const parcels = await callCad('parcels', { bbox, maxFeatures: 100 });
      if (!parcels.features?.length) return unavailable('주소 주변에서 필지 경계를 찾지 못했습니다. 도면은 변경하지 않았습니다.');
      const datasets = await terrain.list();
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      let dataset = datasets.find(item => item.sourceKind === 'public-download' && item.sourceUrl === provider.url);
      const reused = Boolean(dataset);
      if (!dataset) {
        const download = await callCad('download', { url: provider.url, name: provider.fileName });
        dataset = await callCad('terrain_register', { downloadId: download.id });
      }
      let source;
      try { source = await callCad('terrain_query', { bbox, datasetId: dataset.id, maxFeatures: 100 }); }
      catch (error) {
        if (epoch !== generation || closed || error.message !== '해당 영역에 등록된 지형 자료가 없습니다.') throw error;
        return unavailable('주소 주변의 공개 원본에 등고선·표고가 없습니다. 도면은 변경하지 않았습니다.');
      }
      if (!source.features?.length) return unavailable('주소 주변의 공개 원본에 등고선·표고가 없습니다. 도면은 변경하지 않았습니다.');
      const parcelPlan = projectParcels(parcels, { units: context.units, georeference: anchor.georeference });
      projectTerrain(source, { units: context.units, georeference: parcelPlan.metadata });
      const value = { status: 'ready', address: geocoded.address, point: geocoded.point, bbox, radius_m: input.radius_m,
        parcelSourceId: parcels.id, terrainSourceId: source.id,
        parcels: { featureCount: parcels.features.length, possiblyTruncated: parcels.possiblyTruncated === true },
        terrain: { datasetId: dataset.id, featureCount: source.features.length, possiblyTruncated: source.possiblyTruncated === true,
          sourceUrl: source.sourceUrl, sourceSha256: source.sourceSha256, verticalDatum: provider.verticalDatum, unitAssumption: provider.unitAssumption },
        download: { reused }, saveName: `sitecad-address-${new Date().toISOString().slice(0, 10)}.dwg` };
      turnResults.push({ method, data: { ...value, message: '주소 주변 필지와 공개 지형을 확보하고 좌표 변환·삽입 한도를 확인했습니다.' } });
      return structuredClone(value);
    }
    if (method === 'terrain_register') {
      if (!active || !turnContext || !turnAbort || turnAbort.signal.aborted) throw Error('진행 중인 채팅에서만 지형 자료를 등록할 수 있습니다.');
      if (!payload || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.downloadId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(payload.downloadId)) throw Error('현재 채팅의 다운로드 ID를 확인해 주세요.');
      const download = turnResults.find(item => item.method === 'download' && item.data.id === payload.downloadId);
      if (!download) throw Error('현재 채팅에서 성공한 다운로드만 지형 원본으로 등록할 수 있습니다.');
      if (++utilityCalls > 20) throw Error('한 요청에서 자료 처리·계산은 최대 20회까지 실행할 수 있습니다.');
      const epoch = generation;
      const value = await terrain.registerDownload(structuredClone(download.data), { signal: turnAbort.signal });
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      turnResults.push({ method, data: { ...value, message: '다운로드한 GeoJSON 지형 원본을 검증하고 등록했습니다.' } });
      return value;
    }
    if (['download', 'calculate'].includes(method)) {
      if (!active || !turnContext || !turnAbort || turnAbort.signal.aborted) throw Error('진행 중인 채팅에서만 자료 다운로드와 계산을 실행할 수 있습니다.');
      if (++utilityCalls > 20) throw Error('한 요청에서 계산·다운로드는 최대 20회까지 실행할 수 있습니다.');
      const epoch = generation;
      const value = method === 'download' ? await utilities.download(payload, { signal: turnAbort.signal }) : utilities.calculate(payload);
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      turnResults.push({ method, data: value });
      return value;
    }
    if (['discover', 'query', 'control'].includes(method)) {
      if (!active || !turnContext) throw Error('진행 중인 채팅에서만 CAD 도구를 실행할 수 있습니다.');
      if (method === 'control') controlAttempted = true;
      if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key=>!['request','expectedContext'].includes(key))) throw Error('CAD 입력을 확인해 주세요.');
      const validate = { discover: validateDiscoverRequest, query: validateQueryRequest, control: validateControlRequest }[method];
      const request = validate(payload.request);
      let expectedContext;
      if (method !== 'discover') {
        expectedContext = checkedContext(payload.expectedContext);
        if (turnContext.documentId !== expectedContext.documentId || turnContext.units !== expectedContext.units) throw Error('작업 중 도면 또는 단위가 변경되었습니다.');
      }
      const epoch = generation;
      const value = await enqueue(method, { request, ...(expectedContext ? { expectedContext } : {}) });
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      const after = checkedContext(value?.context);
      if (after.documentId !== turnContext.documentId || after.units !== turnContext.units) throw Error('작업 중 도면 또는 단위가 변경되었습니다. 이미 반영된 도면을 확인해 주세요.');
      if (method === 'control') turnResults.push({ method, data: value });
      return value;
    }
    if (['fetch', 'design', 'geocode', 'parcels', 'terrain_sources', 'terrain_query'].includes(method)) {
      if (!active || !turnContext || !research) throw Error('진행 중인 채팅에서만 자료를 조회할 수 있습니다.');
      const epoch = generation;
      const value = await research.call(method, payload);
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      return value;
    }
    if (['insert_parcels', 'insert_terrain'].includes(method)) {
      if (!active || !turnContext || !research) throw Error('진행 중인 채팅에서만 필지를 삽입할 수 있습니다.');
      if (!payload || Object.keys(payload).some(key => !['sourceId', 'x_mm', 'y_mm', 'expectedContext'].includes(key)) ||
        typeof payload.sourceId !== 'string' || ['x_mm', 'y_mm'].some(key => Object.hasOwn(payload, key) && (!Number.isFinite(payload[key]) || Math.abs(payload[key]) > 1e8))) throw Error('필지 삽입 입력을 확인해 주세요.');
      const source = method === 'insert_terrain' ? research.terrainSource(payload.sourceId) : research.parcelSource(payload.sourceId);
      if (insertedSources.has(source.id)) throw Error('이미 삽입을 요청한 필지 출처입니다. 도면 결과를 확인해 주세요.');
      const expectedContext = checkedContext(payload.expectedContext);
      if (turnContext.documentId !== expectedContext.documentId || turnContext.units !== expectedContext.units) throw Error('작업 중 도면 또는 단위가 변경되었습니다.');
      const epoch = generation;
      const anchor = await enqueue('parcel_context', { expectedContext });
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      const current = checkedContext(anchor?.context);
      if (['documentId', 'revision', 'units'].some(key => current[key] !== expectedContext[key]) || JSON.stringify(current.selection) !== JSON.stringify(expectedContext.selection)) throw Error('필지 삽입 전 도면이 변경되었습니다.');
      const plan = (method === 'insert_terrain' ? projectTerrain : projectParcels)(source, { units: current.units, georeference: anchor.georeference,
        ...(Object.hasOwn(payload, 'x_mm') ? { x_mm: payload.x_mm } : {}), ...(Object.hasOwn(payload, 'y_mm') ? { y_mm: payload.y_mm } : {}) });
      insertedSources.add(source.id);
      const result = await enqueue(method, { expectedContext, plan });
      if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
      const after = checkedContext(result?.context);
      if (after.documentId !== current.documentId || after.units !== current.units || after.revision <= current.revision || JSON.stringify(parseGeoReference(result.georeference)) !== JSON.stringify(plan.metadata)) throw Error('필지 삽입 결과를 확인하지 못했습니다. 이미 반영된 도면을 확인해 주세요.');
      turnResults.push({ method, data: result });
      return result;
    }
    if (!['context', 'execute', 'save'].includes(method)) throw Error('허용되지 않은 도면 도구입니다.');
    let input = {};
    const epoch = generation;
    if (method !== 'context') {
      if (!active || !turnContext) throw Error('진행 중인 채팅에서만 도면을 변경할 수 있습니다.');
      const expectedContext = checkedContext(payload.expectedContext);
      if (turnContext && (turnContext.documentId !== expectedContext.documentId || turnContext.units !== expectedContext.units)) {
        throw Error('작업 중 도면 또는 단위가 변경되었습니다. 다시 요청해 주세요.');
      }
      if (method === 'execute') {
        const { operations } = validatePlan({ reply: '도면 작업', operations: payload.operations });
        input = { operations, expectedContext };
      } else input = { name: checkedName(payload.name), expectedContext };
    }
    const result = await enqueue(method, input);
    if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
    if (method === 'context') {
      const context = checkedContext(result);
      if (turnContext && (turnContext.documentId !== context.documentId || turnContext.units !== context.units)) throw Error('작업 중 도면이 변경되었습니다.');
      return context;
    }
    const after = checkedContext(result?.context);
    if (method === 'save') checkedSaveContext(result, input.expectedContext);
    const data = method === 'save' ? await saveBytes(result, input.name) : result;
    turnResults.push({ method, data });
    return data;
  }
  function completeCad(id, result, error) {
    const job = jobs.get(id);
    if (!job) throw Error('도면 요청이 만료되었습니다.');
    jobs.delete(id); clearTimeout(job.timer);
    if (error) job.reject(Error(typeof error === 'string' ? error.slice(0, 500) : '도면 작업에 실패했습니다.'));
    else job.resolve(result);
  }
  async function cancel() {
    generation++; turnAbort?.abort();
    turnContext = undefined;
    rejectJobs('사용자가 작업을 취소했습니다. 이미 반영된 도면 변경은 실행 취소로 되돌릴 수 있습니다.');
    await runtime?.cancel();
    await runtime?.stop(); runtime = undefined;
    await auth.cancel?.();
  }
  return {
    async start(options) { baseUrl = options.baseUrl; if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw Error('로컬 서버 주소가 필요합니다.'); },
    async status() {
      const status = await auth.status();
      return { desktop: true, oauth: { connected: status.loggedIn === true && status.sharing !== false, method: 'chatgpt' },
        auth: status, runtime: runtime?.status() ?? { connected: false }, active, event: lastEvent, drawingsPath: paths.drawings,
        approvals: [...approvals.values()].map(({ timer, resolve, ...item }) => item) };
    },
    login: () => auth.login(),
    async logout() { await cancel(); await runtime?.stop(); runtime = undefined; await auth.logout(); },
    async chat(input) {
      validateChat(input);
      if (active || changingMcp) throw Error('진행 중인 작업이 끝난 뒤 다시 요청해 주세요.');
      active = true; turnContext = input.context; turnResults = []; insertedSources = new Set(); turnAbort = new AbortController(); utilityCalls = 0; controlAttempted = false;
      research = createResearch({ fetchDocument: value => webReference.fetchDocument(value), geocode: value => references.api.geocode(value), parcels: value => references.api.parcels(value), terrainSources: async () => ({ datasets: await terrain.list() }), terrainQuery: value => terrain.query(value) });
      const epoch = generation;
      try {
        const engine = await ensureRuntime();
        if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
        const result = await engine.chat(input);
        if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
        if (controlAttempted) {
          let state;
          try { state = await enqueue('completion_state', {}); }
          catch { throw Error('최종 도면 상태를 확인하지 못해 작업 완료로 처리하지 않았습니다. 일부 변경과 미저장 상태를 확인해 주세요.'); }
          if (epoch !== generation || closed) throw Error('작업을 취소했습니다.');
          if (state?.documentId !== turnContext.documentId || state?.units !== turnContext.units ||
            ['command', 'modal', 'textEditor', 'mtextEditor'].some(key => !Object.hasOwn(state, key) || state[key] !== null)) {
            throw Error('도면이 변경되었거나 명령 입력이 남아 작업 완료로 처리하지 않았습니다. 일부 변경과 미저장 상태를 확인해 주세요.');
          }
        }
        const reports = turnResults.flatMap(item => item.data.reports ?? []);
        const details = turnResults.map(item => ({ tool: item.method, message: item.data.message,
          ...(['save','download'].includes(item.method) ? { path: item.data.path, bytes: item.data.bytes, sha256: item.data.sha256, audit: item.data.audit, ...(item.data.metadataPath ? { metadataPath: item.data.metadataPath } : {}), ...(item.data.metadataWarning ? { metadataWarning: item.data.metadataWarning } : {}) } : item.method === 'calculate' ? { calculations: item.data.results, variables: item.data.variables, angleUnit: item.data.angleUnit } : { operations: item.data.details }) }));
        const evidence = research.report();
        const sources = [...evidence.sources, ...turnResults.filter(item=>item.method==='download').map(({data})=>({ id:data.id,title:data.name,kind:'download',url:data.url,bytes:data.bytes,sha256:data.sha256,retrievedAt:data.retrievedAt,limitation:'다운로드 원본입니다. 지형 검증·등록·도면 삽입 여부는 각 도구 결과를 확인해야 합니다.' })), ...(result.sources ?? []).filter(source => !evidence.sources.some(read => read.url === source.url)).map(source => ({ ...source, id: `search-${randomUUID().slice(0, 12)}`, kind: 'search' }))];
        const savedFiles = turnResults.filter(item => item.method === 'save').map(({ data }) => ({ name: data.name, bytes: data.bytes, sha256: data.sha256, downloadUrl: data.downloadUrl }));
        return { ...result, details, reports, ...evidence, sources, savedFiles, toolCalls: result.details ?? [], executed: true };
      }
      finally { generation++; turnAbort?.abort(); turnAbort = undefined; rejectJobs('도면 작업이 종료되었습니다.'); active = false; turnContext = undefined; }
    },
    callCad, pollCad, completeCad,
    async saveDrawing(result, name, expectedContext) {
      if (active || changingMcp || closed) throw Error('진행 중인 작업이 끝난 뒤 도면을 저장해 주세요.');
      checkedSaveContext(result, expectedContext);
      return saveBytes(result, checkedName(name));
    },
    async readDrawing(name) {
      const path = join(paths.drawings, checkedName(name));
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 30 * 1024 * 1024 || await realpath(path) !== join(await realpath(paths.drawings), name)) throw Error('도면 파일을 확인해 주세요.');
      const bytes = await readFile(path);
      return { bytes, name, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    claimCad: id => ({ valid: !closed && active && Boolean(turnContext) && typeof id === 'string' && id.length <= 100 && jobs.has(id) }), cancel, mcpList, resolveApproval,
    mcpSave({ config, trusted } = {}) {
      if (trusted !== true) return Promise.reject(Error('MCP 실행 권한을 확인하고 신뢰 등록에 동의해 주세요.'));
      return changeMcp(async () => {
        if (config?.mcpServers) {
          const entries = Object.entries(config.mcpServers);
          if (Object.keys(config).length !== 1 || entries.length !== 1) throw Error('한 번에 MCP 서버 하나를 등록해 주세요.');
          const [name, value] = entries[0];
          config = { ...value, name, transport: value.url ? 'http' : 'stdio' };
        }
        if (config?.headers !== undefined) {
          const entries = Object.entries(config.headers ?? {});
          if (entries.length !== 1 || entries[0][0].toLowerCase() !== 'authorization' || typeof entries[0][1] !== 'string' || !/^Bearer \S+$/.test(entries[0][1]) || config.bearerToken !== undefined) throw Error('HTTP MCP 인증은 Authorization: Bearer 형식만 지원합니다.');
          const { headers, ...rest } = config;
          config = { ...rest, bearerToken: entries[0][1].slice(7) };
        }
        await registry.upsert(config);
      });
    },
    mcpToggle({ name, enabled } = {}) {
      return changeMcp(async () => {
        const server = (await registry.list()).find(item => item.name === name);
        if (!server || typeof enabled !== 'boolean') throw Error('MCP 설정을 확인해 주세요.');
        const { envKeys, hasBearerToken, command, args, transport, ...rest } = server;
        await registry.upsert(server.preset ? { name, preset: server.preset, enabled, enabledTools: server.enabledTools } : { ...rest, ...(transport === 'stdio' ? { command, args } : {}), transport, enabled });
      });
    },
    mcpRemove: ({ name } = {}) => changeMcp(() => registry.remove(name)),
    referencesStatus: () => references.status(),
    terrainStatus: async () => ({ datasets: await terrain.list() }),
    async terrainImport(files) {
      if (active || changingMcp) throw Error('진행 중인 작업이 끝난 뒤 지형 원본을 등록해 주세요.');
      changingMcp = true;
      try {
        const dataset = files === undefined ? await terrain.importFile() : await importTerrainUpload({ dataDir, files, importFile: path => terrain.importFile(path) });
        return dataset ? { dataset, datasets: await terrain.list() } : { cancelled: true };
      } finally { changingMcp = false; }
    },
    async referencesSave(input) {
      if (active || changingMcp) throw Error('진행 중인 작업이 끝난 뒤 API 설정을 변경해 주세요.');
      changingMcp = true;
      try { return await references.save(input); } finally { changingMcp = false; }
    },
    async referencesRemove() {
      if (active || changingMcp) throw Error('진행 중인 작업이 끝난 뒤 API 설정을 변경해 주세요.');
      changingMcp = true;
      try { return await references.remove(); } finally { changingMcp = false; }
    },
    async referencesTest() {
      if (active || changingMcp) throw Error('진행 중인 작업이 끝난 뒤 연결을 확인해 주세요.');
      changingMcp = true;
      try { return await references.test(); } finally { changingMcp = false; }
    },
    async mcpTest({ name } = {}) {
      if (active || changingMcp || !(await registry.list()).some(server => server.name === name && server.enabled)) throw Error('활성화한 MCP를 작업 종료 후 확인해 주세요.');
      changingMcp = true;
      try { const engine = await ensureRuntime(); return await engine.testExternal(name); }
      finally { changingMcp = false; }
    },
    authorizeMcp(value) {
      const expected = Buffer.from(`Bearer ${bridgeToken}`);
      const actual = Buffer.from(typeof value === 'string' ? value : '');
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
    async close() { closed = true; generation++; turnAbort?.abort(); rejectJobs('SiteCAD가 종료되었습니다.'); await runtime?.stop(); await auth.close(); }
  };
}
