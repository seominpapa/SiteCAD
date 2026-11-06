# SiteCAD 스킬 개선안 접수 서비스

로컬 SiteCAD가 생성한 전체 스킬 ZIP과 자동 배경 설명을 받아 `seominpapa/SiteCAD`에 이슈를 생성합니다. 사용자는 GitHub에 로그인하지 않습니다. 앱 릴리스와 독립적으로 배포하는 운영자용 서비스입니다.

## 데이터 흐름과 공개 범위

1. SiteCAD의 기존 내보내기 창에 제출·공개 안내를 표시합니다. ZIP 저장만 누르면 업로드하지 않습니다.
2. 사용자가 공개 제출에 동의하면 이 Worker의 `/challenge` iframe에서 Turnstile 확인을 수행합니다.
3. 로컬 앱 서버가 ZIP과 자동 요약을 `/submissions`로 전송합니다. 로그인 파일·앱 설정·전체 대화 로그는 기존 ZIP 내보내기에서 제외됩니다. 스킬 본문에 들어간 현장 정보까지 자동 비식별화하지는 않습니다.
4. Worker가 Turnstile의 호스트·action·nonce를 검증하고 ZIP을 비공개 R2 버킷에 보관합니다.
5. GitHub App 또는 운영자의 서버 전용 토큰으로 이슈를 생성합니다. 이슈에는 자동 요약과 ZIP 다운로드 링크를 기록합니다.

**이슈와 다운로드 링크는 공개됩니다.** R2 버킷의 public access는 끄지만, 제출 완료된 ZIP은 UUID 링크를 아는 사람이 다운로드할 수 있습니다. 비공개 현장 자료를 받을 용도로 사용하지 마세요. 제출 파일은 검토 전 실행하지 않습니다. 업로드·다운로드·R2 보관에 Cloudflare 사용량이 발생할 수 있습니다.

## 운영자 최초 설정

Cloudflare 로그인, R2 활성화, GitHub App 설치와 권한 승인은 운영자 계정으로 진행합니다. 결제나 새 권한 승인이 필요한 경우 화면에 표시되는 범위를 확인합니다.

```sh
npx wrangler login
npx wrangler r2 bucket create sitecad-skill-submissions
```

`wrangler.jsonc`의 `PUBLIC_ORIGIN`을 실제 Workers 주소로, `TURNSTILE_SITE_KEY`를 해당 호스트만 허용한 Turnstile 사이트 키로 바꿉니다. `.workers.dev` 전체를 허용하지 말고 정확한 Worker 호스트를 등록하세요. localhost를 Turnstile에 추가할 필요는 없습니다. widget 자체는 Worker iframe에서 실행됩니다.

Cloudflare 대시보드에서 Turnstile 위젯을 생성하고 비밀 키를 Worker secret으로 등록합니다. 키는 채팅이나 저장소에 붙여 넣지 않습니다.

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
```

GitHub App은 소유자 계정에서 만들고 **선택한 저장소 `SiteCAD`의 Issues: Read and write**만 부여합니다. 메타데이터 읽기 이외의 코드 쓰기 권한은 필요하지 않습니다. Webhook은 사용하지 않습니다. App ID, 설치 ID, PKCS8 PEM 개인키를 다음 secret에 등록합니다.

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_INSTALLATION_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
```

GitHub에서 받은 개인키가 `BEGIN RSA PRIVATE KEY` 형식이라면 로컬에서 PKCS8 `BEGIN PRIVATE KEY`로 변환한 뒤 secret에 넣습니다. 키 파일은 프로젝트 폴더 밖에서 보관하고 전환 후 임시 복사본은 안전하게 정리합니다.

```sh
openssl pkcs8 -topk8 -nocrypt -in github-app.private-key.pem -out github-app.pkcs8.pem
```

처음 운영을 시작할 때는 GitHub App 대신, `SiteCAD` 저장소만 선택하고 `Issues: Read and write`를 부여한 fine-grained PAT를 `GITHUB_TOKEN` secret으로 넣을 수도 있습니다. 이 경우 토큰 발급·승인·만료 관리가 필요하고 이슈 작성자는 해당 사용자로 표시됩니다. `GITHUB_TOKEN`이 있으면 App 설정보다 우선합니다. 앱이나 사용자 ZIP에 토큰을 포함하지 않습니다.

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

배포 후 `/health`의 `data.configured`가 `true`여야 제출 창을 활성화할 수 있습니다. 이 신호는 필수 설정의 존재만 검사하므로, 잘못된 키·설치 권한·호스트 허용 여부는 최초 실제 제출로 별도 검증합니다. 새 엔드포인트를 로컬 앱의 고정 제출 주소에 연결합니다. 배포할 때마다 앱 버전을 올리거나 앱 릴리스를 만들 필요는 없습니다.

