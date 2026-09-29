import { HELP_URL, LATEST_RELEASE_URL, REPOSITORY_URL, findUpdate } from "./update-source.js";
import { iconElement, iconNameFor } from "./icons.js";
import {
  BINDING_PROBLEM_TEXT,
  DEFAULT_BINDINGS,
  DEFAULT_SHORTCUT,
  IN_APP_ACTIONS,
  PRESET_SHORTCUTS,
  SHORTCUT_PROBLEM_TEXT,
  acceleratorFromKeyEvent,
  actionLabel as keyActionLabel,
  actionUsingAccelerator,
  bindingFromKeyEvent,
  bindingKeys,
  bindingOverrides,
  bindingProblem,
  formatAccelerator,
  formatBinding,
  formatPendingModifiers,
  globalShortcutProblem,
  isAltGraph,
  matchesBinding,
  normalizeAccelerator,
  resolveBindings
} from "./shortcuts.js";
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---------------------------------------------------------------------------
// Interface text (Italian). Everything the user reads is defined here, except the key names and the messages about
// shortcuts, which are in shortcuts.js; the logic compares keys, kinds and paths, never the text on screen.
// ---------------------------------------------------------------------------

const PLACEHOLDERS = {
  default: "Cerca app, file, cartelle e comandi",
  private: "Modalità privata: ricerche web in incognito",
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

// Keys are called "tasti di scelta rapida", as in Windows; one combination is a "combinazione". The global shortcut
// shows RocketLauncher from any app; the other keys work inside it.
const SHORTCUT_TEXT = {
  hint: "Apre RocketLauncher da qualsiasi app",
  // Not "Applicazione…": alone it reads as "app".
  applying: "Verifica in corso…",
  checking: "Verifica disponibilità…",
  recording: "Premi la combinazione…",
  recordingHint: "Premi i tasti, Esc per annullare",
  unavailable: "Non disponibile: già in uso da un'altra app",
  reservedPreset: "Non disponibile: riservata a Windows",
  activePreset: "Combinazione in uso",
  defaultPreset: "Predefinita",
  updated: "Tasti di scelta rapida aggiornati",
  rejected: "Combinazione già in uso o non valida",
  failed: "Impossibile cambiare la combinazione",
  bindingSaved: "Aggiornato",
  bindingRestored: "Ripristinato",
  bindingFailed: "Impossibile salvare",
  bindingsReset: "Ripristinati",
  restoreTitle: (defaultKeys) => `Ripristina il tasto predefinito (${defaultKeys})`,
  recorderTitle: "Clic o Invio per registrare una nuova combinazione",
  // At start-up another app held the saved combination: a preset stands in until the next start.
  standIn: (preferred, current) => `${preferred} era occupata: per ora ${current}`
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
  noResultsWithFilters: (key) => `Nessun risultato con questi filtri. Premi ${key} per rimuovere l'ultimo.`,
  recentsEmptyTitle: "Qui compariranno gli elementi aperti di recente",
  recentsEmptyHint: (key) => `Puoi nasconderli nelle impostazioni (${key})`,
  refreshingTitle: "Aggiornamento dell'indice in corso…",
  refreshingHint: "Richiede qualche istante",
  indexingTitle: "Indicizzazione dei file in corso…",
  indexingHint: "All'avvio richiede qualche istante",
  searchingTitle: "Ricerca in corso…",
  shutdownConfirm: "Sì, arresta il sistema",
  restartConfirm: "Sì, riavvia il sistema",
  powerCancel: "No, annulla",
  shutdownDetail: "Chiude tutte le app e spegne il computer",
  restartDetail: "Chiude tutte le app e riavvia il computer",
  cancelDetail: "Torna alla ricerca",
  removeFilter: "Rimuovi filtro",
  // get_available_drives answers with the root ("C:\"); the label shows only the letter and the colon.
  drive: (root) => `Unità ${root.slice(0, 2)}`
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

// Pill on the right of a row: what kind of item it is.
const KIND_LABELS = {
  app: "App",
  folder: "Cartella",
  file: "File",
  drive: "Unità",
  command: "Comando",
  website: "Sito web",
  active_tab: "Finestra",
  filter: "Filtro",
  terminal_command: "Terminale",
  web_search: "Ricerca web",
  windowsSettings: "Impostazioni"
};

// What Enter does on the selected row (row hint and accent key in the action bar).
const ACTION_LABELS = {
  launch: "Avvia",
  open: "Apri",
  run: "Esegui",
  show: "Mostra",
  add: "Aggiungi",
  search: "Cerca",
  shutdown: "Spegni",
  restart: "Riavvia",
  cancel: "Annulla"
};

// Key hints in the action bar, by state.
const KEY_HINT_TEXT = {
  choose: "Scegli",
  revealInExplorer: "Mostra in Esplora file",
  settings: "Impostazioni",
  clear: "Azzera",
  hide: "Nascondi",
  move: "Sposta",
  activate: "Attiva",
  backToSearch: "Torna alla ricerca",
  back: "Indietro",
  cancel: "Annulla"
};

// Title of the settings button; the key is the one of "Apri e chiudi le impostazioni".
const SETTINGS_BUTTON_TITLE = (key) => `Impostazioni (${key})`;

const RECENTS_TITLE = "Recenti";

const NUMBER_FORMAT = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Rows of the shutdown and restart confirmation.
const SHUTDOWN_NOW_PATH = "cmd:shutdown /s /t 0";
const RESTART_NOW_PATH = "cmd:shutdown /r /t 0";
const CANCEL_POWER_PATH = "rocket:cancel_power";
// Position of "No, annulla" in the confirmation, the row selected when it appears.
const POWER_CANCEL_INDEX = 1;

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

// A query whose first word is one of these is offered as a web search. Accents are ignored and the
// typographic apostrophe is straightened, so "perche" and "perché", "cos'è" and "cos’è" all count.
// Bare "che" and "cose" are left out: they are too common as the start of a file name.
const QUESTION_WORDS = new Set([
  "come", "com'e", "cosa", "cos'e", "perche", "quando", "chi", "dove",
  "qual", "quale", "quali", "quanto", "quanta", "quanti", "quante",
  "how", "what", "why", "when", "who"
]);

// File names, window titles of other apps and typed text are always set as text (textContent),
// never parsed as HTML: a page title such as "<img onerror=…>" shown under /finestre must not run
// script. The only markup inserted as HTML is the constant icon SVG from icons.js.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function keyCap(label, primary = false) {
  return el("kbd", primary ? "primary" : "", label);
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

function kindLabel(path, kind) {
  if (kind === "command" && path.startsWith("ms-settings:")) return KIND_LABELS.windowsSettings;
  if (kind === "app" && path.startsWith("cmd:explorer ")) return KIND_LABELS.folder;
  return KIND_LABELS[kind] ?? KIND_LABELS.file;
}

// The verb for Enter on a row, from its kind and path (the same cases openFile() handles).
function actionLabel(path, kind) {
  if (path === SHUTDOWN_NOW_PATH) return ACTION_LABELS.shutdown;
  if (path === RESTART_NOW_PATH) return ACTION_LABELS.restart;
  if (path === CANCEL_POWER_PATH) return ACTION_LABELS.cancel;
  switch (kind) {
    case "app":
      return path.startsWith("cmd:explorer ") ? ACTION_LABELS.open : ACTION_LABELS.launch;
    case "command":
      if (path === "rocket:settings" || path === "rocket:help") return ACTION_LABELS.open;
      if (path === "nox:install" || path === "nox:help" || path === "nox:check_updates") return ACTION_LABELS.open;
      if (path.startsWith("rocket:") || path.startsWith("nox:")) return ACTION_LABELS.run;
      return ACTION_LABELS.open;
    case "terminal_command":
      return ACTION_LABELS.run;
    case "active_tab":
      return ACTION_LABELS.show;
    case "filter":
      return ACTION_LABELS.add;
    default:
      return ACTION_LABELS.open;
  }
}

// Ctrl+Enter shows the item in File Explorer: files, folders, drives and apps only.
function canRevealInExplorer(path, kind) {
  return kind !== "command" && kind !== "filter" && kind !== "website" && kind !== "terminal_command"
    && !path.startsWith("rocket:") && !path.startsWith("cmd:") && !path.startsWith("nox:")
    && !path.startsWith("http://") && !path.startsWith("https://") && !path.startsWith("hwnd:");
}

// Icon of a row: the system icon extracted by main.rs when there is one, otherwise a Lucide glyph.
function rowIcon(iconName, iconData) {
  if (typeof iconData === "string" && iconData.startsWith("data:image/")) {
    const img = el("img", "app-icon");
    img.alt = "";
    img.src = iconData;
    return img;
  }
  const tile = el("span", "result-icon");
  tile.appendChild(iconElement(iconName));
  return tile;
}

// A selectable row: li.result-item with icon, name, second line, Enter hint and kind pill.
function resultRow({ name, detail, iconName, iconData, action, kind, badge, selected, revealable = false }) {
  const li = el("li", `result-item${selected ? " selected" : ""}`);
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(selected));
  li.dataset.action = action;
  if (revealable) li.dataset.reveal = "";

  const content = el("div", "result-content");
  content.append(el("span", "result-name", name), el("span", "result-path", detail));

  const hint = el("span", "result-hint");
  hint.append(keyCap("↵"), action);
  const meta = el("span", "result-meta");
  meta.append(hint, el("span", "result-kind", badge ?? kindLabel("", kind)));

  li.append(rowIcon(iconName, iconData), content, meta);
  return li;
}

// A row that informs but cannot be opened (empty recents, index being built).
function infoRow(iconName, title, subtitle, spinning = false) {
  const row = el("div", "empty-recents-message");
  const tile = el("span", "result-icon");
  tile.appendChild(iconElement(iconName, spinning ? "icon spin" : "icon"));
  const content = el("div", "result-content");
  content.append(el("span", "result-name", title), el("span", "result-path", subtitle));
  row.append(tile, content);
  return row;
}

// The row shown while the index is built at start-up or rebuilt on request, by placeholder key.
const INDEX_STATUS_ROWS = {
  indexing: () => infoRow("loader-circle", RESULT_TEXT.indexingTitle, RESULT_TEXT.indexingHint, true),
  refreshing: () => infoRow("loader-circle", RESULT_TEXT.refreshingTitle, RESULT_TEXT.refreshingHint, true)
};

const input = document.getElementById("search-input");
const container = document.getElementById("container");
const resultsContainer = document.getElementById("results-container");
const resultsList = document.getElementById("results");
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
// The settings show one view at a time: the two cards, or the page of every key ("Tasti di scelta rapida").
const settingsMainView = document.getElementById("settings-main");
const keysView = document.getElementById("keys-view");
const recentsToggle = document.getElementById("show-recents-toggle");
const clearRecentsBtn = document.getElementById("clear-recents-btn");
const resetPosBtn = document.getElementById("reset-pos-btn");
// The global shortcut recorder of the main view; the keys page has a second one (both are [data-recorder="global"]).
const shortcutDisplay = document.getElementById("shortcut-display");
const keysOpenBtn = document.getElementById("keys-open-btn");
const keysBackBtn = document.getElementById("keys-back-btn");
const keysResetBtn = document.getElementById("keys-reset-btn");
const keysGlobalRecorder = document.getElementById("keys-global-recorder");
const presetList = document.getElementById("preset-list");
const actionList = document.getElementById("action-list");
const startupToggle = document.getElementById("startup-toggle");
const analyticsToggle = document.getElementById("analytics-toggle");
const updateBtn = document.getElementById("update-btn");
const memoryDisplay = document.getElementById("memory-usage");
const helpBtn = document.getElementById("help-btn");
const keyHints = document.getElementById("key-hints");
const licenseLink = document.getElementById("license-link");
const legalLinks = [...document.querySelectorAll(".legal a")];
const searchWrapper = document.querySelector(".search-wrapper");

// Window material chosen by main.rs (Mica, Acrylic or none) and who rounds the corners: styles.css
// picks the density of the glass and the corner radius that matches the window.
invoke("window_material")
  .then(({ material, corners }) => {
    document.documentElement.dataset.material = material;
    document.documentElement.dataset.corners = corners;
  })
  .catch((err) => console.error("Window material unavailable:", err));

// Links in the legal notice open in the default browser; the licence link is built from the
// repository constant in update-source.js.
if (licenseLink) licenseLink.href = `${REPOSITORY_URL}/blob/main/LICENSE`;
document.querySelectorAll("a[data-external]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_file", { path: link.href });
  });
});
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

