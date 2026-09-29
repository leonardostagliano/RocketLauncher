<p align="center">
  <img src="docs/images/logo.png" width="96" height="96" alt="RocketLauncher logo">
</p>

<h1 align="center">RocketLauncher</h1>

<p align="center">A keyboard-first launcher for Windows: apps, files, folders, settings and commands, found as you type.</p>

<p align="center">
  <a href="https://github.com/leonardostagliano/RocketLauncher/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/leonardostagliano/RocketLauncher?style=flat-square"></a>
  <a href="https://github.com/leonardostagliano/RocketLauncher/actions/workflows/windows-release.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/leonardostagliano/RocketLauncher/windows-release.yml?branch=main&style=flat-square&label=build"></a>
  <a href="https://github.com/leonardostagliano/RocketLauncher/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/leonardostagliano/RocketLauncher/total?style=flat-square"></a>
  <img alt="Windows 10 | 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square&logo=windows">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri">
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://github.com/leonardostagliano/RocketLauncher/releases/latest"><b>Download</b></a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#privacy">Privacy</a>
</p>

## Why

Windows search is slow to index, mixes web results into local ones and needs the mouse more often than it should.
RocketLauncher opens with one shortcut over any window, searches an index of your apps and drives held in memory, and
opens what you pick with <kbd>Enter</kbd>. Filters narrow the results to apps, folders, a drive or a file type, and the
same bar switches windows, runs terminal commands, searches the web and controls media playback.

