#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use jwalk::WalkDir;
use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::RwLock;
use std::time::Instant;
use systemicons::get_icon;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, serde::Serialize)]
struct SearchResult {
    path: String,
    name: String,
    kind: String,
    score: u16,
    icon_data: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum ItemKind {
    App,
    Folder,
    File,
    Drive,
    Command,
}

impl ItemKind {
    fn as_str(&self) -> &'static str {
        match self {
            ItemKind::App => "app",
            ItemKind::Folder => "folder",
            ItemKind::File => "file",
            ItemKind::Drive => "drive",
            ItemKind::Command => "command",
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct FileIndexData {
    items: Vec<IndexedItem>,
    arena: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct IndexedItem {
    path_start: u32,
    path_len: u16,
    name_start: u32,
    name_len: u16,
    name_lower_start: u32,
    name_lower_len: u16,
    kind: ItemKind,
}

static CURRENT_SHORTCUT: Lazy<Mutex<String>> =
    Lazy::new(|| Mutex::new("Super+Shift+.".to_string()));
static FILE_INDEX: Lazy<RwLock<FileIndexData>> = Lazy::new(|| RwLock::new(FileIndexData::default()));
static SHOW_RECENTS: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(true));
static REFOCUS_ON_BLUR: AtomicBool = AtomicBool::new(false);
static IS_INDEXING: AtomicBool = AtomicBool::new(false);

const PRESET_SHORTCUTS: &[&str] = &[
    "Super+Shift+.",
    "Alt+Space",
    "Super+Space",
    "Ctrl+Space",
    "Ctrl+Shift+Space",
    "Super+S",
    "Alt+S",
    "Super+/"
];

fn get_config_path(app: &AppHandle) -> std::path::PathBuf {
    let mut path = app.path().app_config_dir().unwrap_or_default();
    std::fs::create_dir_all(&path).unwrap_or_default();
    path.push("settings.json");
    path
}

fn get_binfile_path(app: &AppHandle) -> std::path::PathBuf {
    let mut path = app.path().app_cache_dir().unwrap_or_default();
    std::fs::create_dir_all(&path).unwrap_or_default();
    path.push("index-v1.bin");
    path
}

fn load_shortcut(app: &AppHandle) -> String {
    let path = get_config_path(app);
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(shortcut) = v.get("shortcut").and_then(|s| s.as_str()) {
                return shortcut.to_string();
            }
        }
    }
    "Super+Shift+.".to_string()
}

fn save_shortcut(app: &AppHandle, shortcut: &str) {
    let path = get_config_path(app);
    let mut data = serde_json::json!({});
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            data = v;
        }
    }
    if let Some(obj) = data.as_object_mut() {
        obj.insert("shortcut".to_string(), serde_json::json!(shortcut));
    } else {
        data = serde_json::json!({ "shortcut": shortcut });
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default());
}

fn get_file_icon_base64(path: &str) -> Option<String> {
    match get_icon(path, 32) {
        Ok(icon_vec) => {
            if let Ok(img) = image::load_from_memory(&icon_vec) {
                let mut buf = Vec::new();
                if img
                    .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
                    .is_ok()
                {
                    use base64::{engine::general_purpose, Engine as _};
                    let b64 = general_purpose::STANDARD.encode(&buf);
                    return Some(format!("data:image/png;base64,{}", b64));
                }
            }

            const SIZE: usize = 32;
            let expected = SIZE * SIZE * 4;
            if icon_vec.len() == expected {
                if let Some(img_buf) = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
                    SIZE as u32,
                    SIZE as u32,
                    icon_vec,
                ) {
                    let img = image::DynamicImage::ImageRgba8(img_buf);
                    let mut buf = Vec::new();
                    if img
                        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
                        .is_ok()
                    {
                        use base64::{engine::general_purpose, Engine as _};
                        let b64 = general_purpose::STANDARD.encode(&buf);
                        return Some(format!("data:image/png;base64,{}", b64));
                    }
                }
            }

            None
        }
        Err(e) => {
            eprintln!("get_icon error for {}: {:?}", path, e);
            None
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let show_recents = *SHOW_RECENTS.lock().unwrap();

        if show_recents {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: 800.0,
                height: 400.0,
            }));
        } else {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: 800.0,
                height: 70.0,
            }));
        }

        let _ = window.center();
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: window.outer_position().unwrap().x,
            y: 100,
        }));
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("reset_state", ());
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[tauri::command]
fn get_current_shortcut() -> String {
    CURRENT_SHORTCUT.lock().unwrap().clone()
}

#[tauri::command]
fn set_recents_state(show: bool) {
    *SHOW_RECENTS.lock().unwrap() = show;
}

#[tauri::command]
fn update_shortcut(app: AppHandle, new_shortcut: String) -> bool {
    let mut current = CURRENT_SHORTCUT.lock().unwrap();
    let _ = app.global_shortcut().unregister(current.as_str());

    match app.global_shortcut().register(new_shortcut.as_str()) {
        Ok(_) => {
            println!("Shortcut updated to: {}", new_shortcut);
            *current = new_shortcut.clone();
            save_shortcut(&app, &new_shortcut);
            true
        }
        Err(e) => {
            eprintln!("Failed to register {}: {:?}", new_shortcut, e);
            let _ = app.global_shortcut().register(current.as_str());
            false
        }
    }
}

#[tauri::command]
fn check_shortcuts_availability(app: AppHandle, shortcuts: Vec<String>) -> Vec<bool> {
    let current = CURRENT_SHORTCUT.lock().unwrap().clone();
    let _ = app.global_shortcut().unregister(current.as_str());

    let mut results = Vec::new();
    for sc in shortcuts {
        if sc == current {
            results.push(true);
        } else {
            match app.global_shortcut().register(sc.as_str()) {
                Ok(_) => {
                    let _ = app.global_shortcut().unregister(sc.as_str());
                    results.push(true);
                }
                Err(_) => {
                    results.push(false);
                }
            }
        }
    }

    let _ = app.global_shortcut().register(current.as_str());
    results
}
// ---------------------------------------------------------------------------
// Search vocabulary
//
// The interface is Italian. Built-in entries are shown with their Italian (Windows 11) names
// and keep the upstream English names as search aliases. The folded display name and the
// folded aliases share the `name_lower` slice of an indexed item, separated by
// ALIAS_SEPARATOR, so the binary layout of the index cache does not change.
// ---------------------------------------------------------------------------

/// Separates the display name from the aliases inside a search key. It cannot be typed, and it
/// is stripped from queries, so a query never matches across two aliases.
const ALIAS_SEPARATOR: char = '\u{1F}';

/// A built-in entry: its target, its Italian display name and the other words that find it.
struct CatalogEntry {
    path: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
}

const fn entry(
    path: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
) -> CatalogEntry {
    CatalogEntry { path, name, aliases }
}

/// A RocketLauncher command. Every command is listed by the /rocket filter at `list_score`;
/// the `indexed` ones are also found by the general search (quit and close-window are only
/// offered through /rocket, as upstream did).
struct RocketCommand {
    entry: CatalogEntry,
    list_score: u16,
    indexed: bool,
}

const fn rocket_command(
    path: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
    list_score: u16,
    indexed: bool,
) -> RocketCommand {
    RocketCommand { entry: entry(path, name, aliases), list_score, indexed }
}

const ROCKET_COMMANDS: &[RocketCommand] = &[
    rocket_command("rocket:help", "Guida di RocketLauncher", &["RocketLauncher: Help", "help", "aiuto", "guida", "documentazione"], 201, true),
    rocket_command("rocket:settings", "Impostazioni di RocketLauncher", &["RocketLauncher Settings", "settings", "impostazioni", "opzioni", "preferenze"], 200, true),
    rocket_command("rocket:toggle_recents", "Mostra/nascondi recenti", &["RocketLauncher: Toggle Recents", "toggle recents", "recenti", "attiva recenti", "disattiva recenti"], 199, true),
    rocket_command("rocket:clear_recents", "Svuota recenti", &["RocketLauncher: Clear Recents", "clear recents", "cancella recenti"], 198, true),
    rocket_command("rocket:refresh", "Aggiorna l'indice dei file", &["RocketLauncher: Refresh Index", "refresh index", "aggiorna indice", "reindicizza", "indicizza"], 195, true),
    rocket_command("rocket:show_desktop", "Mostra desktop", &["Show Desktop", "desktop"], 194, true),
    rocket_command("rocket:active_tabs", "Finestre aperte", &["Active Tabs", "tabs", "finestre", "schede"], 193, true),
    rocket_command("rocket:quit", "Esci da RocketLauncher", &["Quit RocketLauncher", "quit", "exit", "esci", "chiudi rocketlauncher"], 192, false),
    rocket_command("rocket:close_window", "Chiudi scheda o finestra attiva", &["Close Active Tab/Window", "close tab", "close window", "chiudi scheda", "chiudi finestra"], 191, false),
    rocket_command("rocket:request_shutdown", "Arresta il sistema", &["Shutdown", "shut down", "power off", "spegni", "spegni il pc", "spegnimento"], 190, true),
    rocket_command("rocket:media_play", "Multimediale: Riproduci/Pausa", &["Media: Play/Pause", "media", "play", "pause", "riproduci", "pausa"], 189, true),
    rocket_command("rocket:media_next", "Multimediale: Brano successivo", &["Media: Next Track", "next track", "brano successivo", "traccia successiva"], 188, true),
    rocket_command("rocket:media_prev", "Multimediale: Brano precedente", &["Media: Previous Track", "previous track", "brano precedente", "traccia precedente"], 187, true),
    rocket_command("rocket:request_restart", "Riavvia il sistema", &["Restart", "reboot", "riavvia", "riavvia il pc", "riavvio"], 180, true),
];