// Keys of the in-app actions, from settings.json through resolveBindings(); the defaults until main.rs answers.
let bindings = { ...DEFAULT_BINDINGS };
// The global shortcut in use, as main.rs registered it.
let currentShortcut = "";
// The character the user's keyboard layout gives each punctuation key (main.rs, keyboard_layout_labels): "tokens" for
// the global shortcut (by virtual key), "codes" for the in-app keys (by physical key). Empty: US names.
let layoutLabels = { tokens: {}, codes: {} };
// The recorder waiting for a combination, if any: { kind: "global" | "action", action, element, busy }.
let recording = null;

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

function isKeysViewOpen() {
  return !settingsPanel.classList.contains("hidden") && !keysView.classList.contains("hidden");
}

// Every control of the settings view on screen, in reading order (main view: left card, right card, then the links
// of the licence notice; keys page: back, the global shortcut and its quick picks, then the in-app keys). The arrow
// keys move between them by position on screen (moveSettingsFocus), so the order only decides where the first press
// lands.
function getSettingsFocusables() {
  const base = isKeysViewOpen()
    ? [
      keysBackBtn,
      keysGlobalRecorder,
      ...presetList.querySelectorAll(".preset-option"),
      keysResetBtn,
      ...actionList.querySelectorAll(".key-recorder"),
      ...actionList.querySelectorAll(".key-restore:not([hidden])")
    ]
    : [
      shortcutDisplay,
      keysOpenBtn,
      recentsToggle.parentElement,
      startupToggle.parentElement,
      analyticsToggle.parentElement,
      updateBtn,
      clearRecentsBtn,
      resetPosBtn,
      helpBtn,
      ...legalLinks
    ];
  return base.filter(node => node !== null);
}

