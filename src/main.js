import { HELP_URL, LATEST_RELEASE_URL, findUpdate } from "./update-source.js";
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

// ---------------------------------------------------------------------------
// Interface text (Italian). Everything the user reads is defined here; the logic
// compares keys, kinds and paths, never the text on screen.
// ---------------------------------------------------------------------------

const PLACEHOLDERS = {
  default: "Cerca app, file, cartelle e comandi",
  private: "Modalità privata: le ricerche web si aprono in incognito",
  update: "È disponibile una nuova versione di RocketLauncher",
  indexing: "Indicizzazione dei file in corso…",
  refreshing: "Aggiornamento dell'indice in corso…"
};

const UPDATE_LABELS = {
  idle: "Controlla aggiornamenti",
  checking: "Verifica in corso…",
  upToDate: "Già aggiornato",
  failed: "Verifica non riuscita",
  available: (version) => `Scarica la versione ${version}`
};

const CLEAR_RECENTS_LABELS = {
  idle: "Svuota recenti",
  done: "Recenti svuotati"
};

const SHORTCUT_TEXT = {
  applying: "Aggiornamento…",
  checking: "Verifica disponibilità…",
  unavailable: "Non disponibile: già in uso da un'altra app",
  updated: "Scelta rapida aggiornata",
  rejected: "Scelta rapida già in uso o non valida",
  failed: "Impossibile cambiare la scelta rapida"
};

// Key names shown for the global shortcut. The stored accelerator (for example
// "Super+Shift+.") never changes, only the way it is displayed.
const SHORTCUT_KEY_LABELS = {
  Super: "Win",
  CommandOrControl: "Ctrl",
  Control: "Ctrl",
  Shift: "Maiusc",
  Space: "Spazio"
};

const RESULT_TEXT = {
  runCommand: "Esegui comando",
  typeCommand: "Scrivi il comando da eseguire",
  runPrefix: "Esegui: ",
  searchWeb: "Cerca sul web",
  searchWith: (engine) => `Cerca con ${engine}`,
  searchPrivate: "Cerca in incognito",
  searchPrivateWith: (engine) => `Cerca con ${engine} in incognito`,
  noResults: (query) => `Nessun risultato per “${query}”`,
  noResultsWithFilters: "Nessun risultato con questi filtri. Premi Backspace per rimuovere l'ultimo.",
  recentsEmptyTitle: "Qui compariranno gli elementi aperti di recente",
  recentsEmptyHint: "Puoi nasconderli nelle impostazioni (Tab)",
  refreshingTitle: "Aggiornamento dell'indice dei file…",
  refreshingHint: "Richiede qualche istante",
  indexingTitle: "Indicizzazione dei file in corso…",
  indexingHint: "All'avvio richiede qualche istante",
  shutdownConfirm: "Sì, spegni il PC adesso",
  restartConfirm: "Sì, riavvia il PC adesso",
  powerCancel: "No, annulla",
  shutdownDetail: "Chiude tutte le app e spegne il computer",
  restartDetail: "Chiude tutte le app e riavvia il computer",
  cancelDetail: "Torna alla ricerca",
  removeFilter: "Rimuovi filtro",
  drive: (letter) => `Unità ${letter}`
};

// Second line of a result row, by kind and by the scheme of built-in paths.
const RESULT_DETAILS = {
  app: "Applicazione",
  fileExplorer: "Esplora file",
  rocketCommand: "Comando di RocketLauncher",
  noxCommand: "Comando di Nox Dimmer",
  windowsSettings: "Impostazioni di Windows",
  systemTool: "Strumento di sistema",
  command: "Comando",
  openWindow: "Finestra aperta",
  terminalCommand: "Prompt dei comandi"
};

const NUMBER_FORMAT = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Rows of the shutdown and restart confirmation.
const SHUTDOWN_NOW_PATH = "cmd:shutdown /s /t 0";
const RESTART_NOW_PATH = "cmd:shutdown /r /t 0";
const CANCEL_POWER_PATH = "rocket:cancel_power";

// ---------------------------------------------------------------------------
// Filters and search intents. Chips are "@word" or "/word" ("!cmd" too); the
// words below mirror classify_filter in src-tauri/src/main.rs, keep them in sync.
// ---------------------------------------------------------------------------

const FILTER_WORDS = {
  apps: ["app", "apps", "application", "applications", "applicazione", "applicazioni", "programma", "programmi", "exe", "lnk"],
  folders: ["cartelle", "cartella", "folder", "folders", "directory", "directories", "dir", "dirs"],
  files: ["file", "files"],
  drives: ["unita", "disco", "dischi", "drive", "drives", "disk", "disks"],
  tabs: ["finestre", "finestra", "schede", "scheda", "tabs", "active", "window", "windows"],
  rocket: ["rocket", "rocketlauncher", "comandi", "impostazioni", "settings"],
  thisPc: ["pc", "questopc", "thispc", "computer"],
  web: ["web", "siti", "sito", "website", "websites", "site", "sites", "url"],
  private: ["p", "privato", "privata", "incognito"],
  commands: ["impostazione", "configurazione", "setting", "config", "setup"],
  nox: ["nox", "nox-dimmer", "noxdimmer"],
  runCommand: ["cmd", "esegui"],
  webSearch: ["cerca", "search", "google", "bing", "duck", "duckduckgo"]
};

const KNOWN_FILTER_WORDS = new Set(Object.values(FILTER_WORDS).flat());

// Suggestions listed while a filter word is typed; `token` is the chip it adds.
const FILTER_SUGGESTIONS = [
  { name: "Applicazioni", token: "app", words: FILTER_WORDS.apps, score: 100 },
  { name: "Cartelle", token: "cartelle", words: FILTER_WORDS.folders, score: 99 },
  { name: "File", token: "file", words: FILTER_WORDS.files, score: 98 },
  { name: "Finestre aperte", token: "finestre", words: FILTER_WORDS.tabs, score: 95 },
  { name: "Comandi di RocketLauncher", token: "rocket", words: ["rocket", "rocketlauncher", "comandi"], score: 94 },
  { name: "Questo PC", token: "pc", words: FILTER_WORDS.thisPc, score: 93 },
  { name: "Siti web", token: "web", words: FILTER_WORDS.web, score: 92 },
  { name: "Impostazioni", token: "impostazioni", words: ["impostazioni", "settings"], score: 91 },
  { name: "Esegui comando", token: "cmd", words: FILTER_WORDS.runCommand, score: 90 },
  { name: "Ricerca web", token: "cerca", words: FILTER_WORDS.webSearch, score: 89 }
];

// Chips added by the interface itself (settings panel open, "Finestre aperte" command).
const SETTINGS_CHIP = "/impostazioni";
const OPEN_WINDOWS_CHIP = "/finestre";

// Web search engines by chip word; "default" is the generic web search.
const WEB_ENGINES = { google: "google", bing: "bing", duck: "duckduckgo", duckduckgo: "duckduckgo", cerca: "default", search: "default" };
const WEB_ENGINE_LABELS = { google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo" };
const WEB_SEARCH_URLS = {
  default: "https://www.google.com/search?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q="
};

// A query whose first word is one of these is offered as a web search (accents are ignored,
// so "perche" and "perché" both count).
const QUESTION_WORDS = new Set(["come", "cosa", "perche", "quando", "chi", "dove", "how", "what", "why", "when", "who"]);

// File names, window titles of other apps and typed text are inserted as text, never as
// HTML: a page title such as "<img onerror=…>" shown under /finestre must not run script.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Lowercase and without accents, like fold_for_search in main.rs.
function foldText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'");
}