/// Windows settings listed by /rocket after the RocketLauncher commands.
const ROCKET_LIST_SYSTEM_ENTRIES: &[(CatalogEntry, u16)] = &[
    (entry("ms-settings:startupapps", "App di avvio", &["Startup Apps", "avvio automatico", "esecuzione automatica"]), 175),
    (entry("ms-settings:appsfeatures", "App installate (disinstalla)", &["Apps & Features (Uninstall)", "apps & features", "uninstall", "disinstalla"]), 174),
    (entry("ms-settings:sound", "Impostazioni audio (volume)", &["Sound Settings (Volume)", "sound", "audio", "volume"]), 170),
    (entry("ms-settings:display", "Impostazioni schermo (luminosità)", &["Display Settings (Brightness)", "display", "brightness", "schermo", "luminosità"]), 160),
    (entry("ms-settings:windowsupdate", "Windows Update", &["aggiornamenti", "aggiornamenti di windows"]), 150),
];

/// Windows settings pages and system tools found by the general search. Names follow Windows 11
/// in Italian; the upstream English name is always the first alias.
const SYSTEM_ENTRIES: &[CatalogEntry] = &[
    entry("ms-settings:startupapps", "App di avvio", &["Startup Apps", "avvio automatico", "esecuzione automatica"]),
    entry("ms-settings:appsfeatures", "Disinstalla un programma", &["Uninstall Program", "uninstall", "disinstalla", "rimuovi app"]),
    entry("ms-settings:appsfeatures", "App e funzionalità", &["Apps & Features", "apps and features"]),
    entry("ms-settings:installed-apps", "App installate", &["Installed Apps", "programmi installati"]),
    entry("ms-settings:windowsupdate", "Windows Update", &["aggiornamenti", "aggiornamenti di windows"]),
    entry("ms-settings:display", "Impostazioni schermo", &["Display Settings", "display", "schermo", "monitor", "risoluzione", "luminosità"]),
    entry("ms-settings:sound", "Impostazioni audio", &["Sound Settings", "sound", "audio", "volume"]),
    entry("ms-settings:bluetooth", "Bluetooth e dispositivi", &["Bluetooth & other devices", "bluetooth", "dispositivi"]),
    entry("ms-settings:network-wifi", "Impostazioni Wi-Fi", &["Wi-Fi Settings", "wifi", "rete wireless"]),
    entry("ms-settings:personalization", "Personalizzazione", &["Personalization", "sfondo", "tema"]),
    entry("ms-settings:taskbar", "Impostazioni della barra delle applicazioni", &["Taskbar Settings", "taskbar", "barra delle applicazioni"]),
    entry("ms-settings:dateandtime", "Data e ora", &["Date & Time Settings", "date and time", "orologio", "fuso orario"]),
    entry("ms-settings:powersleep", "Alimentazione e batteria", &["Power & Sleep Settings", "power", "sleep", "alimentazione", "sospensione", "batteria", "risparmio energia"]),
    entry("ms-settings:storagesense", "Impostazioni di archiviazione", &["Storage Settings", "storage", "archiviazione", "spazio su disco", "sensore memoria"]),
    entry("ms-settings:privacy-backgroundapps", "App in background", &["Background Apps"]),
    entry("ms-settings:notifications", "Notifiche", &["Notifications & actions", "notifications"]),
    entry("ms-settings:defaultapps", "App predefinite", &["Default Apps", "programmi predefiniti"]),
    entry("cmd:control", "Pannello di controllo", &["Control Panel"]),
    entry("cmd:appwiz.cpl", "Programmi e funzionalità", &["Uninstall Program (Classic)", "programs and features", "disinstalla (classico)"]),
    entry("cmd:taskmgr", "Gestione attività", &["Task Manager", "taskmgr", "processi"]),
    entry("cmd:msinfo32", "Informazioni di sistema", &["System Information", "msinfo"]),
    entry("cmd:cmd", "Prompt dei comandi", &["Command Prompt", "cmd", "terminale"]),
    entry("cmd:powershell", "PowerShell", &["terminale"]),
    entry("cmd:regedit", "Editor del Registro di sistema", &["Registry Editor", "regedit", "registro"]),
    entry("cmd:rundll32.exe sysdm.cpl,EditEnvironmentVariables", "Variabili d'ambiente", &["Environment Variables", "path", "variabili di sistema"]),
    entry("cmd:sysdm.cpl", "Proprietà del sistema", &["System Properties", "nome computer"]),
    entry("cmd:ncpa.cpl", "Connessioni di rete", &["Network Connections", "schede di rete"]),
    entry("cmd:diskmgmt.msc", "Gestione disco", &["Disk Management", "partizioni"]),
    entry("cmd:devmgmt.msc", "Gestione dispositivi", &["Device Manager", "driver"]),
    entry("cmd:services.msc", "Servizi", &["Services"]),
    entry("cmd:gpedit.msc", "Editor Criteri di gruppo locali", &["Group Policy Editor", "gpedit", "criteri di gruppo"]),
    entry("cmd:resmon", "Monitoraggio risorse", &["Resource Monitor"]),
    entry("cmd:eventvwr.msc", "Visualizzatore eventi", &["Event Viewer", "registro eventi"]),
];

/// Nox Dimmer commands (a separate app by the upstream author, driven over its local TCP port).
const NOX_COMMANDS: &[(CatalogEntry, u16)] = &[
    (entry("nox:open", "Nox: Apri", &["Nox: Open", "open", "apri", "avvia"]), 210),
    (entry("nox:quit", "Nox: Esci", &["Nox: Quit", "quit", "esci", "chiudi"]), 200),
    (entry("nox:hyper_toggle", "Nox: Attiva/disattiva modalità Hyper", &["Nox: Toggle Hyper Mode", "hyper"]), 199),
    (entry("nox:brightness_up", "Nox: Aumenta oscuramento (+10%)", &["Nox: Increase Dimness (+10%)", "increase", "aumenta", "più scuro"]), 198),
    (entry("nox:brightness_down", "Nox: Riduci oscuramento (-10%)", &["Nox: Decrease Dimness (-10%)", "decrease", "riduci", "più chiaro"]), 197),
    (entry("nox:check_updates", "Nox: Controlla aggiornamenti", &["Nox: Check for Updates", "updates", "aggiornamenti"]), 195),
    (entry("nox:help", "Nox: Guida (GitHub)", &["Nox: Help (GitHub)", "help", "guida", "aiuto"]), 194),
];

const NOX_INSTALL: CatalogEntry = entry("nox:install", "Nox: Installa Nox Dimmer", &["Nox: Install Nox Dimmer"]);

/// Preset websites listed by /web (and by the private-mode chip alone). Italian editions are
/// used where the site has one.
const WEB_PRESETS: &[(CatalogEntry, u16)] = &[
    (entry("https://www.google.it", "Google", &[]), 200),
    (entry("https://www.youtube.com", "YouTube", &[]), 199),
    (entry("https://claude.ai", "Claude", &[]), 198),
    (entry("https://gemini.google.com", "Gemini", &[]), 197),
    (entry("https://chatgpt.com", "ChatGPT", &[]), 196),
    (entry("https://github.com", "GitHub", &[]), 195),
    (entry("https://www.reddit.com", "Reddit", &[]), 194),
    (entry("https://twitter.com", "X (Twitter)", &[]), 193),
    (entry("https://www.instagram.com", "Instagram", &[]), 192),
    (entry("https://www.linkedin.com", "LinkedIn", &[]), 191),
    (entry("https://stackoverflow.com", "Stack Overflow", &[]), 190),
    (entry("https://mail.google.com", "Gmail", &[]), 189),
    (entry("https://drive.google.com", "Google Drive", &[]), 188),
    (entry("https://www.notion.so", "Notion", &[]), 187),
    (entry("https://discord.com", "Discord", &[]), 186),
    (entry("https://open.spotify.com", "Spotify", &[]), 185),
    (entry("https://www.amazon.it", "Amazon", &[]), 184),
    (entry("https://it.wikipedia.org", "Wikipedia", &[]), 183),
    (entry("https://github.com/leonardostagliano/RocketLauncher#readme", "RocketLauncher su GitHub", &["RocketLauncher Docs", "docs", "documentazione", "guida"]), 182),
    (entry("https://yashvardhang.dev", "YashvardhanG", &[]), 181),
];

const THIS_PC: CatalogEntry = entry(
    "cmd:explorer shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
    "Questo PC",
    &["This PC", "pc", "computer", "my computer", "risorse del computer"],
);

const RECYCLE_BIN: CatalogEntry = entry("cmd:explorer shell:RecycleBinFolder", "Cestino", &["Recycle Bin", "trash"]);

/// A user folder under %USERPROFILE%: its physical (English) directory name and the name
/// Explorer shows for it in Italian.
struct KnownFolder {
    dir: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
}

const KNOWN_FOLDERS: &[KnownFolder] = &[
    KnownFolder { dir: "Downloads", name: "Download", aliases: &["Downloads", "scaricati"] },
    KnownFolder { dir: "Pictures", name: "Immagini", aliases: &["Pictures", "foto"] },
    KnownFolder { dir: "Documents", name: "Documenti", aliases: &["Documents"] },
    KnownFolder { dir: "Music", name: "Musica", aliases: &["Music"] },
    KnownFolder { dir: "Videos", name: "Video", aliases: &["Videos"] },
    KnownFolder { dir: "Desktop", name: "Desktop", aliases: &[] },
];

/// Upstream shows the Pictures folder as "Gallery" too; Windows 11 calls that view "Galleria".
const GALLERY: KnownFolder = KnownFolder { dir: "Pictures", name: "Galleria", aliases: &["Gallery"] };