// Arrow keys move the settings cursor to the nearest control in that direction. The first press
// selects the top-left control (Down/Right) or the bottom-right one (Up/Left); no wrap-around.
function moveSettingsFocus(dx, dy) {
  const items = getSettingsFocusables();
  if (items.length === 0) return;
  if (settingsIndex < 0 || settingsIndex >= items.length) {
    settingsIndex = (dx < 0 || dy < 0) ? items.length - 1 : 0;
    renderSettingsFocus();
    return;
  }
  const from = items[settingsIndex].getBoundingClientRect();
  let best = -1;
  let bestScore = Infinity;
  items.forEach((node, i) => {
    if (i === settingsIndex) return;
    const r = node.getBoundingClientRect();
    // Distance in the direction of the arrow, between the facing edges: controls behind or level with the
    // current one are skipped. Toggle rows span a whole card, so centres alone would mislead.
    const along = dx > 0 ? r.left - from.right
      : dx < 0 ? from.left - r.right
        : dy > 0 ? r.top - from.bottom
          : from.top - r.bottom;
    if (along < -4) return;
    // Offset across the arrow: zero when the two controls overlap on that axis.
    const [a1, a2, b1, b2] = dx !== 0 ? [from.top, from.bottom, r.top, r.bottom] : [from.left, from.right, r.left, r.right];
    const gap = Math.max(0, b1 - a2, a1 - b2);
    const centreOffset = Math.abs((b1 + b2) / 2 - (a1 + a2) / 2);
    const score = along + gap * 20 + centreOffset / 8;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best >= 0) {
    settingsIndex = best;
    renderSettingsFocus();
  }
}

function renderSettingsFocus() {
  settingsPanel.querySelectorAll(".selected").forEach((node) => node.classList.remove("selected"));
  const item = getSettingsFocusables()[settingsIndex];
  if (item) {
    item.classList.add("selected");
    item.scrollIntoView({ block: "nearest" });
  }
  renderKeyHints();
}

invoke("set_recents_state", { show: state.showRecents });

// Window heights, the same as COLLAPSED_HEIGHT and EXPANDED_HEIGHT in main.rs and --bar-h in styles.css:
// collapsed shows only the search bar.
const WINDOW_MIN_HEIGHT = 56;
const WINDOW_MAX_HEIGHT = 400;
// Height of the action bar at the bottom (--foot-h in styles.css).
const FOOTER_HEIGHT = 40;
// Tallest the settings may make the window, for two-line messages on the keys page; beyond it the panel scrolls.
const SETTINGS_MAX_HEIGHT = 460;

// Open settings take the height of the view on screen (the two cards and the licence line, or the keys page), with
// the search bar above and the action bar below: no empty glass under the last line. The children of a view keep
// their own height whatever the window height is, so this can be measured before resizing.
function settingsWindowHeight() {
  const view = isKeysViewOpen() ? keysView : settingsMainView;
  const panelStyle = getComputedStyle(settingsPanel);
  const viewStyle = getComputedStyle(view);
  const children = [...view.children].filter((child) => !child.classList.contains("hidden"));
  const content = children.reduce((sum, child) => sum + child.offsetHeight, 0)
    + (parseFloat(viewStyle.rowGap) || 0) * Math.max(0, children.length - 1)
    + parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom);
  return Math.min(SETTINGS_MAX_HEIGHT, Math.ceil(WINDOW_MIN_HEIGHT + content + FOOTER_HEIGHT));
}

async function fitSettingsWindow() {
  if (settingsPanel.classList.contains("hidden")) return;
  const height = settingsWindowHeight();
  if (height !== lastWindowHeight) {
    lastWindowHeight = height;
    await invoke("resize_window", { height });
  }
}

// Shows the page of every key (from the arrow button next to the global shortcut) or goes back to the two cards.
// From the keyboard the cursor lands where it makes sense: on the back button, or back on the arrow button.
async function showKeysView(show, { fromKeyboard = false } = {}) {
  if (show === isKeysViewOpen()) return;
  cancelRecording();
  settingsMainView.classList.toggle("hidden", show);
  keysView.classList.toggle("hidden", !show);
  const focusables = getSettingsFocusables();
  settingsIndex = fromKeyboard ? focusables.indexOf(show ? keysBackBtn : keysOpenBtn) : -1;
  renderSettingsFocus();
  if (show) renderPresets();
  await fitSettingsWindow();
}

