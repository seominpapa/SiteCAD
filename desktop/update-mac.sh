#!/bin/sh
set -eu
umask 077
[ "$#" -eq 8 ] || exit 2
parent=$1 target=$2 staged=$3 backup=$4 result=$5 version=$6 ready=$7 download=$8
case "$parent" in ''|*[!0-9]*) exit 2;; esac
case "$version" in ''|*[!0-9.]*) exit 2;; esac
[ "$parent" -gt 0 ] || exit 2
old_moved=0 new_placed=0
cleanup_download() {
  [ -n "$download" ] || return 0
  directory=$(/usr/bin/dirname "$download")
  [ ! -L "$directory" ] && [ "$(/usr/bin/dirname "$directory")" = "$(/usr/bin/dirname "$result")" ] || return 0
  case "$(/usr/bin/basename "$directory")" in download-*) ;; *) return 0;; esac
  [ "$(/usr/bin/basename "$download")" = "SiteCAD-$version-macOS-arm64.dmg" ] || return 0
  /bin/rm "$download" 2>/dev/null || true
  /bin/rmdir "$directory" 2>/dev/null || true
}
record() {
  printf '{"status":"%s","code":"%s","version":"%s"}\n' "$1" "$2" "$version" > "$result.tmp.$$"
  /bin/mv "$result.tmp.$$" "$result"
  cleanup_download
  if [ "$1" = failed ]; then
    /usr/bin/osascript -e 'display alert "SiteCAD 업데이트 실패" message "업데이트를 완료하지 못했습니다. 기존 앱을 다시 실행하거나 GitHub 릴리스의 설치 파일로 수동 업데이트해 주세요. 도면과 사용자 설정은 삭제하지 않았습니다." as warning' >/dev/null 2>&1 || true
  fi
}
restore() {
  code=$1
  if [ "$new_placed" -eq 1 ]; then
    /bin/mv "$target" "$staged" || { record failed restore; exit 1; }
  fi
  if [ "$old_moved" -eq 1 ]; then
    /bin/mv "$backup" "$target" || { record failed restore; exit 1; }
  fi
  record failed "$code"
  /usr/bin/open "$target" >/dev/null 2>&1 || true
  exit 1
}
printf ready > "$ready"
attempt=0
while kill -0 "$parent" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then record failed parent-running; exit 1; fi
  /bin/sleep 1
done
[ -d "$target" ] && [ -d "$staged" ] && [ ! -e "$backup" ] || { record failed app-missing; exit 1; }
/bin/mv "$target" "$backup" || { record failed move-old; /usr/bin/open "$target" >/dev/null 2>&1 || true; exit 1; }
old_moved=1
/bin/mv "$staged" "$target" || restore move-new
new_placed=1
/usr/bin/open "$target" || restore launch
record installed complete
# Keep the prior app for recovery until the user has checked the new version.
/bin/rmdir "$(/usr/bin/dirname "$staged")" 2>/dev/null || true