// "/cartelle" -> { prefix: "/", word: "cartelle" }; null when the text is not a filter token.
function parseFilterToken(text) {
  if (typeof text !== "string" || text.length < 2 || !"@/!".includes(text[0])) return null;
  return { prefix: text[0], word: foldText(text.slice(1)) };
}

function isPrivateFilter(token) {
  const parsed = parseFilterToken(token);
  return parsed !== null && parsed.prefix !== "!" && FILTER_WORDS.private.includes(parsed.word);
}

function hasPrivateFilter() {
  return state.activeFilters.some(isPrivateFilter);
}

// A filter word the search understands as typed: a known word, a drive letter ("c", "c:").
function isKnownFilterWord(text) {
  const parsed = parseFilterToken(text);
  return parsed !== null && (KNOWN_FILTER_WORDS.has(parsed.word) || /^[a-z]:?$/.test(parsed.word));
}

function splitFirstWord(text) {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  return space === -1 ? [trimmed, ""] : [trimmed.slice(0, space), trimmed.slice(space).trim()];
}

function suggestionMatches(suggestion, term) {
  return term.length === 0
    || suggestion.token.startsWith(term)
    || suggestion.words.some(word => word.startsWith(term))
    || foldText(suggestion.name).includes(term);
}

function resultDetail(item, path, kind) {
  if (item && typeof item === "object" && typeof item.detail === "string") return item.detail;
  switch (kind) {
    case "app":
      return path.startsWith("cmd:explorer ") ? RESULT_DETAILS.fileExplorer : RESULT_DETAILS.app;
    case "command":
      if (path.startsWith("rocket:")) return RESULT_DETAILS.rocketCommand;
      if (path.startsWith("nox:")) return RESULT_DETAILS.noxCommand;
      if (path.startsWith("ms-settings:")) return RESULT_DETAILS.windowsSettings;
      if (path.startsWith("cmd:")) return RESULT_DETAILS.systemTool;
      return RESULT_DETAILS.command;
    case "active_tab":
      return path.split("|")[1] || RESULT_DETAILS.openWindow;
    case "filter":
      return path.trim();
    case "terminal_command":
      return RESULT_DETAILS.terminalCommand;
    default:
      return path;
  }
}

const input = document.getElementById("search-input");
const container = document.getElementById("container");
const resultsContainer = document.getElementById("results-container");
const resultsList = document.getElementById("results");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const recentsToggle = document.getElementById("show-recents-toggle");
const clearRecentsBtn = document.getElementById("clear-recents-btn");
const resetPosBtn = document.getElementById("reset-pos-btn");
const shortcutDisplay = document.getElementById("shortcut-display");
const shortcutDropdown = document.getElementById("shortcut-dropdown");
const shortcutMsg = document.getElementById("shortcut-msg");
const startupToggle = document.getElementById("startup-toggle");
const analyticsToggle = document.getElementById("analytics-toggle");
const updateBtn = document.getElementById("update-btn");
const memoryDisplay = document.getElementById("memory-usage");
const helpBtn = document.getElementById("help-btn");
const searchWrapper = document.querySelector(".search-wrapper");
const loaderHtml = `
  <div id="search-loader" class="loader-dots hidden">
    <div class="loader-dot"></div>
    <div class="loader-dot"></div>
    <div class="loader-dot"></div>
  </div>`;
searchWrapper.insertAdjacentHTML('beforeend', loaderHtml);
const searchLoader = document.getElementById("search-loader");

// The placeholder doubles as a status line; its current role is tracked by key.
let placeholderKey = "default";
function setPlaceholder(key) {
  placeholderKey = key;
  input.placeholder = PLACEHOLDERS[key];
}
setPlaceholder("default");

// Installed version as built into the app: tauri.conf.json points at package.json and CI overrides it with
// `tauri build --config`, so it is the same value as the exe VERSIONINFO, the NSIS setup and the MSI.
// Needs core:app:allow-version, which core:default already grants.
const appVersion = window.__TAURI__.app.getVersion().catch((err) => {
  console.error("App version unavailable:", err);
  return null;
});
let isUpdateAvailable = false;
let latestReleaseUrl = LATEST_RELEASE_URL;

const appVersionLabel = document.getElementById("app-version");
appVersion.then((version) => {
  if (appVersionLabel && version) appVersionLabel.textContent = `Versione ${version}`;
});

let settingsIndex = -1;
let dropdownIndex = -1;
let isAllSelected = false;
let currentSearchId = 0;
let lastRenderedSearchId = 0;
let hasCheckedStartupUpdate = false;

let state = {
  results: [],
  recentFiles: [],
  selectedIndex: 0,
  showRecents: false,
  activeFilters: []
};

const PRESET_SHORTCUTS = [
  "Super+Shift+.",
  "Alt+Space",
  "Super+Space",
  "Ctrl+Space",
  "Ctrl+Shift+Space",
  "Super+S",
  "Alt+S",
  "Super+/"
];

// Recents are reopened with a single Enter, so only rows that are safe and meaningful
// to open again are stored. Power confirmations, quit, cancel, filter suggestions,
// window handles and other transient rows are never remembered.
const RECENT_LIMIT = 10;
const RECENT_KINDS = new Set(["app", "file", "folder", "drive"]);
const RECENT_ROCKET_COMMANDS = new Set([
  "rocket:help",
  "rocket:settings",
  "rocket:refresh",
  "rocket:show_desktop",
  "rocket:active_tabs",
  "rocket:media_play",
  "rocket:media_next",
  "rocket:media_prev"
]);
const POWER_COMMAND_PATTERN = /\b(shutdown|restart-computer|stop-computer)\b/i;

function isRecentCandidate(path, kind) {
  if (typeof path !== "string" || path.length === 0 || typeof kind !== "string") return false;
  const lowerPath = path.toLowerCase();

  if (lowerPath.startsWith("rocket:")) {
    return kind === "command" && RECENT_ROCKET_COMMANDS.has(lowerPath);
  }
  if (lowerPath.startsWith("nox:") || lowerPath.startsWith("hwnd:")) return false;

  if (kind === "command") {
    const isSystemEntry = lowerPath.startsWith("cmd:") || lowerPath.startsWith("ms-settings:");
    return isSystemEntry && !POWER_COMMAND_PATTERN.test(path);
  }
  if (kind === "terminal_command") return !POWER_COMMAND_PATTERN.test(path);
  if (kind === "website") return lowerPath.startsWith("http://") || lowerPath.startsWith("https://");
  return RECENT_KINDS.has(kind);
}

function loadStoredRecents() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem("recentFiles") || "[]");
  } catch (e) {
    return [];
  }
  if (!Array.isArray(stored)) return [];

  const seenPaths = new Set();
  const recents = [];
  for (const entry of stored) {
    const item = typeof entry === "string" ? { path: entry, kind: "file" } : entry;
    if (!item || typeof item !== "object") continue;
    const { path, kind } = item;
    if (!isRecentCandidate(path, kind) || seenPaths.has(path)) continue;
    seenPaths.add(path);
    const name = typeof item.name === "string" && item.name.length > 0 ? item.name : path.split("\\").pop();
    recents.push({ path, kind, name });
    if (recents.length >= RECENT_LIMIT) break;
  }
  return recents;
}

function saveRecents() {
  try {
    localStorage.setItem("recentFiles", JSON.stringify(state.recentFiles));
  } catch (e) {
    console.error("Failed to save recents:", e);
  }
}