async function toggleSettings() {
  const isOpening = settingsPanel.classList.contains("hidden");

  if (isOpening) {
    settingsIndex = -1;
    settingsMainView.classList.remove("hidden");
    keysView.classList.add("hidden");
    renderSettingsFocus();
    refreshLayoutLabels();

    settingsPanel.classList.remove("hidden");
    settingsBtn.classList.add("active");
    resultsContainer.classList.add("hidden");
    updateContainerMinimalState();

    if (!state.activeFilters.includes(SETTINGS_CHIP)) {
      state.activeFilters.push(SETTINGS_CHIP);
      renderChips();
    }
    await fitSettingsWindow();
  } else {
    cancelRecording();
    settingsPanel.classList.add("hidden");
    settingsMainView.classList.remove("hidden");
    keysView.classList.add("hidden");
    settingsPanel.querySelectorAll(".selected").forEach((node) => node.classList.remove("selected"));
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
        lastWindowHeight = WINDOW_MIN_HEIGHT;
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
  clearRecentsBtn.classList.add("btn-success");
  setTimeout(() => {
    clearRecentsBtn.textContent = CLEAR_RECENTS_LABELS.idle;
    clearRecentsBtn.classList.remove("btn-success");
  }, 1500);

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

  await saveBindings({ ...DEFAULT_BINDINGS });
  await applyShortcut(DEFAULT_SHORTCUT);

  await fitSettingsWindow();
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

function selectAllChips() {
  isAllSelected = true;
  document.querySelectorAll(".chip").forEach(chip => chip.classList.add("selected"));
  input.select();
}

function deselectChips() {
  input.setSelectionRange(input.value.length, input.value.length);

  if (!isAllSelected) return;
  isAllSelected = false;
  document.querySelectorAll(".chip").forEach(chip => chip.classList.remove("selected"));
}

function renderChips() {
  const chipsArea = document.getElementById("chips-area");
  chipsArea.replaceChildren();

  state.activeFilters.forEach((filter, index) => {
    const chip = el("div", "chip");
    if (isPrivateFilter(filter)) chip.dataset.private = "";

    const close = el("span", "chip-close");
    close.title = RESULT_TEXT.removeFilter;
    close.setAttribute("aria-label", RESULT_TEXT.removeFilter);
    close.appendChild(iconElement("x"));
    close.onclick = (e) => {
      e.stopPropagation();
      removeFilter(index);
    };

    chip.append(el("span", "chip-label", filter), close);
    chipsArea.appendChild(chip);
  });

  if (hasPrivateFilter()) {
    setPlaceholder("private");
  } else if (placeholderKey === "private") {
    setPlaceholder("default");
  }
  renderKeyHints();
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
    resultsList.replaceChildren();
    updateContainerMinimalState();
    return;
  }

  // While the index is built or rebuilt the search box is disabled: whenever the list is shown (the window
  // coming back with the recents on, the settings closing) it keeps saying so instead of listing the recents.
  const indexStatusRow = INDEX_STATUS_ROWS[placeholderKey];
  if (input.disabled && indexStatusRow && settingsPanel.classList.contains("hidden")) {
    resultsList.replaceChildren(indexStatusRow());
    resultsContainer.classList.remove("hidden");
    updateContainerMinimalState();
    return;
  }

  resultsList.replaceChildren();
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
    const cmdItem = resultRow({
      name: RESULT_TEXT.runCommand,
      detail: command.length > 0 ? `“${command}”` : RESULT_TEXT.typeCommand,
      iconName: "square-terminal",
      action: ACTION_LABELS.run,
      badge: KIND_LABELS.terminal_command,
      selected: state.selectedIndex === 0
    });
    cmdItem.classList.add("cmd-item");

    if (command.length > 0) {
      cmdItem.onclick = () => openFile(command, "terminal_command", RESULT_TEXT.runPrefix + command);
    }
    cmdItem.onmouseenter = () => { state.selectedIndex = 0; renderStyles(); };
    resultsList.appendChild(cmdItem);

    updateContainerMinimalState();
    return;
  }

  if (isWebIntent && !isInputEmpty) {
    const engineLabel = WEB_ENGINE_LABELS[activeEngine];
    let searchLabel;
    if (isPrivateMode) {
      searchLabel = engineLabel ? RESULT_TEXT.searchPrivateWith(engineLabel) : RESULT_TEXT.searchPrivate;
    } else {
      searchLabel = engineLabel ? RESULT_TEXT.searchWith(engineLabel) : RESULT_TEXT.searchWeb;
    }

    const webItem = resultRow({
      name: searchLabel,
      detail: `“${webQuery}”`,
      iconName: isPrivateMode ? "venetian-mask" : "search",
      action: ACTION_LABELS.search,
      badge: KIND_LABELS.web_search,
      selected: state.selectedIndex === 0 && !isCmdIntent
    });
    webItem.classList.add("web-search-item");

    webItem.onclick = () => openWeb(webQuery, activeEngine);
    webItem.onmouseenter = () => { state.selectedIndex = isCmdIntent ? 1 : 0; renderStyles(); };

    if (!isCmdIntent) resultsList.appendChild(webItem);
  }

  if (items.length === 0 && !isWebIntent && !isCmdIntent && (!isInputEmpty || hasChips)) {
    const noResults = el("li", "empty-state");
    noResults.setAttribute("role", "presentation");
    const tile = el("span", "empty-icon");
    tile.appendChild(iconElement("search-x"));
    const message = hasChips && isInputEmpty
      ? RESULT_TEXT.noResultsWithFilters(bindingText("removeChip"))
      : RESULT_TEXT.noResults(rawInput);
    noResults.append(tile, el("span", "empty-title", message));
    resultsList.appendChild(noResults);
    updateContainerMinimalState();
    return;
  }

  if (items === state.recentFiles && items.length > 0) {
    const header = el("li", "section-title", RECENTS_TITLE);
    header.setAttribute("role", "presentation");
    resultsList.appendChild(header);
  }

  items.forEach((item, index) => {
    const effectiveOffset = isWebIntent ? 1 : 0;
    const visualIndexCorrect = index + effectiveOffset;
    const isSelected = visualIndexCorrect === state.selectedIndex;

    const path = typeof item === 'string' ? item : item.path;
    const kind = typeof item === 'string' ? 'file' : item.kind;
    const name = typeof item === 'string' ? path.split('\\').pop() : (item.name || path.split('\\').pop());
    const iconData = (typeof item !== 'string' && item.icon_data) ? item.icon_data : null;

    // Built-in paths (rocket:…, cmd:…, hwnd:…) are internal ids: the second line describes
    // the item instead. Files, folders, drives and sites keep their path or address.
    const li = resultRow({
      name,
      detail: resultDetail(item, path, kind),
      iconName: iconNameFor(path, kind),
      iconData,
      action: actionLabel(path, kind),
      kind,
      badge: kindLabel(path, kind),
      selected: isSelected,
      revealable: canRevealInExplorer(path, kind)
    });
    li.dataset.path = path;
    li.dataset.kind = kind;
    if (kind === "file" || kind === "folder" || kind === "drive") li.title = path;

    li.onclick = () => openFile(path, kind, name);
    li.onmouseenter = () => {
      state.selectedIndex = visualIndexCorrect;
      renderStyles();
    };
    resultsList.appendChild(li);
  });

  // A new list starts from the top (the container would otherwise keep the scroll position of the
  // previous one); later moves keep the selected row in view through renderStyles().
  if (state.selectedIndex === 0) {
    resultsContainer.scrollTop = 0;
  } else {
    resultsList.querySelector(".result-item.selected")?.scrollIntoView({ block: "nearest" });
  }

  const renderedAnyItems = items.length > 0;
  let showedEmptyRecentMessage = false;

  if (isInputEmpty && state.showRecents && items.length === 0 && !hasChips) {
    resultsList.appendChild(infoRow("rotate-ccw-clock", RESULT_TEXT.recentsEmptyTitle,
      RESULT_TEXT.recentsEmptyHint(bindingText("settings"))));
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
  updateAriaState();
  renderKeyHints();
}

// For screen readers the search box is a combobox whose popup is the result list: the focus never leaves
// the box, so the selected row is announced as its active descendant.
function updateAriaState() {
  const rows = resultsList.querySelectorAll(".result-item");
  rows.forEach((row, index) => {
    row.id = `result-${index}`;
  });
  const isListShown = !resultsContainer.classList.contains("hidden") && rows.length > 0;
  input.setAttribute("aria-expanded", String(isListShown));
  const selected = rows[state.selectedIndex];
  if (isListShown && selected) {
    input.setAttribute("aria-activedescendant", selected.id);
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function renderStyles() {
  const items = document.querySelectorAll(".result-item");
  items.forEach((item, index) => {
    const isSelected = index === state.selectedIndex;
    item.classList.toggle("selected", isSelected);
    item.setAttribute("aria-selected", String(isSelected));
    if (isSelected) item.scrollIntoView({ block: "nearest" });
  });
  updateAriaState();
  renderKeyHints();
}

// The keys of an in-app action as the action bar shows them (Enter as ↵).
function hintKeys(actionId) {
  return bindingKeys(bindings[actionId], layoutLabels.codes, { compact: true });
}

// The keys of an in-app action in running text ("Tab", "Ctrl + Invio").
function bindingText(actionId) {
  return formatBinding(bindings[actionId], layoutLabels.codes);
}

// The action bar at the bottom: brand on the left, the keys that work right now on the right. The
// Enter key is filled with the accent and named after what it does on the selected row. The keys of the
// actions are the user's own (Tasti di scelta rapida); arrows, Enter and Esc in the settings are fixed.
function renderKeyHints() {
  if (!keyHints) return;
  const hints = [];
  const hint = (keys, label, primary = false) => hints.push({ keys, label, primary });
  const escLabel = input.value.length > 0 || state.activeFilters.length > 0 ? KEY_HINT_TEXT.clear : KEY_HINT_TEXT.hide;

  if (recording) {
    hint(["Esc"], KEY_HINT_TEXT.cancel);
  } else if (isKeysViewOpen()) {
    hint(["↑", "↓", "←", "→"], KEY_HINT_TEXT.move);
    hint(["↵"], KEY_HINT_TEXT.activate, true);
    hint(["Esc"], KEY_HINT_TEXT.back);
    hint(hintKeys("settings"), KEY_HINT_TEXT.backToSearch);
  } else if (!settingsPanel.classList.contains("hidden")) {
    hint(["↑", "↓", "←", "→"], KEY_HINT_TEXT.move);
    hint(["↵"], KEY_HINT_TEXT.activate, true);
    hint(hintKeys("settings"), KEY_HINT_TEXT.backToSearch);
  } else {
    const rows = document.querySelectorAll(".result-item");
    const selected = rows[state.selectedIndex];
    if (rows.length > 1) hint(["↑", "↓"], KEY_HINT_TEXT.choose);
    if (selected && selected.dataset.action) hint(["↵"], selected.dataset.action, true);
    if (selected && selected.dataset.reveal !== undefined) hint(hintKeys("reveal"), KEY_HINT_TEXT.revealInExplorer);
    hint(hintKeys("settings"), KEY_HINT_TEXT.settings);
    hint(hintKeys("clear"), escLabel);
  }

  keyHints.replaceChildren(...hints.map(({ keys, label, primary }) => {
    const item = el("span", "hint-item");
    item.append(...keys.map((key) => keyCap(key, primary && key === "↵")), label);
    return item;
  }));
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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

    // "No, annulla" is preselected: a second Enter never shuts the computer down by accident.
    state.selectedIndex = POWER_CANCEL_INDEX;
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
    state.selectedIndex = POWER_CANCEL_INDEX;
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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

    resultsList.replaceChildren(INDEX_STATUS_ROWS.refreshing());
    resultsContainer.classList.remove("hidden");
    updateContainerMinimalState();
    await invoke("trigger_index_refresh");
    return;
  }

  if (kind === "filter") {
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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
    lastWindowHeight = WINDOW_MIN_HEIGHT;
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
    lastWindowHeight = WINDOW_MIN_HEIGHT;
  }
  render();
}

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
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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
    if (lastWindowHeight !== WINDOW_MAX_HEIGHT) {
      invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    }
    resultsContainer.classList.remove("hidden");
  }

  // The list can open before the first answer arrives (scanning a large index takes a moment): it says that
  // the search is running instead of showing empty glass. Rows already on screen stay until the new ones
  // replace them, and a quick answer never flashes the message over a "no results" line.
  const showSearching = () => {
    if (thisSearchId !== currentSearchId || lastRenderedSearchId >= thisSearchId) return;
    if (resultsList.querySelector(".result-item")) return;
    const typed = val.trim();
    const subject = typed.length > 0 ? `“${typed}”` : state.activeFilters.join(" ");
    resultsList.replaceChildren(infoRow("loader-circle", RESULT_TEXT.searchingTitle, subject, true));
    updateContainerMinimalState();
  };
  if (resultsList.childElementCount === 0) showSearching();
  const searchingTimer = setTimeout(showSearching, 150);

  searchLoader.classList.remove("hidden");
  const searchQuery = [...state.activeFilters, val].join(" ").trim();
  const results = await invoke("search_files", { query: searchQuery || "/p" });
  clearTimeout(searchingTimer);

  if (thisSearchId < lastRenderedSearchId) {
    return;
  }

  lastRenderedSearchId = thisSearchId;

  if (thisSearchId === currentSearchId) {
    searchLoader.classList.add("hidden");
  }

  state.results = results;

  render();
});