/// Lowercases `text` and removes the accents from Latin letters, so "attivita" finds
/// "Gestione attività" and "perche" finds "perché". Typographic apostrophes become straight.
fn fold_for_search(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    let mut folded = String::with_capacity(text.len());
    for ch in text.chars() {
        for lower in ch.to_lowercase() {
            folded.push(fold_char(lower));
        }
    }
    folded
}

fn fold_char(ch: char) -> char {
    match ch {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        '\u{2018}' | '\u{2019}' => '\'',
        other => other,
    }
}

/// Builds the search key stored in the `name_lower` slice: the folded display name, then each
/// folded alias that is not already there, separated by ALIAS_SEPARATOR.
fn search_key(name: &str, aliases: &[&str]) -> String {
    let mut key = fold_for_search(name);
    for alias in aliases {
        let folded = fold_for_search(alias);
        if folded.is_empty() || key.split(ALIAS_SEPARATOR).any(|segment| segment == folded) {
            continue;
        }
        key.push(ALIAS_SEPARATOR);
        key.push_str(&folded);
    }
    key
}

/// How well a folded query matches a search key, looking at each alias on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum NameMatch {
    None,
    Contains,
    Prefix,
    Exact,
}

fn name_match(key: &str, query: &str) -> NameMatch {
    let mut best = NameMatch::None;
    for segment in key.split(ALIAS_SEPARATOR) {
        let quality = if segment == query {
            NameMatch::Exact
        } else if segment.starts_with(query) {
            NameMatch::Prefix
        } else if segment.contains(query) {
            NameMatch::Contains
        } else {
            NameMatch::None
        };
        if quality > best {
            best = quality;
            if best == NameMatch::Exact {
                break;
            }
        }
    }
    best
}

fn catalog_entry_matches(entry_name: &str, aliases: &[&str], query: &str) -> bool {
    query.is_empty() || name_match(&search_key(entry_name, aliases), query) != NameMatch::None
}

/// Rows added on top of the general results (This PC, Gallery, user folders) need a real hint
/// from the user: at least two characters that start one of their names or one of the words in
/// them. A plain substring test would add them for almost every single letter typed.
fn pinned_entry_matches(entry_name: &str, aliases: &[&str], query: &str) -> bool {
    if query.chars().count() < 2 {
        return false;
    }
    search_key(entry_name, aliases)
        .split(ALIAS_SEPARATOR)
        .any(|alias| alias.starts_with(query) || alias.split(' ').any(|word| word.starts_with(query)))
}

/// What a `@word` or `/word` token in the query asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FilterToken {
    /// Open windows and browser tabs.
    Tabs,
    /// RocketLauncher commands and the main Windows settings.
    Rocket,
    Nox,
    /// Preset websites and typed URLs.
    Web,
    /// Private mode: web searches and links open in an incognito window.
    Private,
    ThisPc,
    Apps,
    Folders,
    Files,
    Drives,
    /// Paths on one drive (`/c` or `/c:`).
    DriveLetter(char),
    /// Built-in commands of the general index (Windows settings and tools).
    Commands,
    /// Handled by the interface only (run a command, web search engines).
    FrontendOnly,
    /// Anything else is a file extension (`/pdf`).
    Extension(String),
}

/// Maps a filter word (without its `@` or `/`) to what it filters. English words from upstream
/// and their Italian equivalents are both accepted; the word is accent-folded first, so `/unità`
/// and `/unita` are the same. Keep FILTER_WORDS in src/main.js in sync with this list.
fn classify_filter(word: &str) -> FilterToken {
    let word = fold_for_search(word);
    match word.as_str() {
        "tabs" | "active" | "window" | "windows" | "finestre" | "finestra" | "schede" | "scheda" => FilterToken::Tabs,
        "rocket" | "rocketlauncher" | "settings" | "comandi" | "impostazioni" => FilterToken::Rocket,
        "nox" | "nox-dimmer" | "noxdimmer" => FilterToken::Nox,
        "web" | "website" | "websites" | "site" | "sites" | "url" | "sito" | "siti" => FilterToken::Web,
        "p" | "privato" | "privata" | "incognito" => FilterToken::Private,
        "pc" | "thispc" | "computer" | "questopc" => FilterToken::ThisPc,
        "app" | "apps" | "application" | "applications" | "exe" | "lnk" | "applicazione" | "applicazioni"
        | "programma" | "programmi" => FilterToken::Apps,
        "folder" | "folders" | "directory" | "directories" | "dir" | "dirs" | "cartella" | "cartelle" => {
            FilterToken::Folders
        }
        "file" | "files" => FilterToken::Files,
        "drive" | "drives" | "disk" | "disks" | "unita" | "disco" | "dischi" => FilterToken::Drives,
        "setting" | "config" | "setup" | "impostazione" | "configurazione" => FilterToken::Commands,
        "cmd" | "esegui" | "search" | "cerca" | "google" | "bing" | "duck" | "duckduckgo" => FilterToken::FrontendOnly,
        _ => {
            let mut chars = word.chars();
            match (chars.next(), chars.next(), chars.next()) {
                (Some(letter), None, _) if letter.is_ascii_alphabetic() => FilterToken::DriveLetter(letter),
                (Some(letter), Some(':'), None) if letter.is_ascii_alphabetic() => FilterToken::DriveLetter(letter),
                _ => FilterToken::Extension(word),
            }
        }
    }
}

fn path_has_extension(path: &str, extension: &str) -> bool {
    let path = path.as_bytes();
    let extension = extension.as_bytes();
    path.len() > extension.len()
        && path[path.len() - extension.len() - 1] == b'.'
        && path[path.len() - extension.len()..].eq_ignore_ascii_case(extension)
}

/// Whether an item of `kind` at `path` is kept by every category, drive and extension filter.
fn passes_filters(filters: &[FilterToken], kind: ItemKind, path: &str) -> bool {
    filters.iter().all(|filter| match filter {
        FilterToken::Apps => {
            kind == ItemKind::App || path_has_extension(path, "exe") || path_has_extension(path, "lnk")
        }
        FilterToken::Folders => kind == ItemKind::Folder,
        FilterToken::Files => kind == ItemKind::File,
        FilterToken::Drives => kind == ItemKind::Drive,
        FilterToken::Commands => kind == ItemKind::Command,
        FilterToken::DriveLetter(letter) => {
            let bytes = path.as_bytes();
            bytes.len() >= 2 && bytes[0].eq_ignore_ascii_case(&(*letter as u8)) && bytes[1] == b':'
        }
        FilterToken::Extension(extension) => path_has_extension(path, extension),
        FilterToken::Tabs
        | FilterToken::Rocket
        | FilterToken::Nox
        | FilterToken::Web
        | FilterToken::Private
        | FilterToken::ThisPc
        | FilterToken::FrontendOnly => true,
    })
}

/// ASCII case-insensitive substring test on raw path bytes (the upstream path match).
fn path_contains(path: &str, needle: &str) -> bool {
    !needle.is_empty()
        && path
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Upstream also accepted a filter word glued to more text at the very start of the query
/// (`/rocketlauncher`, `/nox-dimmer`); that shortcut is kept for the original English words.
fn query_starts_with_filter(query_lower: &str, words: &[&str]) -> bool {
    words.iter().any(|word| {
        query_lower
            .strip_prefix('@')
            .or_else(|| query_lower.strip_prefix('/'))
            .is_some_and(|rest| rest.starts_with(word))
    })
}

fn catalog_result(entry: &CatalogEntry, kind: &str, score: u16) -> SearchResult {
    SearchResult {
        path: entry.path.to_string(),
        name: entry.name.to_string(),
        kind: kind.to_string(),
        score,
        icon_data: None,
    }
}

fn rocket_list(search_text: &str) -> Vec<SearchResult> {
    let commands = ROCKET_COMMANDS.iter().map(|command| (&command.entry, command.list_score));
    let system = ROCKET_LIST_SYSTEM_ENTRIES.iter().map(|(entry, score)| (entry, *score));
    commands
        .chain(system)
        .filter(|(entry, _)| catalog_entry_matches(entry.name, entry.aliases, search_text))
        .map(|(entry, score)| catalog_result(entry, "command", score))
        .collect()
}

fn nox_list(search_text: &str) -> Vec<SearchResult> {
    if !is_nox_installed() {
        return vec![catalog_result(&NOX_INSTALL, "command", 200)];
    }
    NOX_COMMANDS
        .iter()
        .filter(|(entry, _)| catalog_entry_matches(entry.name, entry.aliases, search_text))
        .map(|(entry, score)| catalog_result(entry, "command", *score))
        .collect()
}

/// `typed` keeps the case of the query, because it may become a URL.
fn web_list(search_text: &str, typed: &str) -> Vec<SearchResult> {
    let mut results: Vec<SearchResult> = WEB_PRESETS
        .iter()
        .filter(|(entry, _)| catalog_entry_matches(entry.name, entry.aliases, search_text))
        .map(|(entry, score)| catalog_result(entry, "website", *score))
        .collect();

    let typed_lower = typed.to_lowercase();
    if !typed.is_empty() && (typed.contains('.') || typed_lower.starts_with("http")) {
        let url = if typed_lower.starts_with("http://") || typed_lower.starts_with("https://") {
            typed.to_string()
        } else {
            format!("https://{}", typed)
        };
        results.insert(
            0,
            SearchResult {
                path: url,
                name: format!("Apri {}", typed),
                kind: "website".to_string(),
                score: 300,
                icon_data: None,
            },
        );
    }

    results
}

fn this_pc_result(score: u16) -> SearchResult {
    SearchResult {
        icon_data: get_file_icon_base64("C:\\Windows\\explorer.exe"),
        ..catalog_result(&THIS_PC, "app", score)
    }
}

fn this_pc_list(search_text: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    if catalog_entry_matches(THIS_PC.name, THIS_PC.aliases, search_text) {
        results.push(this_pc_result(2000));
    }
    if catalog_entry_matches(RECYCLE_BIN.name, RECYCLE_BIN.aliases, search_text) {
        results.push(catalog_result(&RECYCLE_BIN, "app", 1950));
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        for folder in KNOWN_FOLDERS {
            let path = format!("{}\\{}", user_profile, folder.dir);
            if catalog_entry_matches(folder.name, folder.aliases, search_text) && Path::new(&path).exists() {
                results.push(SearchResult {
                    path,
                    name: folder.name.to_string(),
                    kind: "folder".to_string(),
                    score: 1900,
                    icon_data: None,
                });
            }
        }
    }
    results
}

/// The Italian name of a user folder (`%USERPROFILE%\Pictures` is "Immagini" in Explorer).
fn known_folder_name(path: &str, user_profile: &str) -> Option<&'static str> {
    let relative = path.get(user_profile.len()..)?;
    if !path.as_bytes()[..user_profile.len()].eq_ignore_ascii_case(user_profile.as_bytes()) {
        return None;
    }
    let dir = relative.strip_prefix('\\')?;
    KNOWN_FOLDERS
        .iter()
        .find(|folder| folder.dir.eq_ignore_ascii_case(dir))
        .map(|folder| folder.name)
}

