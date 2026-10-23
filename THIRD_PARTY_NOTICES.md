# Third-party notices and source

SiteCAD application source is provided under GNU GPL version 3. See LICENSE. Third-party components retain their own copyright and license terms.

## OpenCADStudio

- Upstream: https://github.com/HakanSeven12/OpenCADStudio
- License: GPL-3.0; preserved verbatim in vendor/editor/LICENSE.
- Distribution snapshot: https://www.opencadstudio.com/app/, fetched 2026-10-21. URLs, sizes and SHA-256 digests are recorded in vendor/editor/manifest.local.json.
- Source reference: commit 86bf75f5016e56597b988871c12938e39e159ca7 (2026-10-21), https://github.com/HakanSeven12/OpenCADStudio/tree/86bf75f5016e56597b988871c12938e39e159ca7.
- Source archive, including Cargo.lock and build scripts, is hosted alongside this binary distribution in the SiteCAD v0.12.0 release: OpenCADStudio-86bf75f5016e56597b988871c12938e39e159ca7-source.tar.gz.
- Upstream build instructions: install the Rust wasm32-unknown-unknown target, trunk and wasm-bindgen-cli, then run `trunk build --release`. Trunk.toml invokes scripts/build-web-worker.sh. Cargo.lock records the registry and Git dependency revisions; their original upstream source locations remain recorded there.
- SiteCAD preserves the published JS/WASM engine files unchanged. Only the startup HTML/offline-cache integration was adapted; scripts/install-editor.mjs records that transformation. The font and control/parse-worker JS in the source reference match the published snapshot; a byte-for-byte engine rebuild has not been performed.

## Noto font collection

vendor/editor/fonts/korean.ttf is the unchanged upstream Noto Sans / Noto Sans CJK KR collection. Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic); Copyright 2014-2021 Adobe (http://www.adobe.com/). Licensed under SIL Open Font License 1.1. See vendor/editor/fonts/NOTICE.txt and OFL.txt. The filename is inherited from upstream; the bytes are a font collection. AppleGothic is read from the user macOS installation at runtime and is not redistributed.

## Codex and Node.js

Codex 0.163.0 is downloaded from the official openai/codex GitHub release during first setup, verified by a pinned SHA-256. Apache-2.0 license and NOTICE are preserved in desktop/licenses/. Node.js 24.22.1 is downloaded from nodejs.org with a pinned SHA-256; its installation archive retains its upstream license. SiteCAD does not ship either executable in this source/installer ZIP.

## npm dependencies

package-lock.json pins REA, PDF.js, proj4, shapefile, keyring and their dependencies. First setup installs them from npm and retains each package's license files. The packages are not copied into this source/installer ZIP. REA optional external engines and user-added MCP programs require their own applicable terms. Electron is an optional development/legacy desktop dependency and is omitted by the local-web installer.