// Closes the settings without the resize and re-render that toggleSettings() does (the caller does them).
function hideSettingsPanel() {
  cancelRecording();
  settingsPanel.classList.add("hidden");
  settingsMainView.classList.remove("hidden");
  keysView.classList.add("hidden");
  settingsPanel.querySelectorAll(".selected").forEach((node) => node.classList.remove("selected"));
  settingsBtn.classList.remove("active");
}

// "Azzera la ricerca o nascondi" (Esc by default): clears text and chips and closes the settings; with
// everything already empty it hides the bar.
async function clearOrHide() {
  deselectChips();
  const isSettingsHidden = settingsPanel.classList.contains("hidden");
  if (input.value === "" && isSettingsHidden && state.activeFilters.length === 0) {
    await invoke("hide_window");
    return;
  }

  input.value = "";
  state.activeFilters = [];
  renderChips();
  state.results = [];
  hideSettingsPanel();

  render();
  input.focus();

  if (state.showRecents) {
    await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
    lastWindowHeight = WINDOW_MAX_HEIGHT;
  } else {
    await invoke("reset_window");
    lastWindowHeight = WINDOW_MIN_HEIGHT;
  }
}

// Enter or Space on the control under the settings cursor.
function activateSettingsItem(item) {
  if (item === keysOpenBtn) {
    showKeysView(true, { fromKeyboard: true });
  } else if (item === keysBackBtn) {
    showKeysView(false, { fromKeyboard: true });
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

// The keys of the in-app actions are the user's own (shortcuts.js, matchesBinding); the arrows and Enter are fixed,
// and Esc always goes back from the keys page or cancels a recording. Keys typed with AltGr (Ctrl + Alt on Windows:
// @ # [ ] € on an Italian keyboard) never match an action and are never stopped, so they reach the search box.
document.addEventListener('keydown', async (e) => {
  if (recording) {
    handleRecorderKey(e);
    return;
  }

  if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'].includes(e.key)) {
    return;
  }

  const altGraph = isAltGraph(e);
  const isSelectAll = matchesBinding(e, bindings.selectAll);
  const deletesSelection = (e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey;

  if (isAllSelected && !deletesSelection && !isSelectAll) {
    const lowerKey = e.key.toLowerCase();
    const isPrintable = e.key.length === 1 && (altGraph || (!e.ctrlKey && !e.altKey && !e.metaKey));
    const isPasteOrCut = e.ctrlKey && !altGraph && (lowerKey === 'v' || lowerKey === 'x');
    const isCopy = e.ctrlKey && !altGraph && lowerKey === 'c';

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

  if (isSelectAll) {
    e.preventDefault();
    if (input.value.length > 0 || state.activeFilters.length > 0) {
      selectAllChips();
    }
    return;
  }

  const isSettingsOpen = !settingsPanel.classList.contains("hidden");

  // Esc on the keys page goes back to the two cards; in the settings it always closes them.
  if (e.key === "Escape" && isKeysViewOpen()) {
    e.preventDefault();
    showKeysView(false, { fromKeyboard: true });
    return;
  }

  if (matchesBinding(e, bindings.clear) || (e.key === "Escape" && isSettingsOpen)) {
    e.preventDefault();
    await clearOrHide();
    return;
  }

  if (deletesSelection && isAllSelected) {
    e.preventDefault();
    state.activeFilters = [];
    input.value = "";
    renderChips();
    deselectChips();

    input.dispatchEvent(new Event('input'));
    return;
  }

  // "Rimuovi l'ultimo filtro" works only with the search box empty, so its key never deletes typed text.
  if (matchesBinding(e, bindings.removeChip) && input.value === "" && state.activeFilters.length > 0) {
    e.preventDefault();
    state.activeFilters.pop();
    renderChips();

    input.dispatchEvent(new Event('input'));
    return;
  }

  if (isSettingsOpen) {
    const focusables = getSettingsFocusables();

    if (matchesBinding(e, bindings.settings)) {
      e.preventDefault();
      toggleSettings();
      return;
    }
    if (e.key === "Tab") {
      // The focus stays in the search box, whatever key opens the settings.
      e.preventDefault();
      return;
    }

    const arrows = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (arrows[e.key]) {
      e.preventDefault();
      moveSettingsFocus(...arrows[e.key]);
    } else if ((e.key === "Enter" || e.key === " ") && !altGraph) {
      e.preventDefault();
      if (settingsIndex >= 0 && focusables[settingsIndex]) activateSettingsItem(focusables[settingsIndex]);
    }
    return;
  }

  if (e.key === " " && input.value.length === 0) {
    e.preventDefault();
    return;
  }

  const items = document.querySelectorAll(".result-item");

  // Tab completes a filter word being typed (/cart -> /cartelle) and never moves the focus out of the search box.
  if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (items.length > 0 && commitTypedFilter(items)) {
      return;
    }
  }

  if (matchesBinding(e, bindings.settings)) {
    e.preventDefault();
    toggleSettings();
    return;
  }

  if (items.length === 0) {
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
  } else if (matchesBinding(e, bindings.reveal)) {
    e.preventDefault();
    const selectedEl = items[state.selectedIndex];
    if (selectedEl && selectedEl.dataset.path && canRevealInExplorer(selectedEl.dataset.path, selectedEl.dataset.kind)) {
      showInExplorer(selectedEl.dataset.path);
    }
  } else if (e.key === "Enter" && !altGraph) {
    e.preventDefault();

    if (commitTypedFilter(items)) {
      return;
    }

    const selectedEl = items[state.selectedIndex];
    if (selectedEl) {
      selectedEl.click();
    }
  }
});

// While a combination is recorded, releasing a modifier updates the preview ("Ctrl + …").
document.addEventListener('keyup', (e) => {
  if (!recording || recording.busy) return;
  const result = recording.kind === "global" ? acceleratorFromKeyEvent(e) : bindingFromKeyEvent(e);
  if (result.pending) showRecordingPreview(result.mods);
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

// Resolves once the current page has been painted: two animation frames, or a short timeout when the page is not being
// drawn, so revealing the window never waits for a frame that will not come.
function afterPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 100);
  });
}