function rememberRecent(path, kind, name) {
  if (!isRecentCandidate(path, kind)) return;
  const newItem = { path, kind, name: name || path.split("\\").pop() };
  const others = state.recentFiles.filter(p => (typeof p === "string" ? p : p.path) !== path);
  state.recentFiles = [newItem, ...others].slice(0, RECENT_LIMIT);
  saveRecents();
}

state.recentFiles = loadStoredRecents();
saveRecents();

const savedShowRecents = localStorage.getItem("showRecentsSetting");
if (savedShowRecents !== null) {
  state.showRecents = JSON.parse(savedShowRecents);
  recentsToggle.checked = state.showRecents;
}

const savedAnalytics = localStorage.getItem("analyticsSetting");
let showAnalytics = savedAnalytics === "true";
if (analyticsToggle) {
  analyticsToggle.checked = showAnalytics;
  if (showAnalytics) memoryDisplay.classList.remove("hidden");
}

async function updateMemoryUsage() {
  if (!showAnalytics) return;
  try {
    const bytes = await invoke("get_memory_usage");
    memoryDisplay.textContent = `RAM: ${NUMBER_FORMAT.format(bytes / (1024 * 1024))} MB`;
  } catch (e) {
    console.error("Failed to get memory usage:", e);
  }
}

setInterval(updateMemoryUsage, 2000);

function getSettingsFocusables() {
  const base = [
    recentsToggle.parentElement,
    startupToggle.parentElement,
    clearRecentsBtn,
    resetPosBtn,
    shortcutDisplay,
    updateBtn,
    helpBtn,
    analyticsToggle.parentElement
  ];
  return base.filter(el => el !== null);
}

function renderSettingsFocus() {
  const items = getSettingsFocusables();
  items.forEach((item, idx) => {
    if (idx === settingsIndex) {
      item.classList.add("selected");
    } else {
      item.classList.remove("selected");
    }
  });
}

function renderDropdownFocus() {
  const options = document.querySelectorAll(".shortcut-option");
  options.forEach((opt, idx) => {
    if (idx === dropdownIndex) {
      opt.classList.add("selected");
      opt.scrollIntoView({ block: "nearest" });
    } else {
      opt.classList.remove("selected");
    }
  });
}

invoke("set_recents_state", { show: state.showRecents });

const WINDOW_MAX_HEIGHT = 400;

async function toggleSettings() {
  const isOpening = settingsPanel.classList.contains("hidden");

  if (isOpening) {
    await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
    lastWindowHeight = WINDOW_MAX_HEIGHT;

    settingsIndex = -1;
    renderSettingsFocus();

    settingsPanel.classList.remove("hidden");
    settingsBtn.classList.add("active");
    resultsContainer.classList.add("hidden");

    if (!state.activeFilters.includes(SETTINGS_CHIP)) {
      state.activeFilters.push(SETTINGS_CHIP);
      renderChips();
    }
  } else {
    settingsPanel.classList.add("hidden");
    getSettingsFocusables().forEach(el => el.classList.remove("selected"));
    settingsBtn.classList.remove("active");

    state.activeFilters = state.activeFilters.filter(f => f !== SETTINGS_CHIP);
    renderChips();

    const hasInput = input.value.trim().length > 0;

    if (state.showRecents) {
      resultsContainer.classList.remove("hidden");
      await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    } else {
      if (hasInput || state.activeFilters.length > 0) {
        resultsContainer.classList.remove("hidden");
        await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
        lastWindowHeight = WINDOW_MAX_HEIGHT;
      } else {
        state.results = [];
        resultsContainer.classList.add("hidden");
        await invoke("reset_window");
        lastWindowHeight = 65;
      }
    }
  }

  render();
  setTimeout(() => input.focus(), 10);
}

settingsBtn.onclick = (e) => {
  e.stopPropagation();
  toggleSettings();
};

recentsToggle.onchange = (e) => {
  state.showRecents = e.target.checked;
  localStorage.setItem("showRecentsSetting", state.showRecents);
  invoke("set_recents_state", { show: state.showRecents });
  render();
};

if (analyticsToggle) {
  analyticsToggle.onchange = (e) => {
    showAnalytics = e.target.checked;
    localStorage.setItem("analyticsSetting", showAnalytics);
    if (showAnalytics) {
      memoryDisplay.classList.remove("hidden");
      updateMemoryUsage();
    } else {
      memoryDisplay.classList.add("hidden");
    }
  };
}

clearRecentsBtn.onclick = () => {
  state.recentFiles = [];
  localStorage.setItem("recentFiles", JSON.stringify([]));

  clearRecentsBtn.textContent = CLEAR_RECENTS_LABELS.done;
  clearRecentsBtn.style.backgroundColor = "#4caf50";
  setTimeout(() => {
    clearRecentsBtn.textContent = CLEAR_RECENTS_LABELS.idle;
    clearRecentsBtn.style.backgroundColor = "";
  }, 1000);

  render();
};

resetPosBtn.onclick = async () => {
  state.showRecents = false;
  recentsToggle.checked = false;
  localStorage.setItem("showRecentsSetting", false);
  invoke("set_recents_state", { show: false });

  showAnalytics = false;
  localStorage.setItem("analyticsSetting", false);
  if (analyticsToggle) analyticsToggle.checked = false;
  if (memoryDisplay) memoryDisplay.classList.add("hidden");

  try {
    await invoke("plugin:autostart|enable");
    if (startupToggle) startupToggle.checked = true;
  } catch (err) {
    console.error("Reset autostart error:", err);
  }

  const defaultShortcut = PRESET_SHORTCUTS[0];
  await applyShortcut(defaultShortcut);

  await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
  lastWindowHeight = WINDOW_MAX_HEIGHT;
};

function setUpdateButton(text, variant) {
  if (!updateBtn) return;
  updateBtn.textContent = text;
  updateBtn.classList.remove("btn-secondary", "btn-success", "btn-update-available");
  updateBtn.classList.add(variant);
}

function resetUpdateButtonLater() {
  setTimeout(() => setUpdateButton(UPDATE_LABELS.idle, "btn-secondary"), 3000);
}

// The newest published release when it is strictly newer than the installed version, otherwise null.
// No release yet (GitHub answers 404) counts as up to date, not as a failure.
async function refreshUpdateState() {
  const update = await findUpdate(await appVersion);
  isUpdateAvailable = Boolean(update);
  if (update) latestReleaseUrl = update.url;
  return update;
}

async function checkUpdates(isAuto = false) {
  if (!isAuto) setUpdateButton(UPDATE_LABELS.checking, "btn-secondary");
  try {
    const update = await refreshUpdateState();
    if (update) {
      setUpdateButton(UPDATE_LABELS.available(update.version), "btn-update-available");
      if (isAuto && placeholderKey === "default") {
        setPlaceholder("update");
        setTimeout(() => {
          if (placeholderKey === "update") setPlaceholder("default");
        }, 2500);
      }
    } else if (!isAuto) {
      setUpdateButton(UPDATE_LABELS.upToDate, "btn-success");
      resetUpdateButtonLater();
    }
  } catch (err) {
    console.error("Update check failed:", err);
    if (!isAuto) {
      setUpdateButton(UPDATE_LABELS.failed, "btn-secondary");
      resetUpdateButtonLater();
    }
  }
}

if (updateBtn) {
  updateBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!isUpdateAvailable) {
      checkUpdates(false);
      return;
    }
    // Check again before opening the page: the release may have been withdrawn in the meantime.
    const offeredLabel = updateBtn.textContent;
    updateBtn.textContent = UPDATE_LABELS.checking;
    try {
      const update = await refreshUpdateState();
      if (!update) {
        setUpdateButton(UPDATE_LABELS.upToDate, "btn-success");
        resetUpdateButtonLater();
        return;
      }
      setUpdateButton(UPDATE_LABELS.available(update.version), "btn-update-available");
    } catch (err) {
      // Offline: open the last known release page, as Velocmd did.
      console.error("Update re-check failed:", err);
      updateBtn.textContent = offeredLabel;
    }
    await invoke("open_file", { path: latestReleaseUrl });
  };
}