#[tauri::command]
async fn search_files(query: String) -> Vec<SearchResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let index_data = FILE_INDEX.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        search_index(&index_data, &query)
    })
    .await
    .unwrap_or_default()
}

fn search_index(index_data: &FileIndexData, query: &str) -> Vec<SearchResult> {
    let index = &index_data.items;
    let arena = &index_data.arena;
    let query_trim = query.trim();

    if query_trim.is_empty() {
        return vec![];
    }
    let query_lower = query_trim.to_lowercase();

    let mut filters: Vec<FilterToken> = Vec::new();
    let mut search_terms = Vec::new();

    for part in query_trim.split_whitespace() {
        if (part.starts_with('@') || part.starts_with('/')) && part.len() > 1 {
            filters.push(classify_filter(&part[1..]));
        } else {
            search_terms.push(part);
        }
    }

    // `typed` keeps the case (URLs), `search_raw` is matched byte by byte against paths as
    // upstream did, and `search_text` (accent-folded) against display names and aliases, which
    // are folded when they are indexed.
    let typed: String = search_terms.join(" ").replace(ALIAS_SEPARATOR, "");
    let search_raw = typed.to_lowercase();
    let search_text = fold_for_search(&search_raw);
    let has_filter = |wanted: FilterToken| filters.contains(&wanted);

    if has_filter(FilterToken::Tabs) || query_starts_with_filter(&query_lower, &["tabs", "active"]) {
        let mut active = get_active_windows();
        if !search_text.is_empty() {
            active.retain(|res| fold_for_search(&res.name).contains(&search_text));
        }
        return active;
    }

    if has_filter(FilterToken::Rocket) || query_starts_with_filter(&query_lower, &["settings", "rocket"]) {
        return rocket_list(&search_text);
    }

    if has_filter(FilterToken::Nox) || query_starts_with_filter(&query_lower, &["nox"]) {
        return nox_list(&search_text);
    }

    // The private-mode chip alone (possibly with a web search engine) lists the websites.
    let has_web_filter = has_filter(FilterToken::Web);
    let has_private_only = has_filter(FilterToken::Private)
        && filters
            .iter()
            .all(|filter| matches!(filter, FilterToken::Private | FilterToken::FrontendOnly));

    if has_web_filter || has_private_only || query_starts_with_filter(&query_lower, &["web"]) {
        return web_list(&search_text, &typed);
    }

    // Running a command and web searches are rows built by the interface: the index has
    // nothing to add to them.
    if has_filter(FilterToken::FrontendOnly) {
        return vec![];
    }

    if has_filter(FilterToken::ThisPc) || query_starts_with_filter(&query_lower, &["pc"]) {
        return this_pc_list(&search_text);
    }

    let user_profile = std::env::var("USERPROFILE").ok();

    let mut matching_indices: Vec<(usize, u16)> = index
        .iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            let path = &arena[item.path_start as usize..(item.path_start + item.path_len as u32) as usize];
            let name_lower = &arena[item.name_lower_start as usize..(item.name_lower_start + item.name_lower_len as u32) as usize];

            if !passes_filters(&filters, item.kind, path) {
                return None;
            }

            let name_quality = if search_text.is_empty() {
                // Every item "starts with" an empty query (upstream gave all of them +20).
                NameMatch::Prefix
            } else if name_lower.contains(search_text.as_str()) {
                name_match(name_lower, &search_text)
            } else {
                let path_hit = path_contains(path, &search_raw)
                    || (search_text != search_raw && path_contains(path, &search_text));
                if !path_hit {
                    return None;
                }
                NameMatch::None
            };

            let mut score: u16 = 1;

            if item.kind == ItemKind::Command {
                score += 500;
            } else if item.kind == ItemKind::App {
                score += 250;
            }

            if path.starts_with("shell:") {
                score = score.saturating_sub(10);
            }

            if item.kind == ItemKind::Drive {
                score += 80;
            }

            score += match name_quality {
                NameMatch::Exact => 50,
                NameMatch::Prefix => 20,
                NameMatch::Contains => 10,
                NameMatch::None => 0,
            };

            if path.len() < 50 {
                score += 5;
            }

            if item.kind == ItemKind::Folder {
                if let Some(up) = user_profile.as_deref() {
                    if known_folder_name(path, up).is_some() {
                        score += 1500;
                    }
                }
            }

            Some((idx, score))
        })
        .collect();

    matching_indices.sort_by(|a, b| b.1.cmp(&a.1));

    let mut unique_results = Vec::new();
    // Folded display names already shown, and user folders already added on top (by path).
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut pinned_paths: HashSet<String> = HashSet::new();

    if !search_text.is_empty() {
        if pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, &search_text)
            && passes_filters(&filters, ItemKind::App, THIS_PC.path)
        {
            unique_results.push(this_pc_result(2000));
            seen_names.insert(fold_for_search(THIS_PC.name));
        }

        if let Some(up) = user_profile.as_deref() {
            let pinned_folders = std::iter::once((&GALLERY, 2000u16))
                .chain(KNOWN_FOLDERS.iter().map(|folder| (folder, 1900u16)));
            for (folder, score) in pinned_folders {
                let path = format!("{}\\{}", up, folder.dir);
                if pinned_entry_matches(folder.name, folder.aliases, &search_text)
                    && passes_filters(&filters, ItemKind::Folder, &path)
                    && Path::new(&path).exists()
                {
                    seen_names.insert(fold_for_search(folder.name));
                    pinned_paths.insert(path.to_ascii_lowercase());
                    unique_results.push(SearchResult {
                        path,
                        name: folder.name.to_string(),
                        kind: "folder".to_string(),
                        score,
                        icon_data: None,
                    });
                }
            }
        }
    }

    // A built-in command and a Start-menu app with the same Italian name (Gestione attività,
    // Pannello di controllo, Servizi, …) are the same tool: the Start-menu entry is kept, since
    // it is what Windows itself launches and it carries the real icon.
    let app_names: HashSet<String> = matching_indices
        .iter()
        .filter(|(idx, _)| index[*idx].kind == ItemKind::App)
        .map(|(idx, _)| {
            let item = &index[*idx];
            fold_for_search(&arena[item.name_start as usize..(item.name_start + item.name_len as u32) as usize])
        })
        .collect();

    for (idx, score) in matching_indices {
        let item = &index[idx];
        let path = &arena[item.path_start as usize..(item.path_start + item.path_len as u32) as usize];
        let mut name = &arena[item.name_start as usize..(item.name_start + item.name_len as u32) as usize];
        let kind_str = item.kind.as_str();

        match item.kind {
            ItemKind::App => {
                if !seen_names.insert(fold_for_search(name)) {
                    continue;
                }

                let bytes = path.as_bytes();
                let is_exec = bytes.len() >= 4 && (bytes[bytes.len()-4..].eq_ignore_ascii_case(b".exe") || bytes[bytes.len()-4..].eq_ignore_ascii_case(b".lnk"));

                let icon_data = if is_exec {
                    get_file_icon_base64(path)
                } else {
                    None
                };

                unique_results.push(SearchResult {
                    path: path.to_string(),
                    name: name.to_string(),
                    kind: kind_str.to_string(),
                    score,
                    icon_data,
                });
            }
            ItemKind::Command => {
                let folded = fold_for_search(name);
                if app_names.contains(&folded) || !seen_names.insert(folded) {
                    continue;
                }
                unique_results.push(SearchResult {
                    path: path.to_string(),
                    name: name.to_string(),
                    kind: kind_str.to_string(),
                    score,
                    icon_data: None,
                });
            }
            _ => {
                if item.kind == ItemKind::Folder && score >= 1500 {
                    if pinned_paths.contains(&path.to_ascii_lowercase()) {
                        continue;
                    }
                    // User folders are indexed with their physical English name.
                    if let Some(italian) = user_profile.as_deref().and_then(|up| known_folder_name(path, up)) {
                        name = italian;
                    }
                    if !seen_names.insert(fold_for_search(name)) {
                        continue;
                    }
                }

                unique_results.push(SearchResult {
                    path: path.to_string(),
                    name: name.to_string(),
                    kind: kind_str.to_string(),
                    score,
                    icon_data: None,
                });
            }
        }

        if unique_results.len() >= 50 {
            break;
        }
    }

    unique_results
}

