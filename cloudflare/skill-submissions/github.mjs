const api = 'https://api.github.com';
const fail = () => Error('GitHub 연결을 확인하지 못했습니다.');
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export async function limitedBytes(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw Error('응답 용량이 너무 큽니다.');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maximum) throw Error('응답 용량이 너무 큽니다.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function requestJson(fetcher, url, init = {}, maximum = 1024 * 1024) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel(); throw fail(); }
  return JSON.parse(new TextDecoder().decode(await limitedBytes(response, maximum)));
}

export async function githubHeaders(env, fetcher, now = Date.now()) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'SiteCAD-skill-submissions', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  if (env.GITHUB_TOKEN) return { ...headers, Authorization: `Bearer ${env.GITHUB_TOKEN}` };
  const seconds = Math.floor(now / 1000), text = new TextEncoder();
  const unsigned = `${encode(text.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${encode(text.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: env.GITHUB_APP_ID })))}`;
  const pem = env.GITHUB_PRIVATE_KEY.replaceAll('\\n', '\n');
  if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw fail();
  const bytes = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, text.encode(unsigned));
  const token = await requestJson(fetcher, `${api}/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST', headers: { ...headers, Authorization: `Bearer ${unsigned}.${encode(new Uint8Array(signature))}` },
    body: JSON.stringify({ repositories: [env.GITHUB_REPO], permissions: { issues: 'write' } }),
  }, 16384);
  if (typeof token.token !== 'string' || !token.token || token.token.length > 512) throw fail();
  return { ...headers, Authorization: `Bearer ${token.token}` };
}

export function issueUrl(env, issue) {
  const prefix = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues/`;
  return Number.isSafeInteger(issue?.number) && issue.number > 0 && issue.html_url === `${prefix}${issue.number}` ? issue.html_url : undefined;
}

export async function findIssue(env, fetcher, headers, marker) {
  // shortcut: inspect the newest 100 issues; older unresolved submissions require operator reconciliation.
  const issues = await requestJson(fetcher, `${api}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues?state=all&sort=created&direction=desc&per_page=100`, { headers }, 4 * 1024 * 1024);
  if (!Array.isArray(issues)) throw fail();
  return issues.find(issue => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(marker) && issueUrl(env, issue));
}

export async function createIssue(env, fetcher, headers, record, summary) {
  const safeSummary = summary.replaceAll('@', '＠').split(/\r?\n/).map(line => `    ${line}`).join('\n');
  return requestJson(fetcher, `${api}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, {
    method: 'POST', headers, body: JSON.stringify({
      title: `[스킬 개선안] SiteCAD ${record.version} · ${record.submissionId.slice(0, 8)}`,
      body: `SiteCAD에서 사용자가 공개 제출에 동의한 스킬 개선안입니다.\n\n앱 버전: ${record.version}\n\n자동 생성한 요청·개선 배경 요약:\n\n${safeSummary}\n\n[전체 스킬 ZIP과 개선 배경 문서 다운로드](${env.PUBLIC_ORIGIN}/downloads/${record.submissionId})\n\n이슈와 다운로드 링크는 공개됩니다. ZIP의 스킬은 검토 전 실행하지 마세요.\n\n<!-- sitecad-submission:${record.submissionId} -->`,
    }),
  });
}