RocketLauncher is a fork of [Velocmd](https://github.com/YashvardhanG/Velocmd) by Yashvardhan Gupta, with a new name,
an Italian interface, a new look and its own releases. See [Attribution and license](#attribution-and-license).

## Download

Get the latest version from the [releases page](https://github.com/leonardostagliano/RocketLauncher/releases/latest).
Every release has three builds of the same program; use only one of them.

| File | What it is |
|---|---|
| `RocketLauncher-<version>-win-x64-setup.exe` | **Recommended.** Installs for the current user, with no administrator rights, a Start menu entry and an uninstaller. |
| `RocketLauncher-<version>-win-x64.msi` | Windows Installer package, for managed or per-machine installs. Needs administrator rights. |
| `RocketLauncher-<version>-win-x64-portable.exe` | The bare executable, with nothing to install. |
| `SHA256SUMS.txt` | SHA-256 checksums of the three files above. |

### Requirements

- Windows 10 or Windows 11, x64.
- The Microsoft Edge WebView2 Runtime. It is part of Windows 11 and of an up-to-date Windows 10; the portable build
  needs it already installed.

### First run

1. The builds are not code-signed, so SmartScreen may show "Windows protected your PC". Check the file first, then
   choose **More info** and **Run anyway**:
   ```powershell
   Get-FileHash .\RocketLauncher-<version>-win-x64-setup.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
   ```
2. Start RocketLauncher. A tray icon appears and the search bar opens near the top of the screen.
3. The first start builds the index of your apps and drives. The search box is disabled until it is ready, which
   takes from a few seconds to a few minutes depending on how many files you have. Later starts load the saved index
   at once.
4. Press <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> from anywhere to show or hide the bar, or click the tray icon.
5. Open the settings with <kbd>Tab</kbd> to turn on **run at startup**, recents or the memory readout, or to pick
   another global shortcut.

The interface is in Italian. The filter keywords in the tables below work as written.

RocketLauncher does not import anything from Velocmd: settings, recents and the index start empty. If Velocmd is
also running, both want <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> and the one started second falls back to the
next free shortcut, so uninstall Velocmd or pick another shortcut.

## Features

- **Instant search.** Apps (including Microsoft Store apps), files, folders and drives, more than 30 Windows settings
  pages and system tools, and the launcher's own commands, all in one list. The results update on every keystroke and
  programs and shortcuts show their real icon. When they match, your Downloads, Pictures, Documents, Music, Videos
  and Desktop folders come first, then commands, then apps, and exact or prefix matches on the name beat matches
  elsewhere in the path.
- **Filters as chips.** Type a filter such as `/apps` followed by a space and it becomes a chip in front of the search
  box; the text you type next is searched only inside it. Chips can be combined (`/c /pdf invoice`). Typing `/` or `@`
  alone lists the available filters, including one entry per drive. <kbd>Backspace</kbd> on an empty box removes the
  last chip.
- **Windows settings and tools.** Settings pages such as Display, Sound, Bluetooth, Wi-Fi, Windows Update, Installed
  apps, Startup apps, Taskbar, Power and Storage, and tools such as Task Manager, Control Panel, Registry Editor,
  Device Manager, Services, Disk Management, Event Viewer, Environment Variables and Command Prompt open directly from
  the bar.
- **Launcher commands.** `/rocket` lists the built-in commands: help, settings, show or hide recents, clear recents,
  refresh the index, show the desktop, list the open windows, quit, close the active tab or window, play/pause, next
  and previous track, and **shutdown** and **restart**, which always ask for a confirmation first, followed by
  shortcuts to five Windows settings pages. Most of the commands also come up in normal search results.
- **Window switching.** `/tabs` lists the open windows by title. Chrome, Edge, Brave and Firefox windows are shown
  with their current tab, VS Code, Discord and WhatsApp are recognised, and <kbd>Enter</kbd> brings the window to the
  front, restoring it if it was minimised. RocketLauncher's own window is never listed.
- **Web search and websites.** `/google`, `/bing`, `/duck` (or `/duckduckgo`) and `/search` search the web with that
  engine (Google for `/search`), and a query that starts with *how*, *what*, *why*, *when* or *who* also offers a web
  search. `/web` lists preset sites (Google, YouTube, Claude, Gemini, ChatGPT, GitHub, Reddit, X, Instagram, LinkedIn,
  Stack Overflow, Gmail, Google Drive, Notion, Discord, Spotify, Amazon, Wikipedia, this README and the upstream
  author's site) and offers to open any address you type, such as `example.com`.
- **Private mode.** Add the `/p` chip and web searches and addresses open in a private window of your browser (Brave,
  Chrome, Edge or Firefox, preferring the default one; if none of them can be started the page opens normally), and
  nothing is saved in the recents. `/p` alone lists the preset sites.
- **Terminal commands.** `/cmd <command>` (or `!cmd`) runs the command in a new Command Prompt window that stays open.
- **Open in File Explorer.** <kbd>Ctrl</kbd>+<kbd>Enter</kbd> on a file or a program shortcut selects it in File
  Explorer; on a folder or a drive it opens it.
- **This PC and user folders.** `/pc` lists This PC, the Recycle Bin and your Downloads, Pictures, Documents, Music,
  Videos and Desktop folders.
- **Nox Dimmer.** `/nox` controls [Nox Dimmer](https://github.com/YashvardhanG/Nox-Dimmer), the upstream author's
  screen-dimming app, when it is installed: open it, quit it, toggle Hyper mode, raise or lower the dimming by 10%,
  check for its updates and open its help. When it is not installed, the entry links to its download page.
- **Recents.** When turned on, the last 10 items you opened appear as soon as the bar opens, ready for
  <kbd>Enter</kbd>. Only items that are safe to open again are saved: power confirmations, quit, cancel, filter
  suggestions and window handles never are, and private mode saves nothing.
- **Stat mode.** Shows the launcher's own memory use (RAM) in the search bar, refreshed every two seconds.
- **Global shortcut picker.** Eight presets: <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> (default),
  <kbd>Alt</kbd>+<kbd>Space</kbd>, <kbd>Win</kbd>+<kbd>Space</kbd>, <kbd>Ctrl</kbd>+<kbd>Space</kbd>,
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>, <kbd>Win</kbd>+<kbd>S</kbd>, <kbd>Alt</kbd>+<kbd>S</kbd> and
  <kbd>Win</kbd>+<kbd>/</kbd>. The picker marks the ones already taken by other apps, and at start-up RocketLauncher
  falls back to the first free preset if the saved one is taken.
- **Settings panel.** Recents, run at startup, clear recents, reset settings (turns recents and stat mode off, run at
  startup on, and restores the default shortcut), the shortcut picker, the update check, help and stat mode.
- **Glass look.** The window follows the Windows light or dark app theme and sits on the Windows material: Mica on
  Windows 11, Acrylic on Windows 10. Closed, it shows only the search bar; open, a bar at the bottom names what
  <kbd>Enter</kbd> does on the selected row. To run without the material, set the environment variable
  `ROCKETLAUNCHER_MATERIAL=none` (`mica` and `acrylic` force one of the two).
- **Update check.** At start-up and on request, RocketLauncher asks GitHub for this repository's latest release. When
  a newer one exists, the update button opens its page in your browser; the app never downloads or installs anything
  by itself.
- **Out of the way.** The bar stays on top, hides as soon as it loses focus, has no taskbar button and lives in the
  tray (left click shows or hides it; the menu has Show and Quit). Starting it a second time shows the running
  instance instead of opening another one.

### Filters

Every filter works with `/` or `@` in front (`/apps` or `@apps`).

| Filter | Shows |
|---|---|
| `/apps` (`/app`, `/application`, `/applications`, `/exe`, `/lnk`) | Applications only |
| `/folders` (`/folder`, `/dir`, `/dirs`, `/directory`, `/directories`) | Folders only |
| `/files` (`/file`) | Files only |
| `/drives` (`/drive`, `/disk`, `/disks`) | Drives only |
| `/c` or `/c:` (any drive letter) | Items on that drive |
| `/pdf`, `/png`, `/docx`... (any other word) | Files with that extension |
| `/tabs` (`/active`, `/window`, `/windows`) | Open windows |
| `/rocket` or `/settings` | Launcher commands and the most used Windows settings |
| `/pc` (`/thispc`, `/computer`) | This PC, the Recycle Bin and your user folders |
| `/web` (`/website`, `/websites`, `/site`, `/sites`, `/url`) | Preset websites, or open a typed address |
| `/p` | Private mode (see above) |
| `/cmd` (also `!cmd`) | Run a terminal command |
| `/google`, `/bing`, `/duck`, `/duckduckgo`, `/search` | Web search |
| `/nox` (`/nox-dimmer`) | Nox Dimmer controls |

| Example | What it does |
|---|---|
| `/apps discord` | Finds the Discord app, not the files that mention it |
| `/folders downloads` | Finds folders called Downloads |
| `/d /mp4 holiday` | Finds `.mp4` files on drive D: whose name or path contains "holiday" |
| `/cmd ipconfig /all` | Runs `ipconfig /all` in a new Command Prompt window |
| `/google rust tauri` | Searches Google |
| `/p /web` | Lists the preset sites, to open in a private window |

### Keyboard shortcuts

| Keys | Action |
|---|---|
| <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> | Show or hide RocketLauncher (default; see the shortcut picker) |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Move through the results |
| <kbd>Enter</kbd> | Open the selected item. If the box holds a filter such as `/apps` and the first row is selected, turn it into a chip |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Show the selected file, folder or drive in File Explorer |
| <kbd>Space</kbd> after `/word`, `@word` or `!word` | Turn the word into a chip |
| <kbd>Backspace</kbd> on an empty box | Remove the last chip |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select the text and every chip; the next key or <kbd>Backspace</kbd> clears them all |
| <kbd>Tab</kbd> | Open or close the settings (or turn a typed filter into a chip) |
| <kbd>Esc</kbd> | Clear the box, the chips and the settings; press it again on an empty bar to hide it |

In the settings, the arrow keys move between the controls, <kbd>Enter</kbd> or <kbd>Space</kbd> activates the
selected one and <kbd>Tab</kbd> closes the panel. In the shortcut picker the arrow keys choose a preset and
<kbd>Enter</kbd> applies it.

## How it works

### The index

RocketLauncher does not use the Windows Search service. It builds its own index and keeps it in memory.

1. **Sources**, in this order: the Windows settings pages and system tools, the launcher's own commands, the apps
   reported by `Get-StartApps` (Microsoft Store apps included, with the names Windows shows in your language), the
   `.exe`, `.lnk` and `.url` entries of the Start menu folders, `%LOCALAPPDATA%\Microsoft\WindowsApps` and
   `%LOCALAPPDATA%\Programs` (leaving out uninstallers, updaters, crash reporters, helpers and similar tools), and
   finally every drive from `C:` to `Z:`, walked in full by several threads in parallel. Names starting with a dot,
   `$Recycle.Bin` and `System Volume Information` are skipped.
2. **Storage.** All paths and names go into one large string; each entry only keeps the offsets of its path, its name
   and its lowercase name, plus its kind (app, folder, file, drive or command). A million entries therefore need no
   per-entry allocations, and searching is a scan over contiguous memory.
3. **Refresh.** The index is rebuilt at every start, then every 15 minutes, and at once with the refresh command. The
   indexing thread runs at the lowest Windows priority. The new index replaces the old one in a single step and is
   saved to disk, then the process trims its working set.
4. **Cache.** The saved copy (`index-v1.bin`) is loaded at start-up, so search works immediately while the fresh
   index is being built. Only the very first start, with no saved copy, waits for the index.
5. **Search.** Each keystroke runs one query on a background thread: the filters are applied first, then every entry
   whose name or full path contains the text (ignoring case) is scored, apps with the same name are shown once, and
   the best 50 results are returned. App icons are read from Windows at that moment. Answers to an older keystroke
   that arrive late are dropped.

Velocmd's author measured about 4 seconds for a full pass over about one million items on an NVMe SSD.

### Settings and files

| Location | Contents |
|---|---|
| `%APPDATA%\it.stagliano.rocketlauncher\settings.json` | The global shortcut |
| `%LOCALAPPDATA%\it.stagliano.rocketlauncher\index-v1.bin` | The saved copy of the index |
| `%LOCALAPPDATA%\it.stagliano.rocketlauncher\EBWebView\` | The WebView2 profile, which keeps the recents and the recents and stat mode switches |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `RocketLauncher` | Present only while run at startup is on |

The run at startup entry points at the executable's path: if you move the portable build, turn the option off and on
again.

## Privacy

- **No telemetry, no account, no analytics.** The index, the recents and the settings never leave your PC.
- **Network:** RocketLauncher connects only to `api.github.com`, to read this repository's latest release at start-up
  and when you check for updates. Web searches and websites open in your browser, and only when you choose them.
- **Local only:** reading the file system and the Start menu, `Get-StartApps` through PowerShell, the titles of the
  open windows for `/tabs`, the default browser setting for private mode, and, for `/nox`, a check for Nox Dimmer
  and its commands on `127.0.0.1`.

## Build from source

You need Windows 10 or 11, [Node.js](https://nodejs.org/) (LTS), the stable Rust MSVC toolchain from
[rustup](https://rustup.rs/), the [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
and the WebView2 Runtime.

```powershell
git clone https://github.com/leonardostagliano/RocketLauncher.git
cd RocketLauncher
npm ci
npm run tauri dev     # runs the app; changes to src/ reload live
npm run tauri build   # src-tauri\target\release\RocketLauncher.exe plus installers in src-tauri\target\release\bundle
```

The frontend is plain HTML, CSS and JavaScript in `src/` with no bundler; the backend (indexer, search and Windows
integration) is `src-tauri/src/main.rs`. A development run behaves like the installed app: it registers the global
shortcut and indexes every drive.

## Releases

Every push to `main` builds RocketLauncher on GitHub Actions (`.github/workflows/windows-release.yml`) and publishes a
release. The version comes from the conventional commits since the previous release, and the setup, the MSI, the
portable executable and `SHA256SUMS.txt` are attached to it. See [RELEASE.md](RELEASE.md) for the details.

## Attribution and license

RocketLauncher is a modified version of [Velocmd](https://github.com/YashvardhanG/Velocmd) 0.1.8 by
**Yashvardhan Gupta**, who designed and wrote the original launcher: the in-memory indexer, the chip filters, the
commands and the Nox Dimmer integration all come from Velocmd. The changes made in RocketLauncher by Leonardo Stagliano
since 2026-09-29 are summarised in [NOTICE.md](NOTICE.md) and listed in full in the git history.

Nox Dimmer is a separate application by the same author and is not part of RocketLauncher.

The interface bundles the Inter typeface (SIL Open Font License 1.1) and Lucide icons (ISC): see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

RocketLauncher is free software, distributed under the GNU General Public License, version 3: see [LICENSE](LICENSE).
It comes with **no warranty**.
