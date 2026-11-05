# Source, build instructions and verification status

Updated by SiteCAD contributors on 2026-11-04. SiteCAD is provided under GNU GPL version 3; see `LICENSE` for redistribution terms and the disclaimer of warranty. Other components keep their own licenses; see `THIRD_PARTY_NOTICES.md`.

## SiteCAD source

The application sources and installer scripts are included in the local-web ZIP and published at https://github.com/seominpapa/SiteCAD. Select the tag matching the downloaded release. The reviewed public v0.14.0 source tag is `aab72f02ae3bf9529c54a3f6162244478f264894`. SiteCAD 0.16.4 is the source/build target described here. Use its matching tag and SHA256SUMS.txt once its release is published; source changes or CI artifacts alone do not establish a public release or a verified upgrade.

Starting with version 0.16.2, builds bundle only the seven named test DWGs and their guide from `drawings/Test/`, through the explicit allowlist in `scripts/package-drawings.mjs`. Other drawings and private project files are excluded. The local-web ZIP exposes that folder directly; desktop installers retain it inside the app resources and provide a menu item to open it. Builds do not copy examples over user drawings or change the selected save folder. The guide's expected answers are test oracles, not evidence of live LLM or KDS/KCS approval.

On Apple Silicon macOS, the included `Start SiteCAD.command` prepares pinned Node.js/Codex and npm dependencies, then opens the local web application. On Windows, use `Start SiteCAD.cmd`. See `README.md` for platform requirements. To build a local-web ZIP from the source checkout, use `npm run local-web:build` or `npm run local-web:build:windows`. The optional Electron build uses `npm run desktop:build` on Apple Silicon macOS (DMG) or Windows x64 (Setup.exe). Windows requires Inno Setup 6.6.1; set `INNO_SETUP_COMPILER` to its `ISCC.exe`. The CI workflow pins and verifies the official compiler download SHA-256. Native tests run on clean GitHub-hosted macOS and Windows VMs. Installer generation, desktop readiness, real-account AI calls and DWG interoperability are separate verification gates. Runtime downloads, hashes and build steps are in the included `scripts/` sources and `package-lock.json`.

## Desktop updates and preservation

Starting with 0.16.3, the packaged desktop checks only the fixed official `seominpapa/SiteCAD` latest stable GitHub release when the application starts; the app menu can check again. An unavailable check or a declined offer leaves the installed application usable. Installation requires consent to download, a matching published file size and SHA-256, and a separate confirmation to save drawings, quit and install. Windows reuses Inno Setup at the exact existing installation directory. Mac stages and validates the new app before replacing the application bundle with a backup; it does not disable Gatekeeper or remove quarantine.

The application name, bundle identifier, Windows AppId and `SiteCAD` userData location stay unchanged. The update does not reset drawing-storage selection, custom drawing folders, settings or encrypted credentials. A drawing folder selected inside the Mac `.app` bundle prevents automatic installation until the user moves it outside and selects the new folder. Read-only/translocated Mac applications or nonwritable installation locations require the documented manual installation fallback. OS trust and Keychain access may require user approval even when existing encrypted files are preserved.

Version 0.16.2 and older desktop builds do not contain this updater: users must install 0.16.4 manually once (the updater is available since 0.16.3). Local-web ZIPs remain manually updated. New updater code/tests are distinct from native upgrade acceptance, browser-origin security prompts and real-account credential migration; consult the matching release's actual verification evidence. No Apple Developer distribution credentials are bundled or newly established by this feature.

## macOS distributor signing and notarization

A normal public Mac desktop release needs an Apple Developer Program account, a valid **Developer ID Application** certificate with its private key in the build machine's Keychain, and notarization credentials stored with `xcrun notarytool store-credentials SiteCAD`. Use the interactive prompts; never put passwords, `.p12` exports or `.p8` private keys in this repository, build output or chat.

After those credentials are installed, build on Apple Silicon macOS:

```sh
SITECAD_MAC_SIGN_IDENTITY='Developer ID Application: Your Publisher (TEAMID1234)' \
SITECAD_MAC_NOTARY_PROFILE='SiteCAD' \
npm run desktop:build -- --release
```