// Back to the empty bar: when the window hides, so the next show never flashes the last search, and on every show.
function clearSearchView() {
  input.value = "";
  state.activeFilters = [];
  renderChips();
  state.results = [];
  state.selectedIndex = 0;
  hideSettingsPanel();
  render();
}

listen("window_hidden", () => {
  clearSearchView();
});

// main.rs shows the window cloaked (not drawn yet) and sends "reset_state": the page clears the search, takes its
// height, paints, and only then asks to be revealed. The glass and the bar appear together, without an entrance
// animation that would start from a half-drawn window.
listen('reset_state', async (event) => {
  clearSearchView();
  input.focus();
  refreshLayoutLabels();

  // The tray item "Impostazioni" shows the window with the settings open: the way back when another program
  // takes the global shortcut.
  if (event?.payload?.openSettings) {
    await toggleSettings();
  } else if (state.showRecents) {
    await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
    lastWindowHeight = WINDOW_MAX_HEIGHT;
  } else {
    await invoke("reset_window");
    lastWindowHeight = WINDOW_MIN_HEIGHT;
  }

  await afterPaint();
  await invoke("reveal_window");
});

// ---------------------------------------------------------------------------
// Tasti di scelta rapida: the global shortcut (recorded, or picked from the Velocmd presets) and the keys of the
// in-app actions. A recorder is a button: click or Enter starts recording, the next combination is checked
// (shortcuts.js, then main.rs for the global one) and kept only when valid; Esc cancels and the old keys stay.
// ---------------------------------------------------------------------------

const globalRecorders = () => [...document.querySelectorAll('[data-recorder="global"]')];
const globalMessages = () => [...document.querySelectorAll("[data-shortcut-msg]")];

// Which message the global shortcut rows show ("" = the description; "updated" clears itself after 2 s).
let shortcutMsgState = "";

// Colour by outcome: styles.css paints .is-ok green and .is-error red; every refusal is an error.
const SHORTCUT_MESSAGE_TONE = { updated: "is-ok", recording: "" };

function showShortcutMessage(stateKey, text = null) {
  shortcutMsgState = stateKey;
  const message = text
    ?? (stateKey === "" ? SHORTCUT_TEXT.hint
      : stateKey === "recording" ? SHORTCUT_TEXT.recordingHint
        : SHORTCUT_TEXT[stateKey] ?? SHORTCUT_PROBLEM_TEXT[stateKey] ?? SHORTCUT_TEXT.rejected);
  const tone = stateKey === "" ? "" : SHORTCUT_MESSAGE_TONE[stateKey] ?? "is-error";
  for (const node of globalMessages()) {
    node.textContent = message;
    node.title = message;
    node.classList.remove("is-ok", "is-error");
    if (tone) node.classList.add(tone);
  }
  if (stateKey === "updated") {
    setTimeout(() => {
      if (shortcutMsgState === "updated") showShortcutMessage("");
    }, 2000);
  }
  fitSettingsWindow();
}

// Message under an in-app action: its description, the recording prompt, the outcome or why the keys were refused.
function showBindingMessage(actionId, stateKey, otherAction = null) {
  const node = actionList.querySelector(`[data-binding-msg="${actionId}"]`);
  if (!node) return;
  let text;
  if (!stateKey) text = IN_APP_ACTIONS.find(({ id }) => id === actionId)?.hint ?? "";
  else if (stateKey === "recording") text = SHORTCUT_TEXT.recordingHint;
  else if (stateKey === "saved") text = SHORTCUT_TEXT.bindingSaved;
  else if (stateKey === "restored") text = SHORTCUT_TEXT.bindingRestored;
  else if (stateKey === "save_failed") text = SHORTCUT_TEXT.bindingFailed;
  else if (stateKey === "conflict") text = BINDING_PROBLEM_TEXT.conflict(keyActionLabel(otherAction));
  else text = BINDING_PROBLEM_TEXT[stateKey] ?? SHORTCUT_TEXT.rejected;
  const isOk = stateKey === "saved" || stateKey === "restored";
  node.textContent = text;
  node.title = text;
  node.classList.toggle("is-ok", isOk);
  node.classList.toggle("is-error", Boolean(stateKey) && !isOk && stateKey !== "recording");
  if (isOk) {
    setTimeout(() => {
      if (node.textContent === text && recording?.action !== actionId) showBindingMessage(actionId, "");
    }, 2000);
  }
  fitSettingsWindow();
}

// Layout characters of the punctuation keys, read again whenever the settings open (the layout may have changed).
function refreshLayoutLabels() {
  return invoke("keyboard_layout_labels")
    .then((labels) => {
      if (labels && typeof labels === "object") {
        layoutLabels = { tokens: labels.tokens ?? {}, codes: labels.codes ?? {} };
        renderShortcutViews();
      }
    })
    .catch((err) => console.error("Keyboard layout unavailable:", err));
}

// A long combination ("Win + Ctrl + Maiusc + Spazio") is cut with an ellipsis in the recorder: its tooltip names it in
// full, before the hint.
function recorderTitle(text) {
  return text ? `${text} · ${SHORTCUT_TEXT.recorderTitle}` : SHORTCUT_TEXT.recorderTitle;
}

function renderGlobalShortcut() {
  for (const recorder of globalRecorders()) {
    if (recording?.element === recorder) continue;
    const text = currentShortcut ? formatAccelerator(currentShortcut, layoutLabels.tokens) : "…";
    recorder.textContent = text;
    recorder.title = recorderTitle(currentShortcut ? text : "");
    recorder.dataset.value = currentShortcut;
    recorder.setAttribute("aria-label", `Tasti di scelta rapida: ${text}`);
  }
}

function renderActionRecorders() {
  for (const recorder of actionList.querySelectorAll(".key-recorder")) {
    const { action } = recorder.dataset;
    const restore = actionList.querySelector(`[data-restore="${action}"]`);
    if (restore) {
      const defaultText = formatBinding(DEFAULT_BINDINGS[action], layoutLabels.codes);
      restore.hidden = bindings[action] === DEFAULT_BINDINGS[action];
      restore.title = SHORTCUT_TEXT.restoreTitle(defaultText);
      restore.setAttribute("aria-label", `${SHORTCUT_TEXT.restoreTitle(defaultText)}: ${keyActionLabel(action)}`);
    }
    if (recording?.element === recorder) continue;
    const text = formatBinding(bindings[action], layoutLabels.codes);
    recorder.textContent = text;
    recorder.title = recorderTitle(text);
    recorder.dataset.value = bindings[action];
    recorder.setAttribute("aria-label", `${keyActionLabel(action)}: ${text}`);
  }
}

