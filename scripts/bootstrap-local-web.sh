#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
NODE_VERSION="24.22.1"
fail() { printf '\nSiteCAD: %s\n' "$1" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail '이 실행기는 macOS 전용입니다.'
case "$(uname -m)" in
  arm64) ARCH=arm64; NODE_SHA=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 ;;
  x86_64) ARCH=x64; NODE_SHA=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 ;;
  *) fail '지원하지 않는 Mac 프로세서입니다.' ;;
esac
RUNTIME="$ROOT/.runtime/local-web"
mkdir -p "$RUNTIME"
LOCK=""
for ((GENERATION=0; GENERATION<64; GENERATION++)); do
  CANDIDATE="$RUNTIME/setup.lock"
  if [ "$GENERATION" -gt 0 ]; then CANDIDATE="$RUNTIME/setup-$GENERATION.lock"; fi
  if mkdir "$CANDIDATE" 2>/dev/null; then LOCK="$CANDIDATE"; break; fi
  # Never delete an observed stale lock: another recoverer may already own its replacement.
  sleep 1
  PREVIOUS="$(cat "$CANDIDATE/pid" 2>/dev/null || true)"
  case "$PREVIOUS" in
    ''|*[!0-9]*) fail '설치 잠금 정보를 읽을 수 없습니다. 잠시 후 다시 실행해 주세요.' ;;
  esac
  if kill -0 "$PREVIOUS" 2>/dev/null; then fail '다른 SiteCAD 설치가 진행 중입니다. 완료 후 다시 실행해 주세요.'; fi
done
[ -n "$LOCK" ] || fail '중단된 설치 잠금이 너무 많습니다. 새 폴더에 압축을 풀고 다시 실행해 주세요.'
printf '%s\n' "$$" > "$LOCK/pid"
TEMP=""
cleanup() {
  if [ -n "$TEMP" ]; then rm -rf "$TEMP"; fi
  if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ]; then rm -f "$LOCK/pid"; rmdir "$LOCK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
NODE_ROOT="$RUNTIME/node-v$NODE_VERSION-darwin-$ARCH"
if [ ! -x "$NODE_ROOT/bin/node" ] || [ "$("$NODE_ROOT/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  printf 'SiteCAD 전용 실행 환경을 준비합니다…\n'
  TEMP="$(mktemp -d "$RUNTIME/download.XXXXXX")"
  ARCHIVE="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
  curl --fail --show-error --location --retry 2 --connect-timeout 30 --max-time 600 \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" -o "$TEMP/$ARCHIVE"
  # Pinned digests from nodejs.org/dist/v24.22.1/SHASUMS256.txt.
  printf '%s  %s\n' "$NODE_SHA" "$TEMP/$ARCHIVE" | shasum -a 256 --check --status || fail '실행 환경 다운로드 무결성 검사에 실패했습니다. 다시 실행해 주세요.'
  tar -xzf "$TEMP/$ARCHIVE" -C "$TEMP"
  [ -x "$TEMP/node-v$NODE_VERSION-darwin-$ARCH/bin/node" ] || fail '실행 환경 압축을 풀지 못했습니다.'
  rm -rf "$NODE_ROOT"
  mv "$TEMP/node-v$NODE_VERSION-darwin-$ARCH" "$NODE_ROOT"
  rm -rf "$TEMP"
  TEMP=""
fi
export PATH="$NODE_ROOT/bin:$PATH"
export npm_config_cache="$RUNTIME/npm-cache"
export npm_config_update_notifier=false
DEPENDENCIES="$(shasum -a 256 package.json package-lock.json | shasum -a 256 | cut -d ' ' -f 1)-$ARCH-$NODE_VERSION-node-only"
if [ "$(cat "$RUNTIME/dependencies.ready" 2>/dev/null || true)" != "$DEPENDENCIES" ] || [ ! -f "$ROOT/node_modules/.package-lock.json" ]; then
  printf '도면·AI·MCP 의존성을 설치합니다. 처음에는 몇 분 걸릴 수 있습니다…\n'
  rm -f "$RUNTIME/dependencies.ready"
  npm ci --omit=dev --no-audit --no-fund
  [ -f "$ROOT/node_modules/.package-lock.json" ] || fail '의존성 설치를 완료하지 못했습니다. 네트워크를 확인한 뒤 다시 실행해 주세요.'
  printf '%s\n' "$DEPENDENCIES" > "$RUNTIME/dependencies.ready"
fi
if [ ! -f "$ROOT/vendor/editor/manifest.local.json" ]; then
  printf 'OpenCADStudio 도면 편집기를 준비합니다…\n'
  npm run setup
fi
node --input-type=module <<'JS'
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const root = resolve('vendor/editor');
const manifest = JSON.parse(await readFile(`${root}/manifest.local.json`, 'utf8'));
if (!Array.isArray(manifest.files) || !manifest.files.length) throw Error('도면 편집기 설치 정보가 없습니다. 배포 ZIP을 다시 다운로드해 주세요.');
for (const file of manifest.files) {
  const target = resolve(root, file.path);
  if (!target.startsWith(`${root}${sep}`) || !(await stat(target)).size) throw Error('도면 편집기 파일이 손상되었습니다. 배포 ZIP을 다시 다운로드해 주세요.');
}
JS
if ! node --input-type=module 2>/dev/null <<'JS'
import { readFile } from 'node:fs/promises';
import { CODEX_VERSION, fileSha256 } from './scripts/install-codex.mjs';
const manifest = JSON.parse(await readFile('runtime/manifest.json', 'utf8'));
if (manifest.version !== CODEX_VERSION || manifest.arch !== process.arch || await fileSha256('runtime/codex') !== manifest.sha256) process.exit(1);
JS
then
  printf 'SiteCAD 전용 Codex 런타임을 준비합니다…\n'
  node "$ROOT/scripts/install-codex.mjs" "$ROOT/runtime" "$ARCH"
fi
cleanup
trap - EXIT
printf '\nSiteCAD를 브라우저에서 엽니다. 이 창을 닫거나 Control+C를 누르면 서비스가 종료됩니다.\n'
exec "$NODE_ROOT/bin/node" "$ROOT/local-web.mjs"
