# Notice

RocketLauncher is a modified version of **Velocmd** (Velocmd Explorer) by **Yashvardhan Gupta**.

- Upstream project: <https://github.com/YashvardhanG/Velocmd>
- Base version: Velocmd 0.1.8, upstream `main` at commit
  [`5e07a52`](https://github.com/YashvardhanG/Velocmd/commit/5e07a52f49376f439005ca8574ef20530f74472f)
  (2026-08-04). That is tag `v0.1.8` plus five later upstream commits, which add the <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
  "open in File Explorer" shortcut and documentation pages.
- Modified by **Leonardo Stagliano**, starting on **2026-09-29**. The full list of changes is the git history of this
  repository after commit `5e07a52`.

Copyright © 2026 Yashvardhan Gupta (Velocmd)<br>
Copyright © 2026 Leonardo Stagliano (modifications in RocketLauncher)

## Summary of the modifications

- **New name and identity.** Product name, executable, window title and tray tooltip are "RocketLauncher". The
  application identifier is `it.stagliano.rocketlauncher` (it was `com.yashvardhang.velocmd`), so RocketLauncher keeps
  its settings, recents and index cache in its own folders and does not import Velocmd's. The internal command scheme
  is `rocket:`: Velocmd's `/velo` and `@velo` filters are now `/rocket` and `@rocket` (also `/comandi`,
  `/impostazioni` and `/settings`), and the index cache file is `index-v1.bin`.
- **Italian interface.** Every text of the interface, the tray menu and both installers is in Italian (NSIS `Italian`,
  WiX `it-IT` with `src-tauri/wix/it-IT.wxl`), and so are the release notes. Built-in entries carry their Windows 11
  Italian names (Gestione attività, Questo PC, Download, Arresta il sistema, …) and keep Velocmd's English names as
  search aliases. Filter words exist in Italian too (`/cartelle`, `/unità`, `/finestre`, `/esegui`, `/cerca`,
  `/privato`, …) next to the English ones, and search ignores accents. Italian question words (come, cosa, cos'è,
  perché, quale, quanto, …) offer a web search like the English ones. The web presets use the Italian editions of
  Google, Amazon and Wikipedia.
- **Search.** A built-in tool whose Italian name equals a Start menu app is listed once, as the Start menu app. The rows
  pinned above the results (Questo PC, Galleria, user folders) need at least two letters that start one of their
  words. Velocmd's behaviour is otherwise kept, including every filter and the scoring.
- **Links.** Help, documentation, update check and release links point to this repository. The links to Nox Dimmer,
  the preset link to the upstream author's website and the credits link to Velocmd still point upstream.
- **Fixes.**
  - Power confirmations (shutdown and restart), quit, cancel, filter suggestions, window handles and other rows that
    must not be reopened with a single <kbd>Enter</kbd> are no longer saved in the recents, and stored recents are
    filtered again when they are loaded.
  - The open-windows list (`/finestre`, also `/tabs`) hides the launcher itself by process id instead of by a window
    title that never matched.
  - Nox Dimmer detection is cached for a few seconds instead of starting `tasklist` on every keystroke.
  - Autostart is registered once, with the explicit name `RocketLauncher`.
  - A click on the tray icon toggles the bar once: Velocmd reacted to both the press and the release, showing the bar
    and hiding it again at once.
  - The bar is shown cloaked and revealed only after the page has drawn the cleared search, so the glass never
    flashes empty or with the previous search; right after a show, a spurious focus loss takes the focus back once
    instead of hiding the bar.
- **Keys.** The global shortcut is recorded freely (Velocmd's eight presets stay as quick picks) and checked before it
  is registered: combinations Windows keeps, AltGr characters, <kbd>Alt</kbd> + keypad digits and the keys every app
  uses are refused. The five in-app actions (settings, show in File Explorer, clear or hide, remove the last filter,
  select text and filters) can be rebound, each with its own restore button, without ever blocking typed characters.
  When another app holds the saved global shortcut at start-up, a preset stands in for that session only instead of
  replacing it. The tray menu gains "Impostazioni".
- **Start-up and confirmations.** "Avvia con Windows" starts RocketLauncher with `--autostart`, which keeps it in the
  notification area; the shutdown and restart confirmation preselects "No, annulla".
- **Cleanup.** Removed code that was never used at runtime: the Tauri template library (`src-tauri/src/lib.rs` and the
  `[lib]` section), an old uncompiled copy of `main.rs` (`backup.rs`), the template SVG assets and the unused
  `@tauri-apps/plugin-autostart` npm package. The MkDocs documentation site (`docs/`, `mkdocs.yml`, `overrides/` and
  its GitHub Pages workflow) was replaced by this repository's README.
- **New look.** A new "Fumé" glass interface over the Windows material (Mica on Windows 11, Acrylic on Windows 10),
  following the light or dark Windows theme; the Inter typeface bundled with the app instead of Montserrat from Google
  Fonts; Lucide icons instead of emoji; a new app and tray icon ("Orbita"). Collapsed, the window shows only the
  search bar; expanded, an action bar names what <kbd>Enter</kbd> does on the selected row. The settings are grouped
  in two cards with the GPL notice, the scrollbar is a thin overlay-style bar. Third-party notices are in
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
- **Security.** Window titles of other applications, file names and typed text are always shown as plain text, the
  web view runs under a Content Security Policy, and web addresses open in the default browser through the Windows
  shell instead of `cmd /C start`, which split an address at `&` and ran the rest as a command.
- **Updates.** The installed version comes from the build instead of a hardcoded string; the update check compares
  versions numerically against this repository's releases and treats "no release yet" as up to date.
- **Build and release.** Every version derives from `package.json`. A GitHub Actions workflow builds, checks and
  publishes each release (NSIS setup, MSI, portable executable and `SHA256SUMS.txt`, see [`RELEASE.md`](RELEASE.md)).
  The executable accepts a hidden `--smoke=<version>` switch used only by that check. Both installers show the GPL-3.0,
  and every release carries `LICENSE.txt` and `THIRD-PARTY-LICENSES.txt` next to the executables.

All user-facing features of Velocmd 0.1.8 are kept, including the Nox Dimmer integration.

## Nox Dimmer

[Nox Dimmer](https://github.com/YashvardhanG/Nox-Dimmer) is a separate screen-dimming application by the same upstream
author, released under its own license. It is not included in RocketLauncher. RocketLauncher only detects whether it is
installed, sends it commands over its local TCP port (`127.0.0.1:50291`), starts it when it is not running (from the
path in its `Nox Dimmer` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) and opens its GitHub pages.

## License and warranty

Velocmd is licensed by its author under the GNU General Public License, version 3 or (at your option) any later version,
as stated in its license notice. RocketLauncher, including these modifications, is distributed under the **GNU General
Public License, version 3** (SPDX: `GPL-3.0-only`). The full text is in [`LICENSE`](LICENSE), which is kept exactly as
published upstream.

This program is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