function getFileIcon(path, kind) {
  const tpath = path.toLowerCase().replace(/\//g, '\\');
  const isUserProfile = /^c:\\users\\[^\\]+\\[^\\]+$/.test(tpath) || /^c:\\users\\[^\\]+$/.test(tpath) || /^c:\\documents and settings\\[^\\]+\\[^\\]+$/.test(tpath);

  if (isUserProfile) {
    if (tpath.endsWith("\\downloads")) return "📥";
    if (tpath.endsWith("\\pictures") || tpath.endsWith("\\gallery")) return "🏞️";
    if (tpath.endsWith("\\documents")) return "📝";
    if (tpath.endsWith("\\music")) return "🎵";
    if (tpath.endsWith("\\videos")) return "🎬";
    if (tpath.endsWith("\\desktop")) return "🖥️";
  }

  if (tpath.includes("recyclebinfolder")) return "🗑️";

  if (path === SHUTDOWN_NOW_PATH || path === RESTART_NOW_PATH) return "✅";
  if (path === CANCEL_POWER_PATH) return "❌";

  if (kind === "app") return "🚀";
  if (kind === "folder") return "📁";
  if (kind === "drive") return "💽";
  if (kind === "command") return "⚙️";
  if (kind === "website") return "🌐";
  if (kind === "filter") return "🔍";
  if (kind === "terminal_command") return "💻";

  const ext = path.split('.').pop().toLowerCase();

  if (['rs', 'go', 'py', 'js', 'ts', 'html', 'css', 'cpp', 'c'].includes(ext)) return "💻";
  if (['json', 'yaml', 'xml', 'toml'].includes(ext)) return "⚙️";
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext)) return "🖼️";
  if (['mp4', 'mkv', 'mov', 'avi'].includes(ext)) return "🎥";
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return "🎵";
  if (['pdf'].includes(ext)) return "📕";
  if (['doc', 'docx'].includes(ext)) return "📘";
  if (['xls', 'xlsx', 'csv'].includes(ext)) return "📊";
  if (['txt', 'md'].includes(ext)) return "📝";
  if (['zip', 'rar', '7z', 'tar'].includes(ext)) return "📦";

  return "📄";
}

function selectAllChips() {
  isAllSelected = true;
  document.querySelectorAll(".chip").forEach(el => el.classList.add("selected"));
  input.select();
}

function deselectChips() {
  input.setSelectionRange(input.value.length, input.value.length);

  if (!isAllSelected) return;
  isAllSelected = false;
  document.querySelectorAll(".chip").forEach(el => el.classList.remove("selected"));
}

function renderChips() {
  const chipsArea = document.getElementById("chips-area");
  chipsArea.innerHTML = "";

  state.activeFilters.forEach((filter, index) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `
      ${escapeHtml(filter)}
      <span class="chip-close" title="${RESULT_TEXT.removeFilter}" aria-label="${RESULT_TEXT.removeFilter}">×</span>
    `;

    chip.querySelector(".chip-close").onclick = (e) => {
      e.stopPropagation();
      removeFilter(index);
    };

    chipsArea.appendChild(chip);
  });

  if (hasPrivateFilter()) {
    setPlaceholder("private");
  } else if (placeholderKey === "private") {
    setPlaceholder("default");
  }
}

function removeFilter(index) {
  state.activeFilters.splice(index, 1);
  renderChips();
  input.dispatchEvent(new Event('input'));
  input.focus();
}

async function openWeb(query, engine) {
  const url = `${WEB_SEARCH_URLS[engine] ?? WEB_SEARCH_URLS.default}${encodeURIComponent(query)}`;

  if (hasPrivateFilter()) {
    await invoke("open_url_private", { url });
  } else {
    await invoke("open_file", { path: url });
  }
}

