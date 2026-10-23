#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
/bin/bash "$ROOT/scripts/bootstrap-local-web.sh"
RESULT=$?
if [ "$RESULT" -ne 0 ] && [ "$RESULT" -ne 130 ]; then
  printf '\n설치·실행에 실패했습니다. 위 오류를 확인한 뒤 다시 실행해 주세요.\nEnter를 누르면 창을 닫습니다. '
  read -r _
fi
exit "$RESULT"