#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) {
    let mut success = false;

    if path.starts_with("http://") || path.starts_with("https://") {
        #[cfg(target_os = "windows")]
        {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/C", "start", "", &path])
                .creation_flags(CREATE_NO_WINDOW);
            if command.spawn().is_ok() {
                success = true;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if tauri_plugin_opener::open_path(&path, None::<&str>).is_ok() {
                success = true;
            }
        }
    } else if path.starts_with("ms-settings:") || path.starts_with("shell:") {
        #[cfg(target_os = "windows")]
        {
            if std::process::Command::new("explorer.exe")
                .args([&path])
                .spawn()
                .is_ok()
            {
                success = true;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if tauri_plugin_opener::open_path(&path, None::<&str>).is_ok() {
                success = true;
            }
        }
    } else if path.starts_with("cmd:") {
        let cmd = &path[4..];
        #[cfg(target_os = "windows")]
        {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/C", cmd])
                .creation_flags(CREATE_NO_WINDOW);

            if let Err(e) = command.spawn() {
                eprintln!("Failed to execute command '{}': {}", cmd, e);
            } else {
                success = true;
            }
        }
    } else {
        if let Err(e) = tauri_plugin_opener::open_path(&path, None::<&str>) {
            eprintln!("Failed to open item: {}", e);
        } else {
            success = true;
        }
    }

    if success {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
}

#[tauri::command]
fn show_in_explorer(app: tauri::AppHandle, path: String) {
    let p = std::path::Path::new(&path);

    #[cfg(target_os = "windows")]
    {
        if p.exists() && !p.is_dir() {
            let _ = std::process::Command::new("explorer.exe")
                .args(["/select,", &path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        } else {
            let target = if p.exists() {
                path.clone()
            } else if let Some(parent) = p.parent() {
                parent.to_string_lossy().to_string()
            } else {
                path.clone()
            };
            let _ = std::process::Command::new("explorer.exe")
                .arg(&target)
                .spawn();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(parent) = p.parent() {
            let _ = tauri_plugin_opener::open_path(parent.to_string_lossy().as_ref(), None::<&str>);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn open_url_private(app: tauri::AppHandle, url: String) {
    let mut success = false;

    #[cfg(target_os = "windows")]
    {
        let local_app = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files = std::env::var("PROGRAMFILES").unwrap_or_else(|_| "C:\\Program Files".to_string());

        let mut browsers: Vec<(String, &str)> = vec![
            (format!("{}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", program_files), "--incognito"),
            (format!("{}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", local_app), "--incognito"),
            (format!("{}\\Google\\Chrome\\Application\\chrome.exe", program_files), "--incognito"),
            (format!("{}\\Google\\Chrome\\Application\\chrome.exe", local_app), "--incognito"),
            ("msedge.exe".to_string(), "--inprivate"),
            (format!("{}\\Mozilla Firefox\\firefox.exe", program_files), "-private-window"),
        ];

        if let Ok(output) = std::process::Command::new("reg")
            .args(["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let reg_out = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if reg_out.contains("brave") {
            } else if reg_out.contains("chrome") {
                browsers.retain(|b| !b.0.to_lowercase().contains("chrome"));
                browsers.insert(0, (format!("{}\\Google\\Chrome\\Application\\chrome.exe", local_app), "--incognito"));
                browsers.insert(0, (format!("{}\\Google\\Chrome\\Application\\chrome.exe", program_files), "--incognito"));
            } else if reg_out.contains("firefox") {
                browsers.insert(0, (format!("{}\\Mozilla Firefox\\firefox.exe", program_files), "-private-window"));
            } else if reg_out.contains("edge") {
                browsers.insert(0, ("msedge.exe".to_string(), "--inprivate"));
            }
        }

        for (browser, flag) in &browsers {
            if std::process::Command::new(browser)
                .args([flag.to_owned(), url.as_str()])
                .spawn()
                .is_ok()
            {
                success = true;
                break;
            }
        }

        if !success {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/C", "start", "", &url])
                .creation_flags(CREATE_NO_WINDOW);
            if command.spawn().is_ok() {
                success = true;
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if tauri_plugin_opener::open_path(&url, None::<&str>).is_ok() {
            success = true;
        }
    }

    if success {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
}

#[tauri::command]
fn reset_window(window: tauri::Window) {
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: 800.0,
        height: 70.0,
    }));

    let _ = window.center();
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: window.outer_position().unwrap().x,
        y: 100,
    }));
}

#[tauri::command]
fn resize_window(window: tauri::Window, height: f64) {
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: 800.0,
        height,
    }));
}

#[tauri::command]
fn get_available_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for letter in b'C'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if Path::new(&drive).exists() {
            drives.push(drive);
        }
    }
    drives
}

#[tauri::command]
fn execute_media_key(action: String) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            keybd_event, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VK_MEDIA_NEXT_TRACK,
            VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK,
        };

        let vk = match action.as_str() {
            "next" => VK_MEDIA_NEXT_TRACK,
            "prev" => VK_MEDIA_PREV_TRACK,
            "play" => VK_MEDIA_PLAY_PAUSE,
            _ => return,
        };

        unsafe {
            keybd_event(vk.0 as u8, 0, KEYEVENTF_EXTENDEDKEY, 0);
            keybd_event(vk.0 as u8, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
        }
    }
}

#[tauri::command]
fn show_desktop(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            keybd_event, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        };
        unsafe {
            keybd_event(0x5B, 0, KEYEVENTF_EXTENDEDKEY, 0); 
            keybd_event(0x44, 0, KEYEVENTF_EXTENDEDKEY, 0);
            keybd_event(0x44, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
            keybd_event(0x5B, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
    app.exit(0);
}

#[tauri::command]
fn close_active_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    std::thread::sleep(std::time::Duration::from_millis(50));

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            keybd_event, KEYEVENTF_KEYUP, VK_CONTROL
        };
        unsafe {
            keybd_event(VK_CONTROL.0 as u8, 0, Default::default(), 0); 
            keybd_event(0x57, 0, Default::default(), 0); 
            keybd_event(0x57, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_CONTROL.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
    }
}

#[tauri::command]
fn get_active_windows() -> Vec<SearchResult> {
    let mut windows_list: Vec<SearchResult> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
            IsWindowVisible,
        };

        unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            if IsWindowVisible(hwnd).as_bool() {
                // The launcher's own windows are excluded by process id, so the filter
                // does not depend on the window title (which is not kept in sync with
                // document.title and changes with every rename or translation).
                let mut owner_pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut owner_pid));
                if owner_pid == std::process::id() {
                    return BOOL(1);
                }

                let len = GetWindowTextLengthW(hwnd);
                if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    GetWindowTextW(hwnd, &mut buf);
                    let title = String::from_utf16_lossy(&buf[..len as usize]);
                    let title_trimmed = title.trim().to_string();

                    if !title_trimmed.is_empty() {
                        let list = &mut *(lparam.0 as *mut Vec<(String, isize)>);
                        list.push((title_trimmed, hwnd.0 as isize));
                    }
                }
            }
            BOOL(1)
        }

        let mut raw_list: Vec<(String, isize)> = Vec::new();
        unsafe {
            let _ = EnumWindows(
                Some(enum_callback),
                LPARAM(&mut raw_list as *mut Vec<(String, isize)> as isize),
            );
        }

        for (i, (title, hwnd_val)) in raw_list.into_iter().enumerate() {
            // The type is shown under the window title (the part after '|' in the path).
            let t_lower = title.to_lowercase();
            let mut app_type = "Applicazione";

            if t_lower.ends_with("- google chrome") {
                app_type = "Scheda di Chrome";
            } else if t_lower.ends_with("- brave") {
                app_type = "Scheda di Brave";
            } else if t_lower.ends_with("- microsoft edge") || t_lower.ends_with("- microsoft\u{200b} edge") {
                app_type = "Scheda di Edge";
            } else if t_lower.ends_with("- mozilla firefox") {
                app_type = "Scheda di Firefox";
            } else if t_lower.ends_with("- visual studio code") {
                app_type = "VS Code";
            } else if t_lower.contains("discord") {
                app_type = "Discord";
            } else if t_lower.contains("whatsapp") {
                app_type = "WhatsApp";
            }

            windows_list.push(SearchResult {
                path: format!("hwnd:{}|{}", hwnd_val, app_type),
                name: title,
                kind: "active_tab".to_string(),
                score: (200 - i as u16).max(1),
                icon_data: None,
            });
        }
    }

    windows_list
}

#[tauri::command]
fn focus_window(app: tauri::AppHandle, hwnd_val: isize) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };

        unsafe {
            let hwnd = HWND(hwnd_val);
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

// The /nox filter re-runs the search on every keystroke. Detecting Nox Dimmer spawns
// `tasklist`, so the answer is reused for a few seconds instead of being recomputed
// for each character typed.
const NOX_DETECTION_TTL: std::time::Duration = std::time::Duration::from_secs(5);
static NOX_DETECTION_CACHE: Lazy<Mutex<Option<(Instant, bool)>>> = Lazy::new(|| Mutex::new(None));

fn is_nox_installed() -> bool {
    let mut cache = NOX_DETECTION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((checked_at, installed)) = *cache {
        if checked_at.elapsed() < NOX_DETECTION_TTL {
            return installed;
        }
    }
    let installed = detect_nox_installed();
    *cache = Some((Instant::now(), installed));
    installed
}

fn detect_nox_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq Nox Dimmer.exe", "/NH", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.to_lowercase().contains("nox dimmer.exe") {
                return true;
            }
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let nox_dir = std::path::PathBuf::from(appdata).join("NoxDimmer");
        if nox_dir.exists() {
            return true;
        }
    }
    false
}