async function render() {
  const rawInput = input.value.trim();
  const nonPrivateFilters = state.activeFilters.filter(f => !isPrivateFilter(f));
  const fullQuery = [...nonPrivateFilters, rawInput].join(" ").trim();
  const hasChips = state.activeFilters.length > 0;
  const isInputEmpty = rawInput.length === 0;

  if (isInputEmpty && !hasChips && !state.showRecents && state.results.length === 0) {
    resultsContainer.classList.add("hidden");
    searchLoader.classList.add("hidden");
    resultsList.innerHTML = "";
    updateContainerMinimalState();
    return;
  }

  resultsList.innerHTML = "";
  let items = [];

  const isPrivateMode = hasPrivateFilter();

  // The first word decides the intent: a web search engine ("/google", "/cerca"), a command
  // to run ("/cmd", "/esegui", "!cmd") or a question ("come …", "perché …", "how …").
  const [firstWord, restOfQuery] = splitFirstWord(fullQuery);
  const leadingFilter = parseFilterToken(firstWord);

  let activeEngine = "default";
  let webQuery = fullQuery;
  const isEngineTrigger = leadingFilter !== null && leadingFilter.prefix !== "!"
    && Object.hasOwn(WEB_ENGINES, leadingFilter.word);
  if (isEngineTrigger) {
    activeEngine = WEB_ENGINES[leadingFilter.word];
    webQuery = restOfQuery;
  }
  let isWebIntent = isEngineTrigger || QUESTION_WORDS.has(foldText(firstWord));

  if (!settingsPanel.classList.contains("hidden")) {
    items = [];
  } else if (isInputEmpty && !hasChips && state.results.length === 0) {
    if (state.showRecents) {
      items = state.recentFiles;
    } else {
      items = [];
    }
  } else {
    items = state.results;
  }

  const isCmdIntent = leadingFilter !== null && FILTER_WORDS.runCommand.includes(leadingFilter.word);

  if (isCmdIntent && !isInputEmpty) {
    // Whatever follows the filter word, whichever alias was used ("/cmd", "/esegui", …).
    const command = restOfQuery;
    const cmdItem = document.createElement("li");
    cmdItem.className = `result-item cmd-item ${state.selectedIndex === 0 ? "selected" : ""}`;
    cmdItem.innerHTML = `
        <span class="result-icon">💻</span>
        <div class="result-content">
          <span class="result-name">${RESULT_TEXT.runCommand}</span>
          <span class="result-path">${command.length > 0 ? `“${escapeHtml(command)}”` : RESULT_TEXT.typeCommand}</span>
        </div>`;

    if (command.length > 0) {
      cmdItem.onclick = () => openFile(command, "terminal_command", RESULT_TEXT.runPrefix + command);
    }
    cmdItem.onmouseenter = () => { state.selectedIndex = 0; renderStyles(); };
    resultsList.appendChild(cmdItem);

    updateContainerMinimalState();
    return;
  }

  if (isWebIntent && !isInputEmpty) {
    const webItem = document.createElement("li");
    webItem.className = `result-item web-search-item ${(state.selectedIndex === 0 && !isCmdIntent) ? "selected" : ""}`;

    const engineLabel = WEB_ENGINE_LABELS[activeEngine];
    let searchLabel;
    if (isPrivateMode) {
      searchLabel = engineLabel ? RESULT_TEXT.searchPrivateWith(engineLabel) : RESULT_TEXT.searchPrivate;
    } else {
      searchLabel = engineLabel ? RESULT_TEXT.searchWith(engineLabel) : RESULT_TEXT.searchWeb;
    }

    const searchIcon = isPrivateMode ? "🕶️" : "🌍";

    webItem.innerHTML = `
        <span class="result-icon">${searchIcon}</span>
        <div class="result-content">
          <span class="result-name">${searchLabel}</span>
          <span class="result-path">“${escapeHtml(webQuery)}”</span>
        </div>`;

    webItem.onclick = () => openWeb(webQuery, activeEngine);
    webItem.onmouseenter = () => { state.selectedIndex = isCmdIntent ? 1 : 0; renderStyles(); };

    if (!isCmdIntent) resultsList.appendChild(webItem);
  }

  if (items.length === 0 && !isWebIntent && !isCmdIntent && (!isInputEmpty || hasChips)) {
    const noResults = document.createElement("div");
    noResults.className = "empty-state";
    if (hasChips && isInputEmpty) {
      noResults.innerHTML = `
        <span>${RESULT_TEXT.noResultsWithFilters}</span>
      `;
    } else {
      noResults.innerHTML = `
        <span>${escapeHtml(RESULT_TEXT.noResults(rawInput))}</span>
      `;
    }
    resultsList.appendChild(noResults);
    updateContainerMinimalState();
    return;
  }

  items.forEach((item, index) => {
    const effectiveOffset = isWebIntent ? 1 : 0;
    const visualIndexCorrect = index + effectiveOffset;
    const isSelected = visualIndexCorrect === state.selectedIndex;

    const path = typeof item === 'string' ? item : item.path;
    const kind = typeof item === 'string' ? 'file' : item.kind;
    const name = typeof item === 'string' ? path.split('\\').pop() : (item.name || path.split('\\').pop());
    const iconData = (typeof item !== 'string' && item.icon_data) ? item.icon_data : null;

    const li = document.createElement("li");
    li.className = `result-item ${isSelected ? "selected" : ""}`;
    li.dataset.path = path;
    li.dataset.kind = kind;

    let iconHtml;
    if (iconData) {
      iconHtml = `<img src="${escapeHtml(iconData)}" class="app-icon" alt="" />`;
    } else {
      iconHtml = `<span class="result-icon">${getFileIcon(path, kind)}</span>`;
    }

    // Built-in paths (rocket:…, cmd:…, hwnd:…) are internal ids: the second line describes
    // the item instead. Files, folders, drives and sites keep their path or address.
    const displayPath = resultDetail(item, path, kind);

    li.innerHTML = `
      ${iconHtml}
      <div class="result-content">
        <span class="result-name">${escapeHtml(name)}</span>
        <span class="result-path">${escapeHtml(displayPath)}</span>
      </div>`;

    li.onclick = () => openFile(path, kind, name);
    li.onmouseenter = () => {
      state.selectedIndex = visualIndexCorrect;
      renderStyles();
    };
    resultsList.appendChild(li);
  });

  const renderedAnyItems = items.length > 0;
  let showedEmptyRecentMessage = false;

  if (isInputEmpty && state.showRecents && items.length === 0 && !hasChips) {
    const emptyMessage = document.createElement("div");
    emptyMessage.className = "empty-recents-message";
    emptyMessage.innerHTML = `
      <span class="result-icon">ℹ️</span>
      <div class="result-content">
        <span class="result-name">${RESULT_TEXT.recentsEmptyTitle}</span>
        <span class="result-path">${RESULT_TEXT.recentsEmptyHint}</span>
      </div>`;
    resultsList.appendChild(emptyMessage);
    showedEmptyRecentMessage = true;
  }

  const hasContent = renderedAnyItems || isWebIntent || isCmdIntent || showedEmptyRecentMessage || (items.length === 0 && !isWebIntent && !isCmdIntent && !isInputEmpty);

  if (hasContent && settingsPanel.classList.contains("hidden")) {
    resultsContainer.classList.remove("hidden");
  } else {
    resultsContainer.classList.add("hidden");
  }

  updateContainerMinimalState();
}

function updateContainerMinimalState() {
  const isSettingsHidden = settingsPanel.classList.contains("hidden");
  const isResultsHidden = resultsContainer.classList.contains("hidden");

  if (isSettingsHidden && isResultsHidden) {
    container.classList.add("minimal-state");
  } else {
    container.classList.remove("minimal-state");
  }
}

function renderStyles() {
  const items = document.querySelectorAll(".result-item");
  items.forEach((item, index) => {
    if (index === state.selectedIndex) {
      item.classList.add("selected");
      item.scrollIntoView({ block: "nearest" });
    } else {
      item.classList.remove("selected");
    }
  });
}

async function openFile(path, kind, name) {
  if (path.startsWith("nox:")) {
    const action = path.replace("nox:", "");
    if (action === "install" || action === "check_updates") {
      await invoke("open_file", { path: "https://github.com/YashvardhanG/Nox-Dimmer/releases/latest" });
    } else if (action === "help") {
      await invoke("open_file", { path: "https://github.com/YashvardhanG/Nox-Dimmer" });
    } else {
      await invoke("execute_nox_command", { action, value: null });
    }

    input.value = "";
    state.activeFilters = [];
    renderChips();
    state.results = [];

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }
    render();
    return;
  }

  if (!hasPrivateFilter()) {
    rememberRecent(path, kind, name);
  }

  if (path === "rocket:request_shutdown") {
    input.value = "";
    state.activeFilters = [];
    renderChips();

    state.results = [
      { name: RESULT_TEXT.shutdownConfirm, detail: RESULT_TEXT.shutdownDetail, path: SHUTDOWN_NOW_PATH, kind: "command", score: 10 },
      { name: RESULT_TEXT.powerCancel, detail: RESULT_TEXT.cancelDetail, path: CANCEL_POWER_PATH, kind: "command", score: 9 }
    ];

    state.selectedIndex = 0;
    render();
    return;
  }

  if (path === "rocket:request_restart") {
    input.value = "";
    state.activeFilters = [];
    renderChips();

    state.results = [
      { name: RESULT_TEXT.restartConfirm, detail: RESULT_TEXT.restartDetail, path: RESTART_NOW_PATH, kind: "command", score: 10 },
      { name: RESULT_TEXT.powerCancel, detail: RESULT_TEXT.cancelDetail, path: CANCEL_POWER_PATH, kind: "command", score: 9 }
    ];
    state.selectedIndex = 0;
    render();
    return;
  }

  if (path === CANCEL_POWER_PATH) {
    input.value = "";
    state.activeFilters = [];
    renderChips();
    state.results = [];

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }

    render();
    input.focus();
    return;
  }

  if (path === "rocket:settings") {
    await toggleSettings();
    input.value = "";
    state.results = [];
    render();
    input.focus();
    return;
  }

  if (path === "rocket:clear_recents") {
    state.recentFiles = [];
    localStorage.setItem("recentFiles", JSON.stringify([]));
    input.value = "";
    state.activeFilters = [];
    renderChips();

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }

    render();
    return;
  }

  if (path === "rocket:toggle_recents") {
    state.showRecents = !state.showRecents;
    localStorage.setItem("showRecentsSetting", state.showRecents);
    recentsToggle.checked = state.showRecents;
    input.value = "";

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    } else {
      await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    }

    render();
    return;
  }

  if (path === "rocket:help") {
    await invoke("open_file", { path: HELP_URL });
    input.value = "";
    state.results = [];
    render();
    return;
  }

  if (path === "rocket:reset_position") {
    await invoke("reset_window");
    input.value = "";
    render();
    return;
  }

  if (path === "rocket:quit") {
    await invoke("quit_app");
    return;
  }

  if (path === "rocket:close_window") {
    await invoke("close_active_window");
    input.value = "";
    state.activeFilters = [];
    renderChips();

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }

    render();
    return;
  }

  if (path === "rocket:show_desktop") {
    await invoke("show_desktop");
    input.value = "";
    state.activeFilters = [];
    renderChips();
    render();
    return;
  }

  if (path === "rocket:active_tabs") {
    state.activeFilters.push(OPEN_WINDOWS_CHIP);
    renderChips();
    input.value = "";
    input.focus();
    input.dispatchEvent(new Event('input'));
    return;
  }

  if (path.startsWith("hwnd:")) {
    const hwndVal = parseInt(path.split(":")[1].split("|")[0]);
    await invoke("focus_window", { hwndVal });
    input.value = "";
    state.activeFilters = [];
    renderChips();
    render();
    return;
  }

  if (path === "rocket:refresh") {
    input.disabled = true;
    input.value = "";
    state.results = [];
    state.activeFilters = [];
    renderChips();
    setPlaceholder("refreshing");

    resultsList.innerHTML = `
      <div class="empty-recents-message">
        <span class="result-icon" style="animation: spin 2s linear infinite;">⏳</span>
        <div class="result-content">
          <span class="result-name">${RESULT_TEXT.refreshingTitle}</span>
          <span class="result-path">${RESULT_TEXT.refreshingHint}</span>
        </div>
      </div>`;
    resultsContainer.classList.remove("hidden");
    await invoke("trigger_index_refresh");
    return;
  }

  if (kind === "filter") {
    // input.value = path;
    // input.focus();
    // input.dispatchEvent(new Event('input'));
    // return;

    state.activeFilters.push(path.trim());
    renderChips();

    input.value = "";
    input.focus();
    input.dispatchEvent(new Event('input'));
    return;
  }

  if (path.startsWith("rocket:media_")) {
    const action = path.replace("rocket:media_", "");
    await invoke("execute_media_key", { action });

    input.value = "";
    state.activeFilters = [];
    renderChips();
    state.results = [];

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }

    render();

    return;
  }

  if (kind === "terminal_command") {
    await invoke("run_terminal_command", { command: path });
    input.value = "";
    state.results = [];

    if (!state.showRecents) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }

    render();
    return;
  }

  if (hasPrivateFilter() && (path.startsWith("http://") || path.startsWith("https://"))) {
    await invoke("open_url_private", { url: path });
  } else {
    await invoke("open_file", { path });
  }
  input.value = "";
  state.activeFilters = [];
  renderChips();

  if (!state.showRecents) {
    await invoke("reset_window");
    lastWindowHeight = 65;
  }
  render();
}