The release build uses Electron Packager's existing signing/notarization support. Discovered Electron components and native modules are signed with hardened runtime and the JIT entitlement required by Electron. The official Codex executable keeps its existing OpenAI Developer ID signature and exact upstream bytes; re-signing it would invalidate the bundled runtime manifest's SHA-256. The build verifies Codex's digest and Apple Developer ID signature before packaging and again in the packaged app, and excludes only that exact executable from re-signing. The original archive digest and provenance remain unchanged. The app's notarization ticket is stapled before it enters the DMG. The build verifies the app's signature, ticket and Gatekeeper acceptance, then signs/notarizes the final DMG, staples its ticket and verifies the DMG's Gatekeeper acceptance. A missing credential, rejected notarization or failed trust check stops the release build; it never silently falls back to an ad-hoc signature.

Running the ordinary build without signing credentials still creates an explicitly labelled development DMG with an ad-hoc signature. That file is **not** established as trusted by Gatekeeper. Do not describe it as a signed/notarized release or disable macOS security checks to pass verification.

On 2026-11-03 this workstation had no valid code-signing identity, no `SiteCAD` notarization profile, and this repository had no GitHub Actions signing secrets. The signing flow has automated configuration/command-order tests; an actual Developer ID signature, Apple notarization and approval of that signed installer remain unverified until the publisher supplies the required account/certificate.