// Everything that shows a key: both global recorders, the quick picks, the action recorders, the settings button
// title and the action bar.
function renderShortcutViews() {
  renderGlobalShortcut();
  renderActionRecorders();
  renderPresetsState();
  settingsBtn.title = SETTINGS_BUTTON_TITLE(bindingText("settings"));
  renderKeyHints();
}

function buildActionRows() {
  actionList.replaceChildren(...IN_APP_ACTIONS.map(({ id, label, hint }) => {
    const row = el("div", "setting-row key-row");
    const text = el("span", "setting-text");
    const message = el("span", "setting-hint binding-msg", hint ?? "");
    message.dataset.bindingMsg = id;
    message.setAttribute("aria-live", "polite");
    text.append(el("span", "setting-label", label), message);

    const recorder = el("button", "key-recorder");
    recorder.type = "button";
    recorder.dataset.recorder = "action";
    recorder.dataset.action = id;
    recorder.title = SHORTCUT_TEXT.recorderTitle;
    // Clicks keep the focus in the search box, like every control of the settings.
    recorder.onmousedown = (e) => e.preventDefault();
    recorder.onclick = (e) => {
      e.stopPropagation();
      startRecording("action", recorder, id);
    };

    // Back to this action's default key only (Esc cancels a recording, so it cannot be recorded again): shown while
    // the key differs from the default.
    const restore = el("button", "icon-btn key-restore");
    restore.type = "button";
    restore.dataset.restore = id;
    restore.hidden = true;
    restore.append(iconElement("rotate-ccw"));
    restore.onmousedown = (e) => e.preventDefault();
    restore.onclick = (e) => {
      e.stopPropagation();
      restoreDefaultBinding(id);
    };

    const controls = el("span", "shortcut-controls");
    controls.append(restore, recorder);
    row.append(text, controls);
    return row;
  }));
}

async function restoreDefaultBinding(actionId) {
  cancelRecording();
  const binding = DEFAULT_BINDINGS[actionId];
  const problem = bindingProblem(actionId, binding, bindings, currentShortcut, layoutLabels);
  if (problem) {
    showBindingMessage(actionId, problem.reason, problem.action);
    return;
  }
  const saved = await saveBindings({ ...bindings, [actionId]: binding });
  // The button disappears with the custom key: the keyboard cursor moves to the action's recorder.
  if (settingsIndex >= 0) {
    const recorder = actionList.querySelector(`.key-recorder[data-action="${actionId}"]`);
    const index = getSettingsFocusables().indexOf(recorder);
    if (index >= 0) {
      settingsIndex = index;
      renderSettingsFocus();
    }
  }
  showBindingMessage(actionId, saved ? "restored" : "save_failed");
}

// ---- Quick picks: the eight Velocmd presets, with their state on this computer ----

// Per preset: "reserved" (Windows keeps it), "unavailable" (another app has it), "free", or "checking".
let presetStatus = {};
let presetCheckId = 0;

function buildPresetList() {
  presetList.replaceChildren(...PRESET_SHORTCUTS.map((preset) => {
    const option = el("button", "preset-option");
    option.type = "button";
    option.dataset.value = preset;
    option.onmousedown = (e) => e.preventDefault();
    option.onclick = (e) => {
      e.stopPropagation();
      pickPreset(preset);
    };
    return option;
  }));
}

function renderPresetsState() {
  const current = normalizeAccelerator(currentShortcut);
  for (const option of presetList.querySelectorAll(".preset-option")) {
    const value = option.dataset.value;
    const status = presetStatus[value] ?? "free";
    const isActive = normalizeAccelerator(value) === current;
    const isLocked = !isActive && (status === "reserved" || status === "unavailable");
    option.textContent = formatAccelerator(value, layoutLabels.tokens);
    option.classList.toggle("active", isActive);
    option.classList.toggle("unavailable", isLocked);
    option.classList.toggle("is-loading", !isActive && status === "checking");
    option.setAttribute("aria-pressed", String(isActive));
    option.setAttribute("aria-disabled", String(isLocked));
    const titles = [];
    if (isActive) titles.push(SHORTCUT_TEXT.activePreset);
    else if (status === "reserved") titles.push(SHORTCUT_TEXT.reservedPreset);
    else if (status === "unavailable") titles.push(SHORTCUT_TEXT.unavailable);
    else if (status === "checking") titles.push(SHORTCUT_TEXT.checking);
    if (value === DEFAULT_SHORTCUT) titles.push(SHORTCUT_TEXT.defaultPreset);
    option.title = titles.join(" · ");
  }
}

// Marks the presets Windows reserves at once, then asks main.rs which of the others another app already has.
async function renderPresets() {
  const checkId = ++presetCheckId;
  presetStatus = Object.fromEntries(PRESET_SHORTCUTS.map((preset) =>
    [preset, globalShortcutProblem(preset) ? "reserved" : "checking"]));
  renderPresetsState();

  let available;
  try {
    available = await invoke("check_shortcuts_availability", { shortcuts: PRESET_SHORTCUTS });
  } catch (err) {
    console.error(err);
    available = PRESET_SHORTCUTS.map(() => true);
  }
  if (checkId !== presetCheckId) return;
  PRESET_SHORTCUTS.forEach((preset, index) => {
    if (presetStatus[preset] !== "reserved") presetStatus[preset] = available[index] ? "free" : "unavailable";
  });
  renderPresetsState();
}

function pickPreset(preset) {
  cancelRecording();
  const isActive = normalizeAccelerator(preset) === normalizeAccelerator(currentShortcut);
  const status = presetStatus[preset];
  if (!isActive && status === "reserved") {
    showShortcutMessage(globalShortcutProblem(preset) ?? "reserved");
  } else if (!isActive && status === "unavailable") {
    showShortcutMessage("in_use");
  } else {
    applyShortcut(preset);
  }
}

// ---- Global shortcut ----

// Registers a global shortcut through main.rs (update_shortcut). Refused combinations never reach it; one Windows
// refuses (another app has it) leaves the previous shortcut registered. Returns the outcome: "updated", a reason of
// globalShortcutProblem, "in_app", "in_use" or "failed".
async function applyShortcut(accelerator) {
  const shortcut = normalizeAccelerator(accelerator) ?? accelerator;
  const problem = globalShortcutProblem(shortcut);
  if (problem) {
    showShortcutMessage(problem);
    return problem;
  }
  const usedBy = actionUsingAccelerator(shortcut, bindings, layoutLabels);
  if (usedBy) {
    showShortcutMessage("in_app", SHORTCUT_PROBLEM_TEXT.in_app(usedBy.label));
    return "in_app";
  }

  for (const recorder of globalRecorders()) recorder.textContent = SHORTCUT_TEXT.applying;
  showShortcutMessage("");

  let outcome;
  try {
    outcome = await invoke("update_shortcut", { newShortcut: shortcut });
  } catch (err) {
    console.error(err);
    outcome = "failed";
  }

  if (outcome === "updated") {
    currentShortcut = shortcut;
  } else {
    try {
      currentShortcut = await invoke("get_current_shortcut");
    } catch (err) {
      console.error(err);
    }
  }
  renderShortcutViews();
  showShortcutMessage(outcome === "updated" || outcome === "failed" || SHORTCUT_PROBLEM_TEXT[outcome] ? outcome : "rejected");
  return outcome;
}

