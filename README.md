# SiteCAD — 자연어로 작업하는 로컬 CAD

SiteCAD는 OpenCADStudio 편집기와 전용 Codex App Server·MCP를 연결하는 macOS·Windows 로컬 브라우저 앱입니다. ChatGPT에 로그인한 뒤 채팅으로 2D 도면을 만들고 수정하거나 물량을 검토하고 DWG로 저장합니다. CAD 파일 처리와 도구 실행은 내 PC에서 이루어지며 AI 요청은 온라인 서비스를 사용합니다.

**[Windows ZIP](https://github.com/seominpapa/SiteCAD/releases/download/v0.13.0/SiteCAD-0.13.0-local-web-Windows.zip)** · **[macOS ZIP](https://github.com/seominpapa/SiteCAD/releases/download/v0.13.0/SiteCAD-0.13.0-local-web-macOS.zip)** · [릴리스와 SHA-256](https://github.com/seominpapa/SiteCAD/releases/latest)

## 설치·실행

1. 릴리스의 운영체제에 맞는 `SiteCAD-0.13.0-local-web-Windows.zip` 또는 `SiteCAD-0.13.0-local-web-macOS.zip`을 다운로드하고 쓰기 가능한 폴더에 압축을 풉니다. GitHub의 자동 생성 `Source code.zip`보다 위 설치 ZIP을 권장합니다.
2. Windows는 `Start SiteCAD.cmd`, macOS는 `Start SiteCAD.command`를 더블클릭합니다. 최초 실행은 전용 Node.js 24.22.1, 잠금 파일의 운영 의존성, Codex 0.163.0 및 내부 MCP·REA 패키지를 자동으로 준비합니다. Git·Homebrew·전역 Node/Codex 설치는 필요하지 않습니다.
3. 브라우저가 열리면 **ChatGPT로 계속**으로 로그인하고 계정 사용 권한을 연결합니다. 계정에서 허용되는 모델과 플랜 사용 한도가 적용됩니다.
4. 채팅으로 도면을 작성하고 **DWG 저장** 또는 응답의 다운로드 링크로 저장합니다. 종료 전 저장한 뒤 **실행기 종료**를 누릅니다. 브라우저 탭을 닫는 것만으로 실행기가 종료되지는 않습니다.

macOS가 실행을 차단하면 파일 출처를 확인하고 **시스템 설정 → 개인정보 보호 및 보안**에서 해당 실행을 허용합니다. 최초 실행·키체인·계정 권한 승인은 사용자가 진행합니다. 자동 우회하지 않습니다. 서명·공증된 설치 앱이 아닌 로컬 실행 스크립트입니다.

최초 설치와 로그인에는 인터넷이 필요하며 이후 실행은 설치된 의존성을 재사용합니다. 설치 실패 시 같은 실행 파일을 다시 열어 복구합니다. 실행 중 터미널 창은 유지합니다. Apple Silicon에서 실제 설치·로그인·DWG 검증을 수행했습니다. Windows 10/11 64비트 x64·ARM64 설치 경로를 제공합니다. Linux 자동 설치기는 제공하지 않습니다. Windows ARM64와 Intel Mac 실기기는 미검증입니다.

Windows에서는 ZIP 안에서 실행하지 말고 **모두 압축 풀기** 후 실행하세요. 관리자 권한·Git·전역 Node 설치는 필요하지 않습니다. PowerShell은 해당 실행에만 실행 정책을 적용하며 시스템 설정을 바꾸지 않습니다. 회사의 실행 제한·보안 제품 정책이나 로그인 승인은 자동으로 우회하지 않습니다.

## 할 수 있는 작업

- DWG 열기, 기본 2D 작도, 객체 이동·삭제, 치수·한글 주석 작성, 레이어별 객체 조회와 측정
- 엔진의 명령 검색·실행 및 후속 입력을 AI가 판단해 진행
- 레이어별 객체 수·길이·폐합 면적을 물량 표로 표시
- 웹검색·문서 fetch, 공개 자료 다운로드와 계산을 설계 참고에 활용
- VWorld 주소·필지 조회, 좌표계 변환과 실척 삽입
- 등록된 SHP/GeoJSON 등고선·표고를 필지와 같은 기준으로 삽입
- 주소만으로 필지·공개 등고선을 확보하는 자동 경로: **현재 경기도 광주시 제공 범위**
- 명시적으로 등록·신뢰한 외부 MCP 연결. REA는 설치된 사전 설정으로 제공
- 도면 변경 감지, 저장 감사와 누락 검사, 검증된 DWG의 보관·다운로드

예: “6000×4000mm 사각형을 그리고 한글 주석과 가로 치수를 넣어 DWG로 저장해줘.”

VWorld 키는 앱의 설계 참고 연결 설정에서 사용자가 등록합니다. 저장소와 배포 파일에는 키가 없습니다. SHP는 같은 이름의 SHP·DBF·PRJ를 함께 선택합니다. 임의 외부 MCP가 요구하는 별도 실행 프로그램까지 자동 설치하지 않습니다. 외부 MCP 호출은 서버·도구·인수를 표시하고 1회 승인 또는 거절을 받습니다.

전국 지형 자동 확보, 로그인 포털 자료의 자동 다운로드, DEM 래스터·지표면 메쉬, 스캔/지도 이미지 형상 추출, 구조 설계 적합성 판단, 복잡한 3D 및 다중 사용자는 현재 범위에 포함하지 않습니다. 필지·지형의 출처·좌표계·표고 기준·정확도를 확인해야 하며 공인 측량 경계나 설계 승인을 대신하지 않습니다.

## 데이터와 보안

- 사용자 데이터: macOS `~/Library/Application Support/SiteCAD Web/`, Windows `%LOCALAPPDATA%\SiteCAD Web\`
- 도면: 위 폴더의 `Drawings/`. 위치 기준이 있는 DWG는 함께 저장되는 `.sitecad.json` 보조 파일도 보관합니다.
- 앱 전용 `codex-home/`·`workspace/`를 사용하며 기존 Codex 앱·CLI의 설정과 로그인을 수정하지 않습니다.
- 인증 정보는 macOS 키체인 또는 Windows 자격 증명 관리자에 보관한 키로 암호화하며 평문 대체 저장을 하지 않습니다.
- Node 런타임·의존성은 설치 폴더의 `.runtime/`, `node_modules/`, `runtime/`에 준비됩니다. 이 웹앱 경로는 Electron을 설치하거나 실행하지 않습니다.
- 로컬 서버는 loopback에만 연결하며 호스트·출처·브라우저 연결 권한을 검사합니다. 하나의 브라우저 탭만 도면 작업을 소유합니다.
- 전체 DWG 파일을 모델에 업로드하지 않지만 채팅 내용·작업에 필요한 객체 문맥과 도구 결과는 AI 요청에 포함됩니다.

회사에서 터미널·자식 프로세스·네트워크 실행을 차단하는 경우 담당자의 허용이 필요합니다. 앱은 해당 정책을 우회하지 않습니다. 저장을 요청하지 않은 편집은 자동으로 디스크에 보존되지 않으므로 중요한 업무 도면은 복사본으로 작업하세요.

## 검증 기록 — 0.12.0 / 2026-10-24

- 별도 임시 폴더에서 시스템 기본 PATH로 시작해 전용 Node 다운로드·해시 검사·의존성·Codex 준비를 확인했습니다.
- 실제 ChatGPT 로그인 → 내부 MCP → 6000×4000mm 사각형·한글 주석·DIMLINEAR 후속 입력 → 저장·브라우저 다운로드를 확인했습니다.
- 사각형만 오른쪽 500mm 이동한 수정본을 저장하고 원본·수정본을 SiteCAD에서 다시 조회했습니다. 재시작 후 로그인 복원도 확인했습니다.
- **다운로드한 정확한 두 DWG를 AutoCAD 2027에서 읽기 전용으로 다시 열어 AUDIT 오류·수정·삭제 모두 0건**을 확인했습니다. DXF 추출 비교에서 객체 3개·레이어·mm 단위·전 좌표·한글 위치/높이·치수 6000과 축척 50이 보존됐고 한글과 치수가 화면에서 읽을 수 있게 표시됐습니다. 원본 파일 해시는 변하지 않았습니다.
- 공개 준비 후 전체 테스트 459개 통과, 줄 97.18%·분기 90.01%·함수 90.29% 커버리지입니다. 운영 의존성 보안 검사 0건이며 REA의 실제 MCP 연결·도구 207개 목록·읽기 호출도 통과했습니다.

비 Autodesk DWG·누락 SHX 1개 안내가 남습니다. 검증한 한글과 치수는 사용자 macOS의 AppleGothic 글꼴을 사용하며 해당 글꼴 파일을 배포하지 않습니다. 새 치수는 비연관 방식이므로 원본 객체 이동을 자동 추적하지 않습니다. 실제 로그아웃 화면, Intel Mac·Windows ARM64·사내 정책 환경은 미검증입니다. Windows에서 실제 사용자의 ChatGPT 승인 및 AutoCAD GUI 검증은 수행하지 않았습니다. 모든 DWG 객체의 호환성을 보장하지 않습니다.

## 소스에서 실행·검사·패키징

이 저장소의 루트에서 `Start SiteCAD.command`를 실행해도 같은 준비 절차가 동작합니다. 편집기 스냅샷과 예제 도면은 저장소에 포함돼 있습니다.

```sh
git clone https://github.com/seominpapa/SiteCAD.git
cd SiteCAD
# Windows: Start SiteCAD.cmd / macOS: Start SiteCAD.command 더블클릭
# 개발용 Node를 사용하는 경우:
npm ci
node scripts/install-codex.mjs
npm run local-web
npm test
npm run local-web:build
npm run local-web:build:windows
```

`npm start`는 초기 구조화 계획기 시제품입니다. 전체 MCP 기능에는 원클릭 실행기 또는 `npm run local-web`을 사용합니다. 기존 Electron 경로는 `npm run desktop`, 개발 앱 빌드는 `npm run desktop:build`이며 권장 설치물은 로컬 브라우저 ZIP입니다.

배포 ZIP은 명시된 소스·잠금 파일·편집기 스냅샷·라이선스·예제만 포함합니다. 사용자 인증·API 키·도면·실행 캐시·설치된 의존성은 제외합니다. Node와 Codex 다운로드는 고정 SHA-256으로 검증합니다. 릴리스의 `SHA256SUMS.txt`로 내려받은 파일도 확인할 수 있습니다.

## 라이선스와 출처

SiteCAD 소스는 GPL-3.0으로 제공합니다. 포함된 제3자 자산에는 각자의 라이선스가 적용됩니다. [LICENSE](LICENSE)와 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하세요.

OpenCADStudio의 GPL 엔진은 수정하지 않았고 시작 HTML·캐싱만 로컬 실행에 맞췄습니다. 다운로드한 배포 스냅샷의 URL·SHA-256은 `vendor/editor/manifest.local.json`에 있습니다. 고정된 OpenCADStudio 참조 소스와 Cargo.lock·빌드 스크립트도 동일 릴리스의 별도 소스 압축파일로 제공합니다. 상위 프로젝트 전체를 재현 빌드하는 검증은 수행하지 않았습니다.