fn get_nox_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("reg")
            .args(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Nox Dimmer"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("REG_SZ") {
                    let parts: Vec<&str> = line.split("REG_SZ").collect();
                    if parts.len() == 2 {
                        let path = parts[1].trim();
                        let clean_path = path.trim_matches('"');
                        if !clean_path.is_empty() {
                            return Some(clean_path.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn send_nox_command(cmd: &[u8]) -> bool {
    use std::io::Write;
    if let Ok(mut stream) = std::net::TcpStream::connect("127.0.0.1:50291") {
        let _ = stream.write_all(cmd);
        true
    } else {
        false
    }
}





#[tauri::command]
fn execute_nox_command(action: String, _value: Option<i32>) {
    match action.as_str() {
        "open" => {
            if !send_nox_command(b"NOX_DIMMER_WAKE") {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                if let Some(exe_path) = get_nox_path() {
                    let _ = std::process::Command::new(exe_path)
                        .creation_flags(0x08000000)
                        .spawn();
                }
            }
        }
        }
        "quit" => {
            send_nox_command(b"NOX_DIMMER_QUIT");
        }
        "hyper_toggle" => {
            send_nox_command(b"NOX_HYPER_TOGGLE");
        }
        "brightness_up" => {
            send_nox_command(b"NOX_DIM_UP");
        }
        "brightness_down" => {
            send_nox_command(b"NOX_DIM_DOWN");
        }
        _ => {}
    }
}

#[tauri::command]
fn run_terminal_command(command: String) {
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "cmd", "/K", &command])
        .spawn();
}

fn scan_folder(path: &str, kind_override: Option<&str>, index: &mut Vec<IndexedItem>, arena: &mut String) {
    let walker = WalkDir::new(path)
        .skip_hidden(true)
        .min_depth(1)
        .process_read_dir(|_, _, _, children| {
            children.retain(|result| {
                if let Ok(entry) = result {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    
                    if name == "$recycle.bin" || name == "system volume information"
                    {
                        return false; 
                    }
                }
                true
            });
    });
        
    for entry in walker {
        if let Ok(entry) = entry {
            let path_str = entry.path().to_string_lossy().to_string();
            let is_dir = entry.file_type().is_dir();

            let kind;

            if kind_override == Some("app") {
                if is_dir {
                    continue;
                }

                let ext = entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();

                if ["exe", "lnk", "url"].contains(&ext.as_str()) {
                    let file_name = entry.file_name().to_string_lossy().to_lowercase();

                    let is_unwanted = file_name.contains("uninstall")
                        || file_name.starts_with("unins")
                        || file_name.contains("updater")
                        || file_name.contains("reporter")
                        || file_name.contains("setup")
                        || file_name.contains("install")
                        || file_name.contains("helper")
                        || file_name.contains("bug")
                        || file_name.contains("crash")
                        || file_name.contains("telemetry")
                        || file_name.contains("bugreport")
                        || file_name.contains("dump")
                        || file_name.contains("maintenance")
                        || file_name.contains("service")
                        || file_name.contains("host")
                        || file_name.contains("daemon")
                        || file_name.contains("agent")
                        || file_name.contains("broker")
                        || file_name.contains("elevate")
                        || file_name.contains("uac")
                        || file_name.contains("language_server")
                        || file_name.contains("lsp")
                        || file_name.contains("esbuild")
                        || file_name.contains("protoc")
                        || file_name.contains("prettier")
                        || file_name.contains("eslint")
                        || file_name.contains("pylint")
                        || file_name.contains("chromedriver")
                        || file_name.contains("geckodriver")
                        || file_name.ends_with("cli.exe")
                        || file_name == "buf.exe"
                        || file_name == "tsc.exe"
                        || file_name == "npm.cmd"
                        || file_name == "yarn.cmd"
                        || file_name == "pip.exe";

                    if is_unwanted {
                        // kind = ItemKind::File;
                        continue;
                    } else {
                        kind = ItemKind::App;
                    }
                } else {
                    kind = ItemKind::File;
                }
            } else {
                if is_dir {
                    kind = ItemKind::Folder;
                } else {
                    kind = ItemKind::File;
                }
            }

            // if path_str.contains("$Recycle.Bin") || path_str.contains("System Volume Information") {
            //     continue;
            // }

            // let path_lower = path_str.to_ascii_lowercase();
            
            let mut name = Path::new(&path_str)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path_str.clone());

            if name.to_lowercase().ends_with(".lnk") || name.to_lowercase().ends_with(".exe") {
                if name.len() > 4 {
                    name = name[..name.len() - 4].to_string();
                }
            }

            push_index_item(index, arena, &path_str, &name, &fold_for_search(&name), kind);
        }
    }
}

/// Appends one item to the index. `key` is what queries are matched against: the folded name,
/// followed by the folded aliases for built-in entries (see `search_key`). Items whose slices
/// do not fit the u16 lengths of the cache format are skipped.
fn push_index_item(index: &mut Vec<IndexedItem>, arena: &mut String, path: &str, name: &str, key: &str, kind: ItemKind) {
    let limit = u16::MAX as usize;
    if path.len() > limit || name.len() > limit || key.len() > limit {
        return;
    }

    let path_start = arena.len() as u32;
    arena.push_str(path);
    let name_start = arena.len() as u32;
    arena.push_str(name);
    let name_lower_start = arena.len() as u32;
    arena.push_str(key);

    index.push(IndexedItem {
        path_start,
        path_len: path.len() as u16,
        name_start,
        name_len: name.len() as u16,
        name_lower_start,
        name_lower_len: key.len() as u16,
        kind,
    });
}

fn index_system_settings(index: &mut Vec<IndexedItem>, arena: &mut String) {
    for entry in SYSTEM_ENTRIES {
        push_index_item(index, arena, entry.path, entry.name, &search_key(entry.name, entry.aliases), ItemKind::Command);
    }
}

fn index_windows_apps(index: &mut Vec<IndexedItem>, arena: &mut String) {
    let mut command = std::process::Command::new("powershell");
    command.args([
            "-NoProfile",
            "-Command",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
        ]); 

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output();

    if let Ok(output) = output {
        let json_str = String::from_utf8_lossy(&output.stdout);
        
        if let Ok(apps) = serde_json::from_str::<serde_json::Value>(&json_str) {
            let app_list = if let Some(arr) = apps.as_array() {
                arr.to_vec()
            } else if apps.is_object() {
                vec![apps]
            } else {
                vec![]
            };

            for app in app_list {
                let name = app.get("Name").or(app.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                let app_id = app.get("AppID").or(app.get("AppId")).or(app.get("appid")).and_then(|v| v.as_str()).unwrap_or("");

                if !name.is_empty() && !app_id.is_empty() {
                    let path = if app_id.contains(':') {
                        app_id.to_string()
                    } else {
                        format!("shell:AppsFolder\\{}", app_id)
                    };

                    push_index_item(index, arena, &path, name, &fold_for_search(name), ItemKind::App);
                }
            }
        }
    }
}

fn index_rocket_commands(index: &mut Vec<IndexedItem>, arena: &mut String) {
    for command in ROCKET_COMMANDS.iter().filter(|command| command.indexed) {
        let entry = &command.entry;
        push_index_item(index, arena, entry.path, entry.name, &search_key(entry.name, entry.aliases), ItemKind::Command);
    }
}

#[tauri::command]
fn trigger_index_refresh(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        build_index_internal(&app, false);
    });
}

fn build_index_internal(app: &tauri::AppHandle, silent: bool) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_LOWEST};
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
        }
    }

    if !silent {
        IS_INDEXING.store(true, Ordering::SeqCst);
    }

    let start = Instant::now();
    println!("\nIndexing started (silent: {})...", silent);

    let mut new_items = Vec::new();
    let mut new_arena = String::with_capacity(75_000_000);
    
    index_system_settings(&mut new_items, &mut new_arena);
    index_rocket_commands(&mut new_items, &mut new_arena);
    index_windows_apps(&mut new_items, &mut new_arena);

    let mut app_paths = Vec::new();
    if let Ok(prog_data) = std::env::var("ProgramData") {
        app_paths.push(format!(r"{}\Microsoft\Windows\Start Menu\Programs", prog_data));
    }
    if let Ok(system_drive) = std::env::var("SystemDrive") {
        app_paths.push(format!(r"{}\Users\Default\AppData\Roaming\Microsoft\Windows\Start Menu\Programs", system_drive));
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let user_start = format!(r"{}\Microsoft\Windows\Start Menu\Programs", appdata);
        if Path::new(&user_start).exists() {
            scan_folder(&user_start, Some("app"), &mut new_items, &mut new_arena);
        }
    }

    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let local_apps = format!(r"{}\Microsoft\WindowsApps", local_appdata);
        if Path::new(&local_apps).exists() {
            scan_folder(&local_apps, Some("app"), &mut new_items, &mut new_arena);
        }

        let local_start = format!(r"{}\Microsoft\Windows\Start Menu\Programs", local_appdata);
        if Path::new(&local_start).exists() {
            scan_folder(&local_start, Some("app"), &mut new_items, &mut new_arena);
        }

        let user_progs = format!(r"{}\Programs", local_appdata);
        if Path::new(&user_progs).exists() {
            scan_folder(&user_progs, Some("app"), &mut new_items, &mut new_arena);
        }
    }

    for path in app_paths {
        if Path::new(&path).exists() {
            scan_folder(&path, Some("app"), &mut new_items, &mut new_arena);
        }
    }

    let drives = get_available_drives();
    for drive in drives {
        println!("Scanning drive: {}", drive);

        push_index_item(&mut new_items, &mut new_arena, &drive, &drive, &fold_for_search(&drive), ItemKind::Drive);

        scan_folder(&drive, None, &mut new_items, &mut new_arena);
    }

    let duration = start.elapsed();
    let count = new_items.len();
    
    let new_index = FileIndexData {
        items: new_items,
        arena: new_arena,
    };

    *FILE_INDEX.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = new_index;
    println!(
        "\nIndexing complete (silent: {})! Items: {} (Took: {:?})",
        silent,
        count,
        duration
    );

    if !silent {
        IS_INDEXING.store(false, Ordering::SeqCst);
        let _ = app.emit("index_refreshed", ());
    }

    let binfile_start = std::time::Instant::now();
    if let Ok(file) = std::fs::File::create(get_binfile_path(app)) {
        let mut writer = std::io::BufWriter::new(file);
        let index_read = FILE_INDEX.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(e) = bincode::serialize_into(&mut writer, &*index_read) {
            eprintln!("Failed to serialize index to binfile: {}", e);
        } else {
            println!("Binfile stored to disk in {:?}", binfile_start.elapsed());
        }
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
        use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_NORMAL};
        unsafe {
            let _ = EmptyWorkingSet(GetCurrentProcess());
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_NORMAL);
            println!("Working set memory cleaned and thread priority restored to normal.");
        }
    }
}

