# Third-party notices and source

SiteCAD application source is provided under GNU GPL version 3. See LICENSE. Third-party components retain their own copyright and license terms.

## OpenCADStudio

- Upstream: https://github.com/HakanSeven12/OpenCADStudio
- License: GPL-3.0; preserved verbatim in vendor/editor/LICENSE.
- Distribution snapshot: https://www.opencadstudio.com/app/, fetched 2026-10-21. URLs, sizes and SHA-256 digests are recorded in vendor/editor/manifest.local.json.
- Embedded main-engine metadata: Open CAD Studio v2026.42, revision b6fbac39ffc7, commit date 2026-10-18, release profile, features none. The full upstream commit is b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0. Main WASM SHA-256: d6a0960716b943f338fb4cdd17f72dde59f52eddedb31bb5f6a07b3f658bc6af. Worker WASM SHA-256: b0dedeb5a8b232698a027010e970310768d385e1243282a559a4822cfd98d330.
- Revision-linked source: https://github.com/HakanSeven12/OpenCADStudio/tree/b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0. Its fixed source archive is included in vendor/editor/source/ in newly generated local ZIPs. SHA-256 and lockfile/build instructions are in SOURCE_BUILD.md.
- **Source correspondence has not been established for the complete published engine/worker bundle.** The source archive previously attached to SiteCAD v0.12.0, v0.13.0 and v0.14.0, OpenCADStudio-86bf75f5016e56597b988871c12938e39e159ca7-source.tar.gz, is a later reference commit, not the revision embedded in the main engine. It must not be represented as proven corresponding source. The archive's SHA-256 is ea3d8635409a210d53da12f0a4419aa4bc45c38fd7f95c972cce23f022671981. The public release attachments have not been changed by this local correction.
- SiteCAD preserves the published JS/WASM engine files unchanged. SiteCAD contributors adapted index.html startup/offline-cache handling in the installation snapshot recorded on 2026-10-21: removed upstream service-worker registration and manifest/icon links, and enabled the published automation control API. The original installation did not separately timestamp the individual transformation. This change notice was added on 2026-10-24; future installs separately record author, actual modification timestamp and resulting HTML hash in manifest.local.json. The download-completion timestamp fetchedAt is not a separate modification record.
- Do not infer complete engine dependency/font licensing review from the root GPL file or the Noto and Codex notices. The outstanding source/dependency checks and release correction checklist are documented in SOURCE_BUILD.md. A byte-identical rebuild is not required to identify corresponding source; the unresolved issue here is actual build provenance and complete required source.

## Noto font collection

vendor/editor/fonts/korean.ttf is the unchanged upstream Noto Sans / Noto Sans CJK KR collection. Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic); Copyright 2014-2021 Adobe (http://www.adobe.com/). Licensed under SIL Open Font License 1.1. See vendor/editor/fonts/NOTICE.txt and OFL.txt. The filename is inherited from upstream; the bytes are a font collection. AppleGothic is read from the user macOS installation, or Malgun Gothic (malgun.ttf) from the user Windows installation, at runtime. Neither system font is redistributed.

## Additional engine notices preserved

`vendor/editor/licenses/` now also preserves the upstream Phosphor Icons MIT notice, Iced and Iced-AW MIT notices, the Druid Apache-2.0 license included by Iced's layout source, and the Fira SIL OFL notice (Copyright 2012–2015 The Mozilla Foundation and Telefonica S.A.). Their fixed upstream paths are recorded in `scripts/install-editor.mjs`. Iced's source contains FiraSans-Regular.ttf and Iced-Icons.ttf, and the reviewed OpenCADStudio Cargo file enables Iced's fira-sans feature. These added notices address identified components; they are not an exhaustive inventory or proof that all compiled engine dependency obligations have been resolved.

## Codex and Node.js

For local-web installer ZIPs, Codex 0.163.0 is downloaded from the official openai/codex GitHub release during first setup, verified by a pinned SHA-256. Apache-2.0 license and NOTICE are preserved in desktop/licenses/. Node.js 24.22.1 is downloaded from nodejs.org with a pinned SHA-256; its installation archive retains its upstream license. These local-web ZIPs do not include either executable. The official Windows Codex package keeps its helper executables and voice runtime license files in their upstream layout when downloaded.

The optional macOS Electron build is different: scripts/build-desktop.mjs bundles the verified Codex executable, npm production dependencies and Electron's Node runtime. Root LICENSE, THIRD_PARTY_NOTICES.md, README.md and SOURCE_BUILD.md, plus desktop/licenses/, are copied into the app's Resources/app directory. Electron's distribution notices must remain in the packaged application. Source and runtime notices must be checked in the actual desktop artifact before distributing it; the local-web ZIP audit does not verify a new desktop artifact.

## npm dependencies

package-lock.json pins PDF.js, proj4, shapefile, keyring and their dependencies. Local-web first setup installs them from npm and retains each package's license files; those packages are not copied into the local-web source/installer ZIP. The optional Electron desktop build includes production node_modules with their package license files. User-added MCP programs and instruction plugins require their own applicable terms. Electron is omitted by the local-web installer.

## Optional KCSC MCP runtime

The KCSC connection installs kcsc-design-mcp 0.3.1 (MIT, Copyright 2026 (주)하이드로코리아; https://github.com/lhs1152-lgtm/kcsc-design-mcp), uv 0.8.22 (MIT OR Apache-2.0; https://github.com/astral-sh/uv), and a managed Python 3.12.11 runtime into the user's SiteCAD data directory after explicit consent. These executables and Python packages are downloaded during connection setup and are not bundled in the installer ZIP. Downloaded wheels and the Python distribution retain their upstream license notices; lib/kcsc-requirements.lock pins the Python packages and their SHA-256 hashes.

SiteCAD enables only the seven KCSC reference lookup tools. The upstream repository's separate CC BY-SA design-flow collection is not downloaded or bundled, and its six design tools are not enabled. KCSC reference content remains subject to the provider's terms; a reference lookup or citation audit is not a design-compliance certification. Every user supplies their own KCSC API key; it is never included in release assets.