Official procedures: [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), and [Electron notarization credentials](https://github.com/electron/notarize#usage-with-keychain-credentials).

## Engine identification and source download

The installed editor is the published web snapshot fetched on 2026-10-21, not an engine compiled by SiteCAD. File URLs and SHA-256 hashes are recorded in `vendor/editor/manifest.local.json`. The main WASM contains:

```text
Open CAD Studio v2026.42
Revision: b6fbac39ffc7
Commit date: 2026-10-18
Profile: release
Features: none
```

The identified upstream commit is `b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0`.

- Fixed source archive: https://codeload.github.com/HakanSeven12/OpenCADStudio/tar.gz/b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0
- The same verified archive is included at `vendor/editor/source/OpenCADStudio-b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0-source.tar.gz` in newly generated local ZIPs. The application's license page downloads that local copy through `/legal/opencadstudio-source.tar.gz`; no GitHub connection is required for this copy.
- Archive SHA-256 verified on 2026-10-24: `2c01e345379ab8b54ae5c007a9637f27f7e0b3d514800c187e7d3e9839e57bb4`
- Main WASM SHA-256: `d6a0960716b943f338fb4cdd17f72dde59f52eddedb31bb5f6a07b3f658bc6af`
- Worker WASM SHA-256: `b0dedeb5a8b232698a027010e970310768d385e1243282a559a4822cfd98d330`

The archive was downloaded and inspected: it contains `Cargo.toml`, `Cargo.lock`, `build.rs`, `Trunk.toml`, `web-app.html`, `scripts/build-web-worker.sh`, workspace crates, assets, fonts and the upstream workflow `.github/workflows/pages.yml`. This establishes an accessible source revision matching the main engine's embedded identifier. It does **not** establish all build provenance for the separately published main/worker JS/WASM bundle. No complete rebuild, worker provenance confirmation or full dependency license inventory has been performed.

Earlier SiteCAD v0.12.0, v0.13.0 and v0.14.0 releases attached `OpenCADStudio-86bf75f5016e56597b988871c12938e39e159ca7-source.tar.gz`. That reference commit is 310 commits ahead of the main WASM revision, with 286 changed files. Its SHA-256 is `ea3d8635409a210d53da12f0a4419aa4bc45c38fd7f95c972cce23f022671981`. Preserve access to those historical records, but do not describe the later reference archive as verified corresponding source for these engines. The public historical release assets have not been corrected by editing this local document.

## Upstream web build at the identified revision

Use the fixed revision and its lockfile rather than the current upstream branch. The reviewed upstream workflow uses stable Rust on Ubuntu 22.04, Trunk, the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` matching `Cargo.lock` (`0.2.108`). Exact Rust/Trunk tool versions used to produce the downloaded snapshot are not established by the downloaded binary metadata.

```sh
git clone https://github.com/HakanSeven12/OpenCADStudio.git
cd OpenCADStudio
git checkout --detach b6fbac39ffc74398ba5d283ce2bc1dc07a8fd8f0
rustup target add wasm32-unknown-unknown
cargo install --locked trunk
cargo install --locked wasm-bindgen-cli --version 0.2.108
cargo fetch --locked
trunk build --locked --release --public-url /app/ --dist dist/app --html-output index.html web-app.html
```

`Trunk.toml` runs `scripts/build-web-worker.sh` as a post-build hook. That script builds `ocs_web_worker` with `cargo build --locked --release --target wasm32-unknown-unknown --package ocs_web_worker`, then runs `wasm-bindgen --target web` into `worker_pkg/`. `web-app.html` identifies additional files and fonts copied to `dist/app`. Keep the entire archive, lockfile and these scripts together. A source archive can build without `.git` history, but its displayed revision/tag metadata will differ unless that history is available.

These are inspected upstream instructions, not a claim that this workstation rebuilt or tested the engine. Before replacing the shipped engine with such a build, recheck CAD commands, ChatGPT login, tool approvals, drawing change detection, DWG saves, and reopening the exact saved DWG in SiteCAD and AutoCAD.

## Required dependency sources and persistence

`Cargo.lock` records crates.io package versions/checksums and the following distinct Git sources. Fixed archive paths for all seven returned HTTP 200 on 2026-10-24; that checks present accessibility, not permanent availability or all license requirements.

| Repository | Locked commit |
| --- | --- |
| https://github.com/iced-rs/iced | `23604ff22ab0aad9e00b9327cb7b8546ed84db39` |
| https://github.com/HakanSeven12/iced_aw | `9bff59df71c215abe91710870634886967fc9f1c` |
| https://github.com/iced-rs/cryoglyph | `53ba3e879539d19ed8162942126a977ec896cc3b` |
| https://github.com/iced-rs/winit | `05b8ff17a06562f0a10bb46e6eaacbe2a95cb5ed` |
| https://github.com/HakanSeven12/opencadcodec | `5d4f11ae38758caec540bc9819ff2c4120eeadb4` |
| https://github.com/HakanSeven12/opencadkernel | `a60f18ff033b5a3f7d842e2398f393e4d6cfcd32` |
| https://github.com/HakanSeven12/opencadgraph | `d9f2aeeaaffa9f4972cb10a07e039f4512e8572f` |

Each fixed Git archive follows `https://codeload.github.com/OWNER/REPO/tar.gz/COMMIT` with the repository and locked commit above. `cargo fetch --locked` resolves both Git and registry dependencies. To retain an independently usable dependency snapshot, run `cargo vendor --locked vendor-dependencies` in that fixed checkout and preserve the emitted Cargo source configuration with the complete vendor tree and license files. This vendoring step has **not** been performed here. The primary source archive is retained in the local ZIP; dependency-source persistence remains outstanding for a corrected distribution.

The available notices are not a full review of fonts or libraries embedded in the engine. The main Cargo file enables Iced's `fira-sans` feature, and the upstream tree includes Phosphor icon copyright/license material. The local update preserves additional Phosphor, Iced, Iced-AW, Druid and Fira license texts in `vendor/editor/licenses/`; their fixed source paths are recorded in `scripts/install-editor.mjs`. Confirm which assets and crates enter both release binaries, retain all remaining copyright notices and license texts, and inspect any required dependency source obligations before declaring the corrected release complete.

## Release correction still required

1. Establish the published main engine and worker build provenance, or build both from one fixed complete source checkout without changing the editor silently.
2. Preserve and publish the required complete source, dependency sources/configuration, licenses and build scripts alongside the applicable binary release. Record actual asset names and hashes. The fixed main-source URL above is useful evidence, not a declaration that this entire task is finished.
3. Add accurate correction/source access information for the affected historical v0.12.0–v0.14.0 releases; do not overwrite audit history or claim their old archives matched.
4. Open the final generated ZIP and, for Electron, the final `.app` to check all notices and source/build access paths. Verify the web UI's license/source links actually open.
5. Report local changes, verified local ZIPs and public release publication as separate results. Publishing needs separate authorization.

GNU GPL v3 text: https://www.gnu.org/licenses/gpl-3.0.en.html. This record distinguishes verified distribution facts from unfinished checks; it is not a blanket legal compliance certificate.