#[tauri::command]
fn get_memory_usage() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows::Win32::System::Threading::GetCurrentProcess;

        unsafe {
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            if GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
            .is_ok()
            {
                return counters.WorkingSetSize as u64;
            }
        }
    }
    0
}

fn start_periodic_indexing(app: tauri::AppHandle, mut has_binfile: bool) {
    std::thread::spawn(move || {
        loop {
            build_index_internal(&app, has_binfile);
            has_binfile = true; 
            std::thread::sleep(std::time::Duration::from_secs(15 * 60));
        }
    });
}

#[tauri::command]
fn get_indexing_state() -> bool {
    IS_INDEXING.load(Ordering::SeqCst)
}

fn main() {
    // start_periodic_indexing();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        // A single registration with an explicit name: the HKCU Run value is called
        // "RocketLauncher" whatever package_info().name resolves to.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("RocketLauncher")
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                        println!("Global shortcut pressed: {:?}", shortcut);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            search_files,
            open_file,
            reset_window,
            resize_window,
            get_current_shortcut,
            update_shortcut,
            get_available_drives,
            run_terminal_command,
            set_recents_state,
            execute_media_key,
            check_shortcuts_availability,
            trigger_index_refresh,
            show_desktop,
            get_active_windows,
            focus_window,
            get_indexing_state,
            get_memory_usage,
            quit_app,
            close_active_window,
            open_url_private,
            execute_nox_command,
            show_in_explorer
        ])
        .setup(|app| {
            let mut has_binfile = false;
            
            if let Ok(file) = std::fs::File::open(get_binfile_path(app.handle())) {
                let load_start = std::time::Instant::now();
                let mut reader = std::io::BufReader::new(file);
                if let Ok(index) = bincode::deserialize_from(&mut reader) {
                    *FILE_INDEX.write().unwrap_or_else(|p| p.into_inner()) = index;
                    println!("Loaded index from binfile in {:?}.", load_start.elapsed());
                    has_binfile = true;
                }
            }

            start_periodic_indexing(app.handle().clone(), has_binfile);

            let window = app.get_webview_window("main").unwrap();
            let w_clone = window.clone();

            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    if REFOCUS_ON_BLUR.compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                        let _ = w_clone.set_focus();
                        let w_check = w_clone.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            if !w_check.is_focused().unwrap_or(false) {
                                let _ = w_check.hide();
                            }
                        });
                    } else {
                        let _ = w_clone.hide();
                    }
                }
            });

            let quit_i = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Mostra RocketLauncher", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon_bytes = include_bytes!("../icons/icon_32x32.png");
            let tray_icon = match image::load_from_memory(icon_bytes) {
                Ok(dynamic_img) => {
                    let rgba_img = dynamic_img.into_rgba8();
                    let (width, height) = rgba_img.dimensions();
                    tauri::image::Image::new_owned(rgba_img.into_raw(), width, height)
                }
                Err(_) => app.default_window_icon().unwrap().clone(),
            };

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("RocketLauncher")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        toggle_main_window(app);
                    }
                    _ => {
                        println!("menu item {:?} not handled", event.id);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        toggle_main_window(app);
                    }
                })
                .build(app)?;

            let loaded_shortcut = load_shortcut(app.handle());
            let mut current = CURRENT_SHORTCUT.lock().unwrap();

            if app.global_shortcut().register(loaded_shortcut.as_str()).is_ok() {
                *current = loaded_shortcut.clone();
            } else {
                eprintln!("Failed to register loaded shortcut, trying fallbacks...");
                let mut found = false;
                for sc in PRESET_SHORTCUTS {
                    if app.global_shortcut().register(*sc).is_ok() {
                        *current = sc.to_string();
                        save_shortcut(app.handle(), sc);
                        println!("Fallback shortcut registered: {}", sc);
                        found = true;
                        break;
                    }
                }
                if !found {
                    eprintln!("Failed to register any fallback shortcuts");
                }
            }

            show_main_window(app.handle());
            REFOCUS_ON_BLUR.store(true, Ordering::SeqCst);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
#[cfg(test)]
mod tests {
    use super::*;

    /// An index holding the built-in entries plus `extra` (path, name, kind) items.
    fn index_with(extra: &[(&str, &str, ItemKind)]) -> FileIndexData {
        let mut items = Vec::new();
        let mut arena = String::new();
        index_system_settings(&mut items, &mut arena);
        index_rocket_commands(&mut items, &mut arena);
        for (path, name, kind) in extra {
            push_index_item(&mut items, &mut arena, path, name, &fold_for_search(name), *kind);
        }
        FileIndexData { items, arena }
    }

    fn paths(results: &[SearchResult]) -> Vec<&str> {
        results.iter().map(|result| result.path.as_str()).collect()
    }

    #[test]
    fn folding_lowercases_and_removes_accents() {
        assert_eq!(fold_for_search("Gestione attività"), "gestione attivita");
        assert_eq!(fold_for_search("PERCHÉ è così"), "perche e cosi");
        assert_eq!(fold_for_search("Unità C:\\"), "unita c:\\");
        assert_eq!(fold_for_search("Variabili d\u{2019}ambiente"), "variabili d'ambiente");
        assert_eq!(fold_for_search("Plain ASCII.txt"), "plain ascii.txt");
    }

    #[test]
    fn search_key_puts_the_display_name_first_and_skips_repeated_aliases() {
        assert_eq!(
            search_key("Windows Update", &["windows update", "Aggiornamenti"]),
            "windows update\u{1F}aggiornamenti"
        );
        assert_eq!(search_key("Luminosità", &[]), "luminosita");
    }

    #[test]
    fn each_alias_is_matched_on_its_own() {
        let key = search_key("Arresta il sistema", &["Shutdown", "spegni il pc"]);
        assert_eq!(name_match(&key, "shutdown"), NameMatch::Exact);
        assert_eq!(name_match(&key, "arresta il sistema"), NameMatch::Exact);
        assert_eq!(name_match(&key, "spe"), NameMatch::Prefix);
        assert_eq!(name_match(&key, "sistema"), NameMatch::Contains);
        assert_eq!(name_match(&key, "riavvia"), NameMatch::None);
        // The separator never lets a query span two aliases.
        assert_eq!(name_match(&key, "sistema shutdown"), NameMatch::None);
    }

    #[test]
    fn every_upstream_english_name_is_still_an_exact_alias() {
        let system_names = [
            "Startup Apps", "Uninstall Program", "Apps & Features", "Installed Apps", "Windows Update",
            "Display Settings", "Sound Settings", "Bluetooth & other devices", "Wi-Fi Settings",
            "Personalization", "Taskbar Settings", "Date & Time Settings", "Power & Sleep Settings",
            "Storage Settings", "Background Apps", "Notifications & actions", "Default Apps", "Control Panel",
            "Uninstall Program (Classic)", "Task Manager", "System Information", "Command Prompt", "PowerShell",
            "Registry Editor", "Environment Variables", "System Properties", "Network Connections",
            "Disk Management", "Device Manager", "Services", "Group Policy Editor", "Resource Monitor",
            "Event Viewer",
        ];
        for english in system_names {
            let query = fold_for_search(english);
            assert!(
                SYSTEM_ENTRIES
                    .iter()
                    .any(|entry| name_match(&search_key(entry.name, entry.aliases), &query) == NameMatch::Exact),
                "no system entry answers to {english:?}"
            );
        }

        let command_names = [
            "RocketLauncher: Help", "RocketLauncher Settings", "RocketLauncher: Toggle Recents",
            "RocketLauncher: Clear Recents", "RocketLauncher: Refresh Index", "Show Desktop", "Active Tabs",
            "Quit RocketLauncher", "Close Active Tab/Window", "Shutdown", "Media: Play/Pause", "Media: Next Track",
            "Media: Previous Track", "Restart",
        ];
        for english in command_names {
            let query = fold_for_search(english);
            assert!(
                ROCKET_COMMANDS.iter().any(|command| {
                    name_match(&search_key(command.entry.name, command.entry.aliases), &query) == NameMatch::Exact
                }),
                "no RocketLauncher command answers to {english:?}"
            );
        }
    }

