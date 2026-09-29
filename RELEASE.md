# Releasing RocketLauncher

Every push to `main` runs [`.github/workflows/windows-release.yml`](.github/workflows/windows-release.yml) on a
GitHub-hosted `windows-2022` runner. The workflow computes the next version, builds the installers, checks them and
publishes a GitHub Release. Nobody bumps a version or uploads files by hand. The pipeline follows the one used by
ChessAdvisor and AIUsageMonitor, adapted to Tauri.

## Versions

### One source

| Where | Value | Role |
|---|---|---|
| `package.json` `version` | `0.1.8` | The only literal version: the **base**, used until the first release (Velocmd 0.1.8). |
| `src-tauri/tauri.conf.json` `version` | `"../package.json"` | Tauri reads the base from `package.json`. The release script refuses a literal here. |
| `src-tauri/Cargo.toml` `version` | `0.0.0` | Not the app version. It stays frozen, so a release never changes `Cargo.toml` or `Cargo.lock`. |
| GitHub Releases / tags `vX.Y.Z` | computed | The authority after the first release. |

The Cargo package is called `rocket-launcher` on purpose (a debug build is `src-tauri\target\debug\rocket-launcher.exe`);
every file users see is named after `productName` and `mainBinaryName`, `RocketLauncher`.

CI does not edit any of these files. It passes the computed version to the build:

```
tauri build --ci --bundles nsis,msi --config {"version":"X.Y.Z"} -- --locked
```

The Tauri CLI applies that patch to the installers and forwards it to Cargo in `TAURI_CONFIG`. From there it reaches
the numeric VERSIONINFO and `getVersion()` (which the in-app update check uses). `src-tauri/build.rs` sets the
executable's `FileVersion`/`ProductVersion` strings from the same value. A local `npm run tauri build` uses the base
from `package.json` everywhere.

### Bump rules