async function showInExplorer(path) {
  await invoke("show_in_explorer", { path });
  input.value = "";
  state.activeFilters = [];
  renderChips();

  if (!state.showRecents) {
    await invoke("reset_window");
    lastWindowHeight = 65;
  }
  render();
}

// let debounceTimeout;
input.addEventListener("input", async (e) => {
  let val = input.value;

  if (val.endsWith(" ") && val.trim().length > 1) {
    const words = val.split(" ");
    const lastWord = words[words.length - 2];

    if (lastWord.startsWith("@") || lastWord.startsWith("/") || lastWord.startsWith("!")) {
      state.activeFilters.push(lastWord);
      renderChips();

      input.value = "";
      val = "";
    }
  }

  deselectChips();

  const isSettingsOpen = !settingsPanel.classList.contains("hidden");
  const hasSettingsFilter = state.activeFilters.includes(SETTINGS_CHIP);
  if (isSettingsOpen && (val.trim().length > 0 || !hasSettingsFilter)) {
    await toggleSettings();
  }

  // clearTimeout(debounceTimeout);

  // debounceTimeout = setTimeout(async () => {
  const query = [...state.activeFilters.filter(f => !isPrivateFilter(f)), val].join(" ").trim();

  currentSearchId++;
  const thisSearchId = currentSearchId;
  state.selectedIndex = 0;

  const hasPrivateChip = hasPrivateFilter();

  if (query.trim().length === 0 && !hasPrivateChip) {
    state.results = [];
    lastRenderedSearchId = thisSearchId;
    searchLoader.classList.add("hidden");
    resultsContainer.classList.add("hidden");
    if (!state.showRecents && settingsPanel.classList.contains("hidden")) {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }
    render();
    return;
  }

  if (query.trim().length > 0) {
    if (lastWindowHeight !== WINDOW_MAX_HEIGHT) {
      await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    }
    resultsContainer.classList.remove("hidden");
  }

  const valTrimmed = val.trim();
  const isFilterTrigger = valTrimmed.startsWith("@") || valTrimmed.startsWith("/") || valTrimmed.startsWith("!");

  if (isFilterTrigger && valTrimmed.indexOf(" ") === -1) {
    const drives = await invoke("get_available_drives");
    const prefix = valTrimmed[0];
    const searchTerm = foldText(valTrimmed.substring(1));

    const driveSuggestions = drives.map(d => ({
      name: RESULT_TEXT.drive(d),
      token: `${d[0].toLowerCase()}:`,
      words: FILTER_WORDS.drives,
      score: 97
    }));

    const matchedFilters = [...FILTER_SUGGESTIONS, ...driveSuggestions]
      .filter(suggestion => suggestionMatches(suggestion, searchTerm))
      .map(({ name, token, score }) => ({ name, path: `${prefix}${token}`, kind: "filter", score }));

    if (matchedFilters.length > 0) {
      state.results = matchedFilters.sort((a, b) => b.score - a.score);
      if (resultsContainer.classList.contains("hidden")) {
        invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
        lastWindowHeight = WINDOW_MAX_HEIGHT;
        resultsContainer.classList.remove("hidden");
      }
      render();
      return;
    }
  }

  if (resultsContainer.classList.contains("hidden") || (!state.showRecents && state.results.length === 0)) {
    invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
    lastWindowHeight = WINDOW_MAX_HEIGHT;
    resultsContainer.classList.remove("hidden");
  }

  searchLoader.classList.remove("hidden");
  const searchQuery = [...state.activeFilters, val].join(" ").trim();
  const results = await invoke("search_files", { query: searchQuery || "/p" });

  if (thisSearchId < lastRenderedSearchId) {
    return;
  }

  lastRenderedSearchId = thisSearchId;

  if (thisSearchId === currentSearchId) {
    searchLoader.classList.add("hidden");
  }

  state.results = results;

  render();
  // }, 150);
});