    #[test]
    fn general_search_finds_italian_names_with_or_without_accents_and_english_aliases() {
        let index = index_with(&[]);

        for query in ["attivita", "attività", "Gestione Attività", "task manager", "taskmgr"] {
            let results = search_index(&index, query);
            assert_eq!(results.first().map(|r| r.path.as_str()), Some("cmd:taskmgr"), "query {query:?}");
            assert_eq!(results[0].name, "Gestione attività");
        }

        let results = search_index(&index, "shutdown");
        assert_eq!(results[0].path, "rocket:request_shutdown");
        assert_eq!(results[0].name, "Arresta il sistema");
        assert!(paths(&search_index(&index, "spegni")).contains(&"rocket:request_shutdown"));
        assert!(paths(&search_index(&index, "luminosita")).contains(&"ms-settings:display"));
    }

    #[test]
    fn exact_alias_outranks_a_prefix_match() {
        let index = index_with(&[]);
        let results = search_index(&index, "disinstalla");
        assert_eq!(results[0].name, "Disinstalla un programma");
        assert!(paths(&results).contains(&"cmd:appwiz.cpl"));
    }

    #[test]
    fn a_start_menu_app_replaces_the_built_in_command_with_the_same_name() {
        let app_path = "shell:AppsFolder\\Microsoft.AutoGenerated.{10D58619}";
        let index = index_with(&[(app_path, "Gestione attività", ItemKind::App)]);

        assert_eq!(paths(&search_index(&index, "gestione attivita")), vec![app_path]);
        // The English alias only matches the command, which therefore stays.
        assert_eq!(paths(&search_index(&index, "task manager")), vec!["cmd:taskmgr"]);
    }

    #[test]
    fn italian_filter_words_are_categories_not_extensions() {
        assert_eq!(classify_filter("cartelle"), FilterToken::Folders);
        assert_eq!(classify_filter("cartella"), FilterToken::Folders);
        assert_eq!(classify_filter("applicazioni"), FilterToken::Apps);
        assert_eq!(classify_filter("programmi"), FilterToken::Apps);
        assert_eq!(classify_filter("unità"), FilterToken::Drives);
        assert_eq!(classify_filter("UNITA"), FilterToken::Drives);
        assert_eq!(classify_filter("dischi"), FilterToken::Drives);
        assert_eq!(classify_filter("finestre"), FilterToken::Tabs);
        assert_eq!(classify_filter("schede"), FilterToken::Tabs);
        assert_eq!(classify_filter("impostazioni"), FilterToken::Rocket);
        assert_eq!(classify_filter("comandi"), FilterToken::Rocket);
        assert_eq!(classify_filter("siti"), FilterToken::Web);
        assert_eq!(classify_filter("questopc"), FilterToken::ThisPc);
        assert_eq!(classify_filter("privato"), FilterToken::Private);
        assert_eq!(classify_filter("incognito"), FilterToken::Private);
        assert_eq!(classify_filter("esegui"), FilterToken::FrontendOnly);
        assert_eq!(classify_filter("cerca"), FilterToken::FrontendOnly);
        assert_eq!(classify_filter("configurazione"), FilterToken::Commands);
    }

    #[test]
    fn english_filters_drive_letters_and_extensions_keep_working() {
        assert_eq!(classify_filter("folders"), FilterToken::Folders);
        assert_eq!(classify_filter("apps"), FilterToken::Apps);
        assert_eq!(classify_filter("tabs"), FilterToken::Tabs);
        assert_eq!(classify_filter("settings"), FilterToken::Rocket);
        assert_eq!(classify_filter("rocket"), FilterToken::Rocket);
        assert_eq!(classify_filter("web"), FilterToken::Web);
        assert_eq!(classify_filter("pc"), FilterToken::ThisPc);
        assert_eq!(classify_filter("p"), FilterToken::Private);
        assert_eq!(classify_filter("config"), FilterToken::Commands);
        assert_eq!(classify_filter("google"), FilterToken::FrontendOnly);
        assert_eq!(classify_filter("c"), FilterToken::DriveLetter('c'));
        assert_eq!(classify_filter("D:"), FilterToken::DriveLetter('d'));
        assert_eq!(classify_filter("pdf"), FilterToken::Extension("pdf".to_string()));
        assert_eq!(classify_filter("velo"), FilterToken::Extension("velo".to_string()));
    }

    #[test]
    fn filters_keep_kinds_drives_and_extensions() {
        assert!(passes_filters(&[FilterToken::Folders], ItemKind::Folder, "C:\\Progetti"));
        assert!(!passes_filters(&[FilterToken::Folders], ItemKind::File, "C:\\Progetti.txt"));
        assert!(passes_filters(&[FilterToken::Apps], ItemKind::File, "C:\\Tools\\tool.EXE"));
        assert!(passes_filters(&[FilterToken::DriveLetter('c')], ItemKind::File, "c:\\a.txt"));
        assert!(!passes_filters(&[FilterToken::DriveLetter('c')], ItemKind::File, "D:\\a.txt"));
        let pdf = [FilterToken::Extension("pdf".to_string())];
        assert!(passes_filters(&pdf, ItemKind::File, "C:\\Documenti\\Relazione.PDF"));
        assert!(!passes_filters(&pdf, ItemKind::File, "C:\\Documenti\\pdf"));
        assert!(!passes_filters(&pdf, ItemKind::File, "C:\\Documenti\\a.xpdf"));
        assert!(passes_filters(&[FilterToken::Private, FilterToken::FrontendOnly], ItemKind::File, "C:\\a"));
    }

    #[test]
    fn italian_filter_chips_limit_the_general_search() {
        let index = index_with(&[
            ("C:\\Progetti", "Progetti", ItemKind::Folder),
            ("C:\\Note\\Progetti.txt", "Progetti.txt", ItemKind::File),
        ]);
        assert_eq!(paths(&search_index(&index, "/cartelle progetti")), vec!["C:\\Progetti"]);
        assert_eq!(paths(&search_index(&index, "@file progetti")), vec!["C:\\Note\\Progetti.txt"]);
        assert_eq!(paths(&search_index(&index, "/txt progetti")), vec!["C:\\Note\\Progetti.txt"]);
    }

    #[test]
    fn rocket_list_answers_to_italian_and_english_words() {
        let empty = FileIndexData::default();
        assert_eq!(paths(&search_index(&empty, "/rocket spegni")), vec!["rocket:request_shutdown"]);
        assert_eq!(paths(&search_index(&empty, "/impostazioni restart")), vec!["rocket:request_restart"]);
        assert_eq!(paths(&search_index(&empty, "/comandi luminosita")), vec!["ms-settings:display"]);
        assert_eq!(paths(&search_index(&empty, "/settings quit")), vec!["rocket:quit"]);
        assert_eq!(
            search_index(&empty, "/rocket").len(),
            ROCKET_COMMANDS.len() + ROCKET_LIST_SYSTEM_ENTRIES.len()
        );
    }

    #[test]
    fn web_list_uses_italian_editions_and_opens_typed_urls() {
        let empty = FileIndexData::default();
        assert_eq!(paths(&search_index(&empty, "/web wiki")), vec!["https://it.wikipedia.org"]);
        assert_eq!(paths(&search_index(&empty, "/siti amazon")), vec!["https://www.amazon.it"]);

        let typed = search_index(&empty, "/sito Example.com/Pagina");
        assert_eq!(typed[0].path, "https://Example.com/Pagina");
        assert_eq!(typed[0].name, "Apri Example.com/Pagina");
    }

    #[test]
    fn private_mode_alone_lists_the_websites() {
        let empty = FileIndexData::default();
        assert_eq!(search_index(&empty, "/p").len(), WEB_PRESETS.len());
        assert_eq!(search_index(&empty, "@privato").len(), WEB_PRESETS.len());
        assert_eq!(search_index(&empty, "/p /google").len(), WEB_PRESETS.len());
    }

    #[test]
    fn interface_only_filters_add_nothing_from_the_index() {
        let index = index_with(&[]);
        assert!(search_index(&index, "/google gestione").is_empty());
        assert!(search_index(&index, "/esegui dir").is_empty());
    }

    #[test]
    fn pinned_rows_need_two_letters_starting_a_word() {
        assert!(pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "pc"));
        assert!(pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "questo"));
        assert!(pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "this"));
        assert!(pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "comp"));
        assert!(!pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "t"));
        assert!(!pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "is"));
        assert!(!pinned_entry_matches(THIS_PC.name, THIS_PC.aliases, "sto"));
        assert!(pinned_entry_matches(GALLERY.name, GALLERY.aliases, "gal"));
        assert!(!pinned_entry_matches(GALLERY.name, GALLERY.aliases, "a"));
        assert!(!pinned_entry_matches(GALLERY.name, GALLERY.aliases, "le"));
    }

    #[test]
    fn user_folders_get_their_italian_names() {
        assert_eq!(known_folder_name("C:\\Users\\Ada\\Pictures", "C:\\Users\\Ada"), Some("Immagini"));
        assert_eq!(known_folder_name("c:\\users\\ada\\downloads", "C:\\Users\\Ada"), Some("Download"));
        assert_eq!(known_folder_name("C:\\Users\\Ada\\Pictures\\2024", "C:\\Users\\Ada"), None);
        assert_eq!(known_folder_name("C:\\Users\\Bob\\Music", "C:\\Users\\Ada"), None);
        assert_eq!(known_folder_name("C:\\Users\\Ada", "C:\\Users\\Ada"), None);
    }

    #[test]
    fn glued_english_filter_words_keep_their_upstream_shortcut() {
        assert!(query_starts_with_filter("/rocketlauncher", &["rocket"]));
        assert!(query_starts_with_filter("@nox-dimmer", &["nox"]));
        assert!(!query_starts_with_filter("rocket", &["rocket"]));
        assert!(!query_starts_with_filter("/web", &["tabs"]));
    }
}