// ---- In-app keys ----

// Keeps the keys of the actions in this session at once and saves the ones that differ from the defaults in
// settings.json (main.rs, save_key_bindings). False when saving failed.
async function saveBindings(next) {
  bindings = { ...next };
  renderShortcutViews();
  if (!resultsContainer.classList.contains("hidden")) render();
  try {
    return (await invoke("save_key_bindings", { bindings: bindingOverrides(bindings) })) !== false;
  } catch (err) {
    console.error("Key bindings not saved:", err);
    return false;
  }
}

// ---- Recording ----

function startRecording(kind, element, action = null) {
  if (recording?.element === element) return;
  cancelRecording();
  recording = { kind, element, action, busy: false };
  element.classList.add("recording");
  element.setAttribute("aria-pressed", "true");
  element.textContent = SHORTCUT_TEXT.recording;
  if (kind === "global") showShortcutMessage("recording");
  else showBindingMessage(action, "recording");
  // The global shortcut is suspended while recording: pressing it (or a combination near it) is recorded instead of
  // hiding the window. main.rs registers it again when the recording ends or the window hides.
  invoke("set_shortcut_recording", { active: true }).catch((err) => console.error(err));
  const index = getSettingsFocusables().indexOf(element);
  if (index >= 0) {
    settingsIndex = index;
    renderSettingsFocus();
  }
  renderKeyHints();
}

// Ends the recording and shows the keys in use again; the message of the last outcome stays.
function stopRecording() {
  if (!recording) return;
  const { element } = recording;
  recording = null;
  element.classList.remove("recording");
  element.removeAttribute("aria-pressed");
  invoke("set_shortcut_recording", { active: false }).catch((err) => console.error(err));
  renderShortcutViews();
}

// Esc, a click elsewhere, closing the settings or hiding the window: nothing changes.
function cancelRecording() {
  if (!recording) return;
  const { kind, action } = recording;
  stopRecording();
  if (kind === "global") showShortcutMessage("");
  else showBindingMessage(action, "");
}

function showRecordingPreview(mods) {
  if (recording) recording.element.textContent = formatPendingModifiers(mods) || SHORTCUT_TEXT.recording;
}

async function handleRecorderKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!recording || e.repeat) return;
  if (recording.busy) {
    // Esc while main.rs is still answering: the recording ends as soon as the answer arrives.
    if (e.key === "Escape") recording.cancelWhenDone = true;
    return;
  }
  if (e.key === "Escape") {
    cancelRecording();
    return;
  }

  const { kind, action, element } = recording;
  if (kind === "global") {
    const result = acceleratorFromKeyEvent(e);
    if (result.pending) {
      showRecordingPreview(result.mods);
      return;
    }
    element.textContent = SHORTCUT_TEXT.recording;
    if (result.error) {
      showShortcutMessage(result.error);
      return;
    }
    recording.busy = true;
    const outcome = await applyShortcut(result.accelerator);
    if (recording?.element !== element) return;
    recording.busy = false;
    if (outcome === "updated") {
      stopRecording();
    } else if (recording.cancelWhenDone) {
      // The refusal stays on screen; the old shortcut is registered again.
      stopRecording();
    } else {
      // Still recording: the old shortcut stays until a valid one is registered. main.rs may have registered the old
      // one again after a refusal, so it is suspended again.
      element.textContent = SHORTCUT_TEXT.recording;
      invoke("set_shortcut_recording", { active: true }).catch((err) => console.error(err));
    }
    return;
  }

  const result = bindingFromKeyEvent(e);
  if (result.pending) {
    showRecordingPreview(result.mods);
    return;
  }
  element.textContent = SHORTCUT_TEXT.recording;
  if (result.error) {
    showBindingMessage(action, result.error);
    return;
  }
  const problem = bindingProblem(action, result.binding, bindings, currentShortcut, layoutLabels);
  if (problem) {
    showBindingMessage(action, problem.reason, problem.action);
    return;
  }
  recording.busy = true;
  const saved = await saveBindings({ ...bindings, [action]: result.binding });
  if (recording?.element === element) stopRecording();
  showBindingMessage(action, saved ? "saved" : "save_failed");
}

for (const recorder of globalRecorders()) {
  recorder.title = SHORTCUT_TEXT.recorderTitle;
  recorder.onmousedown = (e) => e.preventDefault();
  recorder.onclick = (e) => {
    e.stopPropagation();
    startRecording("global", recorder);
  };
}

for (const button of [keysOpenBtn, keysBackBtn, keysResetBtn]) {
  button.onmousedown = (e) => e.preventDefault();
}
keysOpenBtn.onclick = (e) => {
  e.stopPropagation();
  showKeysView(true);
};
keysBackBtn.onclick = (e) => {
  e.stopPropagation();
  showKeysView(false);
};
keysResetBtn.onclick = async (e) => {
  e.stopPropagation();
  cancelRecording();
  await saveBindings({ ...DEFAULT_BINDINGS });
  IN_APP_ACTIONS.forEach(({ id }) => showBindingMessage(id, ""));
  keysResetBtn.textContent = SHORTCUT_TEXT.bindingsReset;
  keysResetBtn.classList.add("btn-success");
  setTimeout(() => {
    keysResetBtn.textContent = KEYS_RESET_LABEL;
    keysResetBtn.classList.remove("btn-success");
  }, 1500);
};
const KEYS_RESET_LABEL = keysResetBtn.textContent;

async function loadShortcuts() {
  try {
    currentShortcut = await invoke("get_current_shortcut");
  } catch (err) {
    console.error("Global shortcut unavailable:", err);
  }
  try {
    bindings = resolveBindings(await invoke("get_key_bindings"));
  } catch (err) {
    console.error("Key bindings unavailable:", err);
  }
  renderShortcutViews();
  if (!resultsContainer.classList.contains("hidden")) render();
  try {
    const status = await invoke("shortcut_status");
    if (status?.preferred && status.shortcut && shortcutMsgState === "") {
      showShortcutMessage("standIn", SHORTCUT_TEXT.standIn(
        formatAccelerator(status.preferred, layoutLabels.tokens),
        formatAccelerator(status.shortcut, layoutLabels.tokens)));
    }
  } catch (err) {
    console.error(err);
  }
}

buildActionRows();
buildPresetList();
renderShortcutViews();
showShortcutMessage("");
loadShortcuts();
refreshLayoutLabels();

input.addEventListener("click", () => {
  deselectChips();
});

document.addEventListener("click", (e) => {
  if (recording && !recording.element.contains(e.target)) {
    cancelRecording();
  }

  if (!e.target.closest("#search-wrapper")) {
    deselectChips();
  }
});

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
  lastWindowHeight = WINDOW_MIN_HEIGHT;
} else {
  invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
  lastWindowHeight = WINDOW_MAX_HEIGHT;
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
    lastWindowHeight = WINDOW_MIN_HEIGHT;
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
      resultsList.replaceChildren(INDEX_STATUS_ROWS.indexing());
      resultsContainer.classList.remove("hidden");
      await invoke("resize_window", { height: WINDOW_MAX_HEIGHT });
      lastWindowHeight = WINDOW_MAX_HEIGHT;
    } else {
      resultsContainer.classList.add("hidden");
      await invoke("reset_window");
      lastWindowHeight = WINDOW_MIN_HEIGHT;
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

// The first show happens while this page is still loading: main.rs keeps the window cloaked until the first frame.
afterPaint().then(() => invoke("reveal_window"));