## 요청·응답 계약

- `GET /health` → `{ok:true,data:{configured:boolean}}`
- `GET /challenge?origin=http%3A%2F%2F127.0.0.1%3APORT&nonce=UUID`: localhost 또는 127.0.0.1 부모 창만 허용합니다. `parent.postMessage({type:'sitecad-skill-verification',nonce,token}, exactOrigin)`를 호출하며 만료·실패 시 `token:''`을 전송합니다.
- `POST /submissions`: multipart의 `archive`(File), `metadata`(JSON 문자열), `turnstileToken`, `challengeNonce`, `consent`(`'true'`) 다섯 항목만 받습니다.
- `metadata`: `{submissionId:UUID,version:'0.16.5',summary:'앱이 자동 작성한 요약'}`. 요약은 최대 8,000자이며 사용자가 별도로 입력하지 않습니다. ZIP 상한은 18MiB, multipart 전체는 18MiB+32KiB입니다.
- 성공 `201`, 재확인 성공 `200`: `{ok:true,data:{submissionId,state:'submitted',issueUrl,downloadUrl}}`
- 결과 미확정 `202`: `{ok:true,data:{submissionId,state:'pending'}}`. 완료로 표시하지 않습니다.
- 오류: `{ok:false,error:'사용자 안내'}`. 인증 정보·내부 예외를 반환하지 않습니다.
- `GET|HEAD /downloads/UUID`: 접수 완료된 ZIP만 `attachment`로 반환합니다. 버킷 목록과 미완료 업로드는 공개하지 않습니다.

클라이언트는 Worker의 정확한 origin과 iframe `contentWindow`, nonce를 모두 검사해야 합니다. 전송 토큰은 단일 사용이므로 재확인 때 새 Turnstile 토큰을 받되, 같은 제출에 대한 `submissionId`와 ZIP·메타데이터는 유지합니다. 로컬 서버의 동일 출처·브라우저 소유권 검사를 거쳐서만 업로드합니다. Worker에는 CORS를 열지 않습니다.

## 중복 방지와 운영 복구

R2 조건부 쓰기로 제출 UUID를 `receipts/UUID.json`에 먼저 예약합니다. ZIP SHA-256과 정규화된 메타데이터가 같은 경우에만 같은 제출로 취급합니다. 예약 자체를 `pending`으로 기록하며, GitHub 접수가 확인되면 별도의 `completed/UUID.json`에 완료 결과를 한 번만 저장합니다. R2의 같은 객체 초당 쓰기 제한에 걸리지 않도록 예약 객체를 덮어쓰지 않습니다. 응답이 유실돼도 자동으로 두 번째 이슈를 만들지 않습니다.

새 Turnstile 확인 후 같은 제출을 다시 보내면 최근 100개 이슈의 `sitecad-submission:UUID` 표식을 조회해 완료 상태를 복구합니다. 100개 밖의 오래된 제출, 업로드 중 종료되거나 실제로 이슈가 생성되지 않은 `pending`은 운영자가 이슈 표식과 `receipts/UUID.json`, `completed/UUID.json`, `archives/UUID.zip`을 대조해야 합니다. **자동으로 예약을 지우고 재생성하지 않습니다.** 이슈가 없음을 확정한 경우에만 운영자가 예약을 정리한 뒤 재제출하도록 안내합니다.

API·IP별 제출·전체 제출 rate-limit 바인딩과 Turnstile로 무단 대량 제출을 줄입니다. Workers rate limiting은 위치별 근사값이므로 엄격한 전 세계 비용 상한이 아닙니다. 회사망에서는 IP를 공유하므로 단기 제한이 함께 적용될 수 있습니다. 사용량을 운영 대시보드에서 확인하고 스팸·보관 기간 정책에 맞게 R2 객체를 정리합니다. 이슈 링크를 계속 유지하려면 해당 ZIP과 receipt를 함께 보관합니다.

## 검증

프로젝트 루트에서 실행합니다.

```sh
node --test tests/skill-submission-worker.test.mjs
npx wrangler deploy --dry-run --config cloudflare/skill-submissions/wrangler.jsonc
```

단위 테스트는 입력·용량·동의·Turnstile 바인딩, 중복 요청과 동시 제출, 미확정 응답·재조회, 다운로드, GitHub App RS256 서명을 검증합니다. 배포 뒤 실제 Turnstile·R2·GitHub 제출은 별도의 운영 검증입니다.

공식 문서: [Turnstile 서버 검증](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [R2 조건부 쓰기](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [GitHub App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).