document.addEventListener('keydown', async (e) => {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) {
    return;
  }

  if (isAllSelected && e.key !== "Backspace" && !(e.ctrlKey && e.key.toLowerCase() === 'a')) {
    const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
    const isPasteOrCut = e.ctrlKey && (e.key.toLowerCase() === 'v' || e.key.toLowerCase() === 'x');
    const isCopy = e.ctrlKey && e.key.toLowerCase() === 'c';

    if (isCopy) {
      return;
    }

    if (isPrintable || isPasteOrCut) {
      state.activeFilters = [];
      renderChips();
      input.value = "";
      isAllSelected = false;
      return;
    }

    deselectChips();
  }

  if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    if (input.value.length > 0 || state.activeFilters.length > 0) {
      selectAllChips();
    }
    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    deselectChips();

    const isInputEmpty = input.value === "";
    const isSettingsHidden = settingsPanel.classList.contains("hidden");
    const isDropdownHidden = shortcutDropdown.classList.contains("hidden");
    const areChipsEmpty = state.activeFilters.length === 0;

    if (isInputEmpty && isSettingsHidden && isDropdownHidden && areChipsEmpty) {
      await getCurrentWindow().hide();
      return;
    }

    input.value = "";
    state.activeFilters = [];
    renderChips();
    state.results = [];

    settingsPanel.classList.add("hidden");
    settingsBtn.classList.remove("active");
    shortcutDropdown.classList.add("hidden");

    render();
    input.focus();

    if (state.showRecents) {
      await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    } else {
      await invoke("reset_window");
      lastWindowHeight = 65;
    }
    return;
  }

  if (e.key === "Backspace") {
    if (isAllSelected) {
      e.preventDefault();
      state.activeFilters = [];
      input.value = "";
      renderChips();
      deselectChips();

      input.dispatchEvent(new Event('input'));
      return;

      // state.results = [];
      // if (!state.showRecents) {
      //   await invoke("reset_window");
      //   lastWindowHeight = 65;
      // }
      // render();
      // return;
    }

    if (input.value === "") {
      if (state.activeFilters.length > 0) {
        state.activeFilters.pop();
        renderChips();

        input.dispatchEvent(new Event('input'));
        return;
        // const fullQuery = state.activeFilters.join(" ");
        // if (fullQuery.length === 0) {
        //   state.results = [];
        //   if (!state.showRecents) {
        //     await invoke("reset_window");
        //     lastWindowHeight = 65;
        //   }
        // } else {
        //   const results = await invoke("search_files", { query: fullQuery });
        //   state.results = results;
        // }
        // render();
        // return;
      }
    }
  }

  if (!shortcutDropdown.classList.contains("hidden")) {
    const options = document.querySelectorAll(".shortcut-option");
    if (options.length === 0) return;

    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      dropdownIndex = (dropdownIndex + 1) % options.length;
      renderDropdownFocus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      dropdownIndex = (dropdownIndex - 1 + options.length) % options.length;
      renderDropdownFocus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (dropdownIndex >= 0 && options[dropdownIndex]) {
        options[dropdownIndex].click();
      }
    }
    return;
  }

  if (!settingsPanel.classList.contains("hidden")) {
    const focusables = getSettingsFocusables();

    if (e.key === "Tab") {
      e.preventDefault();
      toggleSettings();
      return;
    }

    if (e.key === "ArrowRight") {
      e.preventDefault();
      settingsIndex = (settingsIndex + 1) % focusables.length;
      renderSettingsFocus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (settingsIndex === -1) {
        settingsIndex = focusables.length - 1;
      } else {
        settingsIndex = (settingsIndex - 1 + focusables.length) % focusables.length;
      }
      renderSettingsFocus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (settingsIndex >= 0 && settingsIndex <= 3) {
        settingsIndex = (settingsIndex <= 1) ? 4 : 5;
      } else if (settingsIndex === 4 || settingsIndex === 5) {
        settingsIndex = (settingsIndex === 4) ? 6 : 7;
      } else if (settingsIndex === 6 || settingsIndex === 7) {
        settingsIndex = settingsIndex - 6;
      } else {
        settingsIndex = 0;
      }
      renderSettingsFocus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (settingsIndex >= 0 && settingsIndex <= 3) {
        settingsIndex = (settingsIndex <= 1) ? 6 : 7;
      } else if (settingsIndex === 4 || settingsIndex === 5) {
        settingsIndex = (settingsIndex === 4) ? 0 : 2;
      } else if (settingsIndex === 6 || settingsIndex === 7) {
        settingsIndex = (settingsIndex === 6) ? 4 : 5;
      } else {
        settingsIndex = focusables.length - 1;
      }
      renderSettingsFocus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();

      if (settingsIndex >= 0) {
        const item = focusables[settingsIndex];
        if (item === shortcutDisplay) {
          item.click();
          dropdownIndex = 0;
          setTimeout(renderDropdownFocus, 50);
        } else if (item.classList.contains("toggle-switch-container")) {
          const checkbox = item.querySelector('input[type="checkbox"]');
          if (checkbox) {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          }
        } else {
          item.click();
        }
      }
    }
    return;
  }

  if (e.key === " " && input.value.length === 0) {
    e.preventDefault();
    return;
  }

  // let useResults = input.value.trim() !== "" || state.activeFilters.length > 0;
  // let items = (useResults) ? state.results : (state.showRecents ? state.recentFiles : []);

  // if (items.length === 0) {
  //   if (e.key === "Tab") {
  //     e.preventDefault();
  //     toggleSettings();
  //   }
  //   return;
  // }

  const items = document.querySelectorAll(".result-item");

  if (items.length === 0) {
    if (e.key === "Tab") {
      e.preventDefault();
      toggleSettings();
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.selectedIndex = (state.selectedIndex + 1) % items.length;
    renderStyles();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.selectedIndex = (state.selectedIndex - 1 + items.length) % items.length;
    renderStyles();
  } else if (e.key === "Enter" && e.ctrlKey) {
    e.preventDefault();
    const selectedEl = items[state.selectedIndex];
    if (selectedEl && selectedEl.dataset.path) {
      const filePath = selectedEl.dataset.path;
      const kind = selectedEl.dataset.kind;

      if (kind !== 'command' && kind !== 'filter' && kind !== 'website' && kind !== 'terminal_command'
        && !filePath.startsWith('rocket:') && !filePath.startsWith('cmd:') && !filePath.startsWith('nox:')
        && !filePath.startsWith('http://') && !filePath.startsWith('https://') && !filePath.startsWith('hwnd:')) {
        showInExplorer(filePath);
      }
    }
  } else if (e.key === "Enter") {
    e.preventDefault();

    if (commitTypedFilter(items)) {
      return;
    }

    const selectedEl = items[state.selectedIndex];
    if (selectedEl) {
      selectedEl.click();
    }

    // const item = items[state.selectedIndex];
    // if (item) {
    //   const path = typeof item === 'string' ? item : item.path;
    //   const kind = typeof item === 'string' ? 'file' : item.kind;
    //   const name = typeof item === 'string' ? path.split('\\').pop() : (item.name || path.split('\\').pop());
    //   openFile(path, kind, name);
    // }

  } else if (e.key === "Tab") {
    e.preventDefault();
    if (commitTypedFilter(items)) {
      return;
    }
    toggleSettings();
  }
});

// Enter or Tab on a filter word being typed. A partial or unknown word ("/cart") takes the
// highlighted suggestion ("/cartelle") instead of becoming a chip that matches nothing; a
// known word, a drive letter or an extension ("/pdf", no suggestion) becomes a chip as typed.
function commitTypedFilter(items) {
  const val = input.value.trim();
  if (parseFilterToken(val) === null) return false;

  const selectedEl = items[state.selectedIndex];
  if (selectedEl && selectedEl.dataset.kind === "filter" && !isKnownFilterWord(val)) {
    selectedEl.click();
    return true;
  }

  if (state.selectedIndex !== 0) return false;

  state.activeFilters.push(val);
  renderChips();
  input.value = "";
  input.dispatchEvent(new Event('input'));
  return true;
}

render();

window.addEventListener('focus', () => {
  input.focus();
});

listen('reset_state', async () => {
  input.value = "";
  state.activeFilters = [];
  renderChips();

  state.results = [];
  state.selectedIndex = 0;
  settingsPanel.classList.add("hidden");
  settingsBtn.classList.remove("active");
  shortcutDropdown.classList.add("hidden");
  render();
  input.focus();

  if (state.showRecents) {
    await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
    lastWindowHeight = WINDOW_MAX_HEIGHT;
  } else {
    await invoke("reset_window");
    lastWindowHeight = 65;
  }
});

let recordedShortcut = "";