The version comes from the [conventional commits](https://www.conventionalcommits.org/) since the last published
release:

| Commits in the range | Bump |
|---|---|
| any `type!:` header, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer | major |
| otherwise any `feat:` / `feat(scope):` | minor |
| anything else (`fix`, `docs`, `ci`, `build`, `test`, `refactor`, `chore`, non-conventional messages) | patch |

Headers inside a squash-merge body count. A `feat:` in the middle of a sentence does not.

The next version is `max(last published release, package.json)` plus the bump. Every push to `main` that is not
already part of a release publishes one: a push of only `ci:`/`docs:` commits still produces a patch release.

### First release: 1.0.0

GitHub Releases are never copied to a fork, and a fork made with GitHub's default "copy the main branch only" has no
tags either: the Velocmd tag `v0.1.8` is pushed once, before `main`
(see [One-time setup](#one-time-setup-of-the-github-repository), step 3). When there is no published release, the
range starts at the newest stable `vX.Y.Z` tag reachable from `HEAD` that no release of this repository claims, which
is `v0.1.8`. So:

- the notes start from Velocmd 0.1.8, with a `v0.1.8...v1.0.0` compare link. The RocketLauncher commits come first.
  The base is upstream `main` at `5e07a52`, that is `v0.1.8` plus five later Velocmd commits: those without a
  conventional type are listed apart, credited to Yashvardhan Gupta. Merge commits are never listed;
- the rebrand commit is `feat!:` with a `BREAKING CHANGE` footer (new identifier, Velocmd settings, recents and index
  are not imported), so the bump is major: **0.1.8 → 1.0.0**, with `package.json` still at `0.1.8`;
- without the tag the range is the whole history: the version is still 1.0.0, but there is no compare link and the
  notes leave the Velocmd history out.

Preview it locally at any time (read-only, nothing is sent to GitHub):

```powershell
npm run release:plan        # e.g. "v1.0.0: 0.1.8 -> 1.0.0 (major, N commit, da v0.1.8)" plus the release notes
```

N is the number of commits since `v0.1.8`, so it grows with every commit.

`plan` assumes there are no releases yet. To preview a later release, save the release list first and pass it:
`gh api --paginate --slurp repos/leonardostagliano/RocketLauncher/releases > releases.json`, then
`$env:RELEASES_FILE = 'releases.json'; npm run release:plan`.

### Reruns, drafts and safety rails

- A rerun, or a run of a commit that is already in a published release, skips. It never creates a version or moves
  *Latest* back.
- `publish` first creates a **draft** that targets the exact commit, uploads, checks every asset size, and only then
  publishes it as *Latest*. If a run is interrupted, the next run of the same commit reuses that draft. A run of a
  different commit skips the reserved version with a patch bump and leaves the draft alone. So, to keep the first
  release at 1.0.0 after a failed publish, rerun the failed run (or delete its leftover draft) before pushing a fix;
  otherwise the fix is released as 1.0.1.
- If the newest release is not an ancestor of `HEAD` (a rewritten `main`), the run fails.
- If the computed tag already exists and is not this commit's recoverable draft, the run fails.
- The version must fit the MSI limits (major and minor ≤ 255, patch ≤ 65535). `prepare` checks this before the build.

## What a release contains

| Asset | What it is |
|---|---|
| `RocketLauncher-X.Y.Z-win-x64-setup.exe` | NSIS installer, current user, no administrator rights. Recommended. |
| `RocketLauncher-X.Y.Z-win-x64.msi` | WiX MSI, per machine, for managed installs. Needs administrator rights. |
| `RocketLauncher-X.Y.Z-win-x64-portable.exe` | The bare executable (VC++ runtime linked statically; needs WebView2). |
| `SHA256SUMS.txt` | `<sha256>  <file name>` for the three files, one LF-terminated line each. |
| `LICENSE.txt` | The GPL-3.0 text, a copy of [`LICENSE`](LICENSE). |
| `THIRD-PARTY-LICENSES.txt` | The licenses of the third-party material in the executables: Inter, Lucide and every Rust crate compiled in. |

- The asset names are stable: scripts and a future in-app downloader can rely on them.
- Both installers show the GPL-3.0 (`bundle.licenseFile`) before installing; the two license assets cover the portable
  executable, which has no installer.
- Both installers are in Italian: NSIS `Italian`, and WiX `it-IT` with
  [`src-tauri/wix/it-IT.wxl`](src-tauri/wix/it-IT.wxl), which translates the four Tauri strings WiX does not cover.
- The MSI upgrade code is pinned to `3852b432-3d21-5f51-a237-7dc0d6f152e6`, the value Tauri derives for
  `RocketLauncher`, so a future rename cannot split MSI upgrades. The NSIS setup removes an MSI install of the same
  product before installing.
- The binaries are not code-signed, so SmartScreen may warn on first run. The release notes explain how to check the
  hash first.
- Release notes are in Italian: changes, downloads, how to update, where data lives, SmartScreen and the GPL-3.0
  attribution to Velocmd by Yashvardhan Gupta. The corresponding source of each release is its tag; GitHub attaches
  the source archives automatically.

## The workflow, step by step

1. **Checkout** with full history and tags, without persisting the token.
2. **Calculate release version** (`node scripts/windows-release.mjs prepare`) uses only git, `gh` and Node built-ins.
   It checks the release contract in `tauri.conf.json` (names, identifier, installer languages, upgrade code,
   `"version": "../package.json"`). It also checks that the repository equals `UPDATE_REPOSITORY` in
   `src/update-source.js`: the app looks for updates there, so a fork of this repository must change that constant
   before it can publish. Everything after this step is skipped when there is nothing to release.
3. `npm ci`, Rust stable through the preinstalled `rustup`, and the Cargo cache (`Swatinem/rust-cache`, the only
   third-party action, pinned by commit).
4. **Tests**: `npm test` (`node --test "scripts/*.test.mjs" "tests/*.test.mjs"`), then
   `cargo test --locked --manifest-path src-tauri/Cargo.toml`.
5. **Build and stage**: `build` runs the `tauri build` command above from Node with an argument array, so no shell
   quoting is involved. `stage` copies the NSIS setup, the MSI and `RocketLauncher.exe` to `release/` under the asset
   names and writes `SHA256SUMS.txt`, then adds `LICENSE.txt` and `THIRD-PARTY-LICENSES.txt`. Each bundle folder must
   contain exactly the file of the computed version.
6. **Smoke test**: [`scripts/smoke-windows.ps1`](scripts/smoke-windows.ps1) checks:
   - the checksums, the PE header (x64, GUI) and the executable VERSIONINFO (strings and fixed part, product name,
     publisher, and a copyright that still names Yashvardhan Gupta);
   - the setup's VERSIONINFO;
   - the MSI `Property` table: version, name, manufacturer, language 1040 and upgrade code.

   Then it runs `RocketLauncher-X.Y.Z-win-x64-portable.exe --smoke=X.Y.Z`. That hidden flag makes the app compare
   `getVersion()` and its embedded frontend files with the expected ones and exit before any window, tray, global
   shortcut, autostart or indexing starts (exit code 0 = match, 10 = version, 11 = assets, 12 = product name). If the
   flag is ignored, the script kills the app after 60 s and fails.
7. **Checkout unchanged**: `git status --porcelain --untracked-files=all` must be empty, so the release is exactly the
   tagged commit. The Tauri CLI rewrites `src-tauri/Cargo.toml` with LF line endings at every build, so
   `.gitattributes` checks that file out with LF. Keep it LF, otherwise this step fails on Windows.
8. **Publish**: `SHA256SUMS.txt` must still match the files and both license files must be there, then draft, upload,
   size check, *Latest*.

Build time on a hosted runner is not measured yet. On the maintainer's 12-thread laptop, a cold release build (fat LTO,
one codegen unit) took 17 to 26 minutes, and the first CI run also builds every dependency in debug for `cargo test`,
on a 4-vCPU runner. With the dependencies already compiled, rebuilding the app plus NSIS and MSI bundling takes about
10 minutes, and that is roughly what the Cargo cache saves on later CI runs. The job timeout is 120 minutes, and the
cache is saved even when a run fails or times out (`cache-on-failure`), so a retry never starts cold again. Lower the
timeout once a real run has been measured.

## Third-party licenses

[`THIRD-PARTY-LICENSES.txt`](THIRD-PARTY-LICENSES.txt) is generated, never edited by hand: `npm run licenses`
(`scripts/rust-licenses.mjs`) reads `cargo metadata` for the Windows x64 target and collects the license files of every
crate compiled into the executable, after the Inter and Lucide notices of
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). The file records a fingerprint of `Cargo.lock`, the notices and the
Inter license; `tests/third-party-licenses.test.mjs` fails when one of them changed without regenerating it. So after
any dependency change run `npm run licenses` and commit the result, or `npm test` (and the release) stops.

## Running the release build locally

Only the GitHub workflow publishes. Locally you can run every other step exactly as CI does:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm ci
npm test
$env:RELEASE_PLAN = "$env:TEMP\rl-plan.json"
node scripts/windows-release.mjs plan     # writes the plan CI would compute with no releases (v1.0.0 today)
node scripts/windows-release.mjs build    # tauri build --ci --bundles nsis,msi --config {"version":"1.0.0"} -- --locked
node scripts/windows-release.mjs stage    # release\RocketLauncher-1.0.0-win-x64-*.exe/.msi, SHA256SUMS.txt, licenses
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-windows.ps1 -Version 1.0.0
git status --porcelain --untracked-files=all
```

- The first `tauri build` downloads the NSIS and WiX toolsets into `%LOCALAPPDATA%\tauri`.
- `stage` refuses leftovers from another version or language. Delete `src-tauri\target\release\bundle` and `release\`
  before building a different version.
- `CARGO_TARGET_DIR` is honoured by `stage` and must be an absolute path.
- The smoke test does not install anything and does not start the UI.

## One-time setup of the GitHub repository

1. Create the repository as exactly **`leonardostagliano/RocketLauncher`**, and keep it **public**. Either fork
   `YashvardhanG/Velocmd` and change the name in GitHub's fork dialog (it proposes `Velocmd`), or create a new empty
   public repository with that name. The name must match `UPDATE_REPOSITORY` in `src/update-source.js`, or `prepare`
   refuses to publish. The app checks for updates without authentication, so a private repository answers 404 and
   every user would read "Già aggiornato" forever. The `origin` remote of the maintainer's clone already points there.
2. Actions are disabled on a new fork: open the **Actions** tab and enable workflows. The workflow asks for
   `contents: write`. If the first `gh release create` fails with HTTP 403, set
   *Settings → Actions → General → Workflow permissions* to **Read and write permissions**.
3. Push the Velocmd baseline tag **before** `main`: `git push origin v0.1.8`, then check it with
   `git ls-remote --tags origin v0.1.8`. A new repository, or a default fork, has no tags. Without it the release is
   still 1.0.0, but its notes have no compare link and no Velocmd baseline.
4. Keep upstream tags out of this repository: `git config remote.upstream.tagOpt --no-tags` (already set in the
   maintainer's clone). Never `git push --tags`: CI creates the release tags.
5. Bring `feature/rocketlauncher` into `main` with a fast-forward or a merge commit, for example from the local clone,
   so the `feat!:` rebrand commit and its `BREAKING CHANGE` footer are part of the range. Avoid a GitHub squash merge:
   only a squash message that keeps the `BREAKING CHANGE:` footer at the start of a line still gives 1.0.0, and the
   "pull request title" squash settings drop it (the release would be 0.1.9). Run `npm run release:plan` on the merged
   `main` and check it says `v1.0.0` before pushing. The credential that pushes needs the `workflow` scope, because
   the push adds `.github/workflows`.

## In-app update check

"Controlla aggiornamenti" asks `https://api.github.com/repos/leonardostagliano/RocketLauncher/releases/latest` and
opens the release page in the browser. There is no in-app download and no `tauri-plugin-updater`: that plugin needs a
signing key kept as a secret and cannot update the portable build.

[`src/update-source.js`](src/update-source.js) holds the repository in one constant and derives every URL from it. It
also handles the response:

- a 404 means there is no release yet, which counts as up to date;
- only a strictly newer stable version (numeric comparison) counts as an update;
- drafts and pre-releases are ignored;
- the page to open is built locally, never taken from the API response.

The installed version comes from `getVersion()`, so it always matches the version CI built. If a Content Security
Policy is set in `tauri.conf.json`, its `connect-src` must allow `https://api.github.com`. `tests/release-contract.test.mjs`
checks this.

## Changing the base version

The base only matters before the first release, or to jump ahead. To jump ahead, run
`npm version 2.0.0 --no-git-tag-version` (it updates `package.json` and `package-lock.json`) and commit with a
non-`feat` type. The next release is then `max(last release, 2.0.0)` plus the bump. Do not edit the version in
`tauri.conf.json` or `Cargo.toml`: the tests reject it.
