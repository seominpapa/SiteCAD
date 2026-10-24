# Source, build instructions and verification status

Updated by SiteCAD contributors on 2026-10-24. SiteCAD is provided under GNU GPL version 3; see `LICENSE` for redistribution terms and the disclaimer of warranty. Other components keep their own licenses; see `THIRD_PARTY_NOTICES.md`.

## SiteCAD source

The application sources and installer scripts are included in the local-web ZIP and published at https://github.com/seominpapa/SiteCAD. Select the tag matching the downloaded release. The reviewed public v0.14.0 source tag is `aab72f02ae3bf9529c54a3f6162244478f264894`. SiteCAD 0.15.0 includes the changes described here; use its matching tag and SHA256SUMS.txt rather than assuming they are present in older ZIPs.

On macOS, the included `Start SiteCAD.command` prepares pinned Node.js/Codex and npm dependencies, then opens the local web application. On Windows, use `Start SiteCAD.cmd`. See `README.md` for platform requirements. To build a local-web ZIP from the source checkout, use `npm run local-web:build` or `npm run local-web:build:windows`. The optional Electron build uses `npm run desktop:build` on macOS. Runtime downloads, hashes and build steps are in the included `scripts/` sources and `package-lock.json`.

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