// "Super+Shift+." is shown as "Win + Maiusc + ."; the stored value keeps the accelerator.
function formatShortcutForDisplay(str) {
  return str
    .split("+")
    .map(key => SHORTCUT_KEY_LABELS[key] ?? key)
    .join(" + ");
}

async function loadCurrentShortcut() {
  const current = await invoke("get_current_shortcut");
  shortcutDisplay.textContent = formatShortcutForDisplay(current);
  shortcutDisplay.dataset.value = current;
}

function checkDropdownSize() {
  if (!shortcutDropdown.classList.contains("hidden")) {
    const dropdownHeight = shortcutDropdown.scrollHeight + shortcutDropdown.offsetTop + 20;
    if (dropdownHeight > WINDOW_MAX_HEIGHT) {
      invoke("resize_window", { height: dropdownHeight });
      return;
    }
  }
  invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
}

shortcutDisplay.onclick = async (e) => {
  e.stopPropagation();
  if (shortcutDropdown.classList.contains("hidden")) {
    shortcutDropdown.classList.remove("hidden");
    await renderDropdown();
  } else {
    shortcutDropdown.classList.add("hidden");
  }
  checkDropdownSize();
};

async function renderDropdown() {
  shortcutDropdown.innerHTML = `<div class="shortcut-option" style="cursor: default;">${SHORTCUT_TEXT.checking}</div>`;
  const currentVal = shortcutDisplay.dataset.value;

  let availableShortcuts = [];
  try {
    availableShortcuts = await invoke("check_shortcuts_availability", { shortcuts: PRESET_SHORTCUTS });
  } catch (e) {
    console.error(e);
    availableShortcuts = PRESET_SHORTCUTS.map(() => true);
  }

  shortcutDropdown.innerHTML = "";

  let sortedShortcuts = PRESET_SHORTCUTS.map((sc, i) => ({
    shortcut: sc,
    available: availableShortcuts[i]
  }));

  sortedShortcuts.sort((a, b) => {
    if (a.available === b.available) return 0;
    return a.available ? -1 : 1;
  });

  sortedShortcuts.forEach(({ shortcut, available }) => {
    const div = document.createElement("div");
    div.className = "shortcut-option";
    div.textContent = formatShortcutForDisplay(shortcut);

    if (shortcut === currentVal) {
      div.classList.add("active");
    }

    if (!available) {
      div.classList.add("unavailable");
      const lock = document.createElement("span");
      lock.style.float = "right";
      lock.textContent = "🔒";
      div.append(" ", lock);
      div.title = SHORTCUT_TEXT.unavailable;
      div.setAttribute("aria-disabled", "true");
      div.style.opacity = '0.5';
      div.style.cursor = 'not-allowed';
    } else {
      div.onclick = () => applyShortcut(shortcut);
    }

    shortcutDropdown.appendChild(div);
  });

  checkDropdownSize();
}

// Which message the shortcut line shows ("updated" clears itself after 2 s).
let shortcutMsgState = "";

function showShortcutMessage(stateKey, color) {
  shortcutMsgState = stateKey;
  shortcutMsg.textContent = stateKey ? SHORTCUT_TEXT[stateKey] : "";
  if (color) {
    shortcutMsg.style.color = color;
    shortcutMsg.style.fontSize = "12px";
  }
}

async function applyShortcut(newShortcut) {
  shortcutDropdown.classList.add("hidden");
  updateWindowSize();
  shortcutDisplay.textContent = SHORTCUT_TEXT.applying;
  showShortcutMessage("");

  try {
    const success = await invoke("update_shortcut", { newShortcut });

    if (success) {
      shortcutDisplay.textContent = formatShortcutForDisplay(newShortcut);
      shortcutDisplay.dataset.value = newShortcut;
      showShortcutMessage("updated", "#4caf50");

      setTimeout(() => {
        if (shortcutMsgState === "updated") showShortcutMessage("");
      }, 2000);

    } else {
      const current = await invoke("get_current_shortcut");
      shortcutDisplay.textContent = formatShortcutForDisplay(current);
      shortcutDisplay.dataset.value = current;
      showShortcutMessage("rejected", "#ff5555");
    }
  } catch (err) {
    console.error(err);
    showShortcutMessage("failed", "#ff5555");
    loadCurrentShortcut();
  }
}

input.addEventListener("click", () => {
  deselectChips();
});

document.addEventListener("click", (e) => {
  if (!shortcutDisplay.contains(e.target) && !shortcutDropdown.contains(e.target)) {
    shortcutDropdown.classList.add("hidden");
    updateWindowSize();
  }

  if (!e.target.closest("#search-wrapper")) {
    deselectChips();
  }
});

loadCurrentShortcut();

async function initAutostart() {
  try {
    const isEnabled = await invoke("plugin:autostart|is_enabled");
    if (startupToggle) startupToggle.checked = isEnabled;
  } catch (err) {
    console.error("Autostart init error:", err);
  }
}

if (startupToggle) {
  startupToggle.onchange = async (e) => {
    try {
      if (e.target.checked) {
        await invoke("plugin:autostart|enable");
      } else {
        await invoke("plugin:autostart|disable");
      }
    } catch (err) {
      console.error("Autostart toggle error:", err);
      e.target.checked = !e.target.checked;
    }
  };
}

initAutostart();

if (helpBtn) {
  helpBtn.onclick = async (e) => {
    e.stopPropagation();
    await invoke("open_file", { path: HELP_URL });
  };
}

let lastWindowHeight = 0;

if (!state.showRecents) {
  invoke("reset_window");
  lastWindowHeight = 65;
} else {
  invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
  lastWindowHeight = WINDOW_MAX_HEIGHT;
}

function updateWindowSize() {
  let height = container.offsetHeight;

  height = Math.ceil(height);

  if (height !== lastWindowHeight) {
    lastWindowHeight = height;
    invoke("resize_window", { height });
  }
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

input.focus();

listen("index_refreshed", async () => {
  input.disabled = false;
  input.value = "";
  setPlaceholder(hasPrivateFilter() ? "private" : "default");
  state.results = [];
  input.focus();

  if (!state.showRecents) {
    resultsContainer.classList.add("hidden");
    await invoke("reset_window");
    lastWindowHeight = 65;
  } else {
    await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
    lastWindowHeight = WINDOW_MAX_HEIGHT;
  }

  render();

  if (!hasCheckedStartupUpdate) {
    hasCheckedStartupUpdate = true;
    setTimeout(() => {
      checkUpdates(true);
    }, 500);
  }
});

async function checkInitialIndexing() {
  const isIndexing = await invoke("get_indexing_state");

  if (isIndexing) {
    input.disabled = true;
    input.value = "";
    state.results = [];
    state.activeFilters = [];
    renderChips();
    setPlaceholder("indexing");

    if (state.showRecents) {
      resultsList.innerHTML = `
        <div class="empty-recents-message">
          <span class="result-icon" style="animation: spin 2s linear infinite;">⏳</span>
          <div class="result-content">
            <span class="result-name">${RESULT_TEXT.indexingTitle}</span>
            <span class="result-path">${RESULT_TEXT.indexingHint}</span>
          </div>
        </div>`;
      resultsContainer.classList.remove("hidden");
      await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    } else {
      resultsContainer.classList.add("hidden");
      await invoke("reset_window");
      lastWindowHeight = 65;
    }
    updateContainerMinimalState();

    return true;
  }

  return false;
}

checkInitialIndexing().then((isIndexing) => {
  if (!isIndexing) {
    hasCheckedStartupUpdate = true;
    checkUpdates(true);
  }
});