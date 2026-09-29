#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use jwalk::WalkDir;
use once_cell::sync::Lazy;
use std::collections::{BTreeMap, HashSet};
use std::io::Cursor;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::RwLock;
use std::time::Instant;
use systemicons::get_icon;
use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

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
    Lazy::new(|| Mutex::new(DEFAULT_SHORTCUT.to_string()));
/// True while the settings record a combination: the global shortcut is unregistered so that pressing it reaches the
/// recorder instead of hiding the window. It is registered again when the recording ends or the window hides.
static SHORTCUT_PAUSED: AtomicBool = AtomicBool::new(false);
/// settings.json is read, changed and written back by more than one command.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static FILE_INDEX: Lazy<RwLock<FileIndexData>> = Lazy::new(|| RwLock::new(FileIndexData::default()));
static SHOW_RECENTS: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(true));
/// The saved global shortcut when another app held it at start-up: a preset stands in for this session only and the
/// saved one is tried again at the next start. Cleared as soon as the user picks a shortcut.
static PREFERRED_SHORTCUT_BUSY: Mutex<Option<String>> = Mutex::new(None);
/// Armed when the window becomes visible: Windows can take the focus away right after a show (the Win key of the
/// shortcut being released, the foreground lock), so the first focus loss within SHOW_FOCUS_GRACE takes the focus
/// back once instead of hiding at once, and the window hides only if it is still not focused shortly after.
static REFOCUS_ON_BLUR: AtomicBool = AtomicBool::new(false);
static SHOWN_AT: Mutex<Option<Instant>> = Mutex::new(None);
const SHOW_FOCUS_GRACE: std::time::Duration = std::time::Duration::from_millis(600);
/// The window was shown cloaked and waits for the page to paint the clean bar (reveal_window).
static REVEAL_PENDING: AtomicBool = AtomicBool::new(false);
/// Which show a delayed reveal belongs to, so a late one never reveals a later show early.
static REVEAL_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Set by the page's first reveal_window call; until then (start-up) the reveal waits longer for the page to load.
static PAGE_READY: AtomicBool = AtomicBool::new(false);
const REVEAL_FALLBACK: std::time::Duration = std::time::Duration::from_millis(150);
const REVEAL_FALLBACK_LOADING: std::time::Duration = std::time::Duration::from_millis(1500);
static IS_INDEXING: AtomicBool = AtomicBool::new(false);

// Window size, shared with src/main.js (WINDOW_MIN_HEIGHT, WINDOW_MAX_HEIGHT) and src/styles.css (--bar-h):
// collapsed, the window shows only the search bar.
const WINDOW_WIDTH: f64 = 800.0;
const COLLAPSED_HEIGHT: f64 = 56.0;
const EXPANDED_HEIGHT: f64 = 400.0;

/// Material behind the glass that src/styles.css draws over it. Mica (Windows 11) follows the Windows app theme by
/// itself, because tao keeps the window's dark-mode attribute in sync; Acrylic (Windows 10 1809 and later) gets the
/// tint of the current theme and is applied again when the theme changes. Without either, styles.css draws a denser
/// glass. ROCKETLAUNCHER_MATERIAL=mica|acrylic|none overrides the choice, to compare the materials or to turn one off.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WindowMaterial {
    Mica,
    Acrylic,
    Plain,
}

impl WindowMaterial {
    fn as_str(self) -> &'static str {
        match self {
            WindowMaterial::Mica => "mica",
            WindowMaterial::Acrylic => "acrylic",
            WindowMaterial::Plain => "none",
        }
    }
}

/// Windows 11: Mica exists and DWM rounds the corners of this window (8 px, the radius styles.css uses there).
const FIRST_WINDOWS_11_BUILD: u32 = 22000;
/// Windows 10 1809: the first build where Acrylic works on a window.
const FIRST_ACRYLIC_BUILD: u32 = 17763;

// Acrylic tint on Windows 10 as RGBA (Windows 11 ignores it). tests/design-contrast.test.mjs reads these two lines.
const ACRYLIC_TINT_DARK: (u8, u8, u8, u8) = (20, 20, 24, 153);
const ACRYLIC_TINT_LIGHT: (u8, u8, u8, u8) = (243, 243, 245, 153);

static WINDOW_MATERIAL: std::sync::OnceLock<WindowMaterial> = std::sync::OnceLock::new();

fn windows_build() -> u32 {
    #[cfg(windows)]
    {
        windows_version::OsVersion::current().build
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn material_for(build: u32, requested: Option<&str>) -> WindowMaterial {
    match requested.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("mica") => WindowMaterial::Mica,
        Some("acrylic") => WindowMaterial::Acrylic,
        Some("none") => WindowMaterial::Plain,
        _ if build >= FIRST_WINDOWS_11_BUILD => WindowMaterial::Mica,
        _ if build >= FIRST_ACRYLIC_BUILD => WindowMaterial::Acrylic,
        _ => WindowMaterial::Plain,
    }
}

fn chosen_material() -> WindowMaterial {
    *WINDOW_MATERIAL.get_or_init(|| {
        material_for(windows_build(), std::env::var("ROCKETLAUNCHER_MATERIAL").ok().as_deref())
    })
}

fn apply_window_material(window: &tauri::WebviewWindow) {
    use tauri::window::{Color, Effect, EffectsBuilder};
    let effects = match chosen_material() {
        WindowMaterial::Mica => EffectsBuilder::new().effect(Effect::Mica).build(),
        WindowMaterial::Acrylic => {
            let dark = !matches!(window.theme(), Ok(tauri::Theme::Light));
            let (r, g, b, a) = if dark { ACRYLIC_TINT_DARK } else { ACRYLIC_TINT_LIGHT };
            EffectsBuilder::new().effect(Effect::Acrylic).color(Color(r, g, b, a)).build()
        }
        WindowMaterial::Plain => return,
    };
    let _ = window.set_effects(effects);
}

/// What styles.css needs to know about the window: the material, and who draws the corners. "dwm": Windows 11
/// rounds the window itself; "square": Acrylic on Windows 10 fills the square window; "css": no material, the
/// transparent corners are cut by the CSS radius.
#[tauri::command]
fn window_material() -> serde_json::Value {
    let material = chosen_material();
    let corners = if windows_build() >= FIRST_WINDOWS_11_BUILD {
        "dwm"
    } else if material == WindowMaterial::Plain {
        "css"
    } else {
        "square"
    };
    serde_json::json!({ "material": material.as_str(), "corners": corners })
}

// ---------------------------------------------------------------------------
// Global shortcut
//
// The combination that shows RocketLauncher from any app, in the syntax of tauri-plugin-global-shortcut
// ("Super+Shift+."). src/shortcuts.js records it, checks it with the same rules as shortcut_problem() and shows it in
// Italian; here it is checked again, registered (RegisterHotKey) and saved in settings.json.
// ---------------------------------------------------------------------------

/// The upstream Velocmd presets, offered as quick picks (src/shortcuts.js has the same list); the first is the
/// default, and at start-up the first one that registers replaces a saved shortcut that no longer does.
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
const DEFAULT_SHORTCUT: &str = "Super+Shift+.";

/// Why a global shortcut is refused before RocketLauncher tries to register it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutProblem {
    /// Not a combination tauri-plugin-global-shortcut understands (or a key it cannot register).
    Invalid,
    /// No Ctrl, Alt or Win, and not F1-F24.
    MissingModifier,
    /// Maiusc alone would take capital letters and symbols away from every app.
    ShiftOnly,
    /// Windows keeps it (lock, desktop, snap, task view, emoji panel…) or every window uses it (Alt+Tab, Alt+F4…).
    Reserved,
    /// Ctrl + Alt + a character key is AltGr on Windows, which types @ # [ ] € on an Italian keyboard.
    AltGr,
    /// Alt + a digit of the numeric keypad types a character by its code in every app (Alt+64 is @).
    AltCode,
    /// Ctrl (with or without Maiusc) + a key every app uses: select, copy, paste, cut, undo, redo, save, find, print,
    /// new, open, close and new tab, switch tab, delete a word, start and end of the text.
    Common,
}

impl ShortcutProblem {
    /// The reason code src/shortcuts.js turns into an Italian message.
    fn as_str(self) -> &'static str {
        match self {
            ShortcutProblem::Invalid => "invalid",
            ShortcutProblem::MissingModifier => "missing_modifier",
            ShortcutProblem::ShiftOnly => "shift_only",
            ShortcutProblem::Reserved => "reserved",
            ShortcutProblem::AltGr => "altgr",
            ShortcutProblem::AltCode => "alt_code",
            ShortcutProblem::Common => "common",
        }
    }
}

fn is_letter_key(key: Code) -> bool {
    use Code::*;
    matches!(
        key,
        KeyA | KeyB | KeyC | KeyD | KeyE | KeyF | KeyG | KeyH | KeyI | KeyJ | KeyK | KeyL | KeyM | KeyN | KeyO | KeyP
            | KeyQ | KeyR | KeyS | KeyT | KeyU | KeyV | KeyW | KeyX | KeyY | KeyZ
    )
}

fn is_digit_key(key: Code) -> bool {
    use Code::*;
    matches!(key, Digit0 | Digit1 | Digit2 | Digit3 | Digit4 | Digit5 | Digit6 | Digit7 | Digit8 | Digit9)
}

fn is_function_key(key: Code) -> bool {
    use Code::*;
    matches!(
        key,
        F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 | F12 | F13 | F14 | F15 | F16 | F17 | F18 | F19 | F20
            | F21 | F22 | F23 | F24
    )
}

fn is_arrow_key(key: Code) -> bool {
    matches!(key, Code::ArrowUp | Code::ArrowDown | Code::ArrowLeft | Code::ArrowRight)
}

fn is_numpad_digit(key: Code) -> bool {
    use Code::*;
    matches!(key, Numpad0 | Numpad1 | Numpad2 | Numpad3 | Numpad4 | Numpad5 | Numpad6 | Numpad7 | Numpad8 | Numpad9)
}

/// A key that writes a character: letters, digits and the punctuation keys (VK_OEM_*).
fn is_character_key(key: Code) -> bool {
    use Code::*;
    is_letter_key(key)
        || is_digit_key(key)
        || matches!(
            key,
            Backquote | Minus | Equal | BracketLeft | BracketRight | Backslash | Semicolon | Quote | Comma | Period | Slash
        )
}

/// Combinations Windows keeps for itself or that every window uses. RegisterHotKey refuses most of them anyway; the
/// list gives a clear reason and stops the few it would accept. isReservedByWindows in src/shortcuts.js is the same.
fn is_reserved_by_windows(mods: Modifiers, key: Code) -> bool {
    use Code::*;
    let win = mods.contains(Modifiers::SUPER);
    let ctrl = mods.contains(Modifiers::CONTROL);
    let alt = mods.contains(Modifiers::ALT);
    let shift = mods.contains(Modifiers::SHIFT);
    if win {
        if key == KeyL {
            return true;
        }
        return match (ctrl, alt, shift) {
            (false, false, false) => {
                is_letter_key(key)
                    || is_digit_key(key)
                    || is_arrow_key(key)
                    || matches!(
                        key,
                        Tab | Space | Home | PrintScreen | Comma | Period | Semicolon | Equal | Minus | Escape | Pause
                            | NumpadAdd | NumpadSubtract
                    )
            }
            (false, false, true) => is_digit_key(key) || is_arrow_key(key) || matches!(key, KeyS | KeyM | KeyR | Space),
            (true, false, false) => {
                is_digit_key(key)
                    || matches!(key, KeyD | F4 | ArrowLeft | ArrowRight | Enter | Space | KeyC | KeyF | KeyN | KeyO | KeyQ)
            }
            (false, true, false) => {
                is_digit_key(key)
                    || matches!(key, KeyR | KeyG | KeyB | KeyD | KeyK | PrintScreen | Space | ArrowUp | ArrowDown)
            }
            (true, false, true) => is_digit_key(key) || key == KeyB,
            _ => false,
        };
    }
    match (ctrl, alt, shift) {
        (false, true, false) => matches!(key, Tab | Escape | F4 | PrintScreen),
        (false, true, true) => matches!(key, Tab | Escape),
        (true, false, false) | (true, false, true) => key == Escape,
        (true, true, false) => matches!(key, Tab | Delete),
        (false, false, true) => key == F10,
        _ => false,
    }
}

/// Why a global shortcut cannot be used, or None when RocketLauncher may try to register it. globalShortcutProblem
/// in src/shortcuts.js applies the same rules, in the same order, to show the message before asking.
fn shortcut_problem(accelerator: &str) -> Option<ShortcutProblem> {
    let Ok(shortcut) = Shortcut::from_str(accelerator) else {
        return Some(ShortcutProblem::Invalid);
    };
    let (mods, key) = (shortcut.mods, shortcut.key);
    let win = mods.contains(Modifiers::SUPER);
    let ctrl = mods.contains(Modifiers::CONTROL);
    let alt = mods.contains(Modifiers::ALT);
    let shift = mods.contains(Modifiers::SHIFT);
    if !win && !ctrl && !alt && !is_function_key(key) {
        return Some(if shift { ShortcutProblem::ShiftOnly } else { ShortcutProblem::MissingModifier });
    }
    if is_reserved_by_windows(mods, key) {
        return Some(ShortcutProblem::Reserved);
    }
    if ctrl && alt && !win && is_character_key(key) {
        return Some(ShortcutProblem::AltGr);
    }
    if alt && !ctrl && !shift && !win && is_numpad_digit(key) {
        return Some(ShortcutProblem::AltCode);
    }
    if ctrl && !alt && !win && is_common_ctrl_key(key) {
        return Some(ShortcutProblem::Common);
    }
    None
}

/// Keys that, with Ctrl (and Maiusc or not), every app uses: taking them globally would steal them everywhere.
/// COMMON_CTRL_KEYS in src/shortcuts.js is the same list.
fn is_common_ctrl_key(key: Code) -> bool {
    use Code::*;
    matches!(
        key,
        KeyA | KeyC | KeyV | KeyX | KeyZ | KeyY | Insert | KeyS | KeyF | KeyP | KeyW | KeyT | KeyN | KeyO | Tab
            | Backspace | Delete | Home | End
    )
}

// ---------------------------------------------------------------------------
// settings.json (%APPDATA%\it.stagliano.rocketlauncher): the global shortcut ("shortcut") and the keys of the in-app
// actions that differ from the defaults ("keyBindings"). Other values in the file are kept as they are.
// ---------------------------------------------------------------------------

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

/// The settings object held by the text of settings.json; missing, unreadable or not an object: empty.
fn settings_from_text(content: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    content
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn read_settings(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    settings_from_text(std::fs::read_to_string(get_config_path(app)).ok().as_deref())
}

/// Sets one value in settings.json and keeps the others. False when the file could not be written.
fn write_setting(app: &AppHandle, key: &str, value: serde_json::Value) -> bool {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = get_config_path(app);
    let mut settings = settings_from_text(std::fs::read_to_string(&path).ok().as_deref());
    settings.insert(key.to_string(), value);
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(settings)).unwrap_or_default();
    std::fs::write(&path, text).is_ok()
}

fn load_shortcut(app: &AppHandle) -> String {
    read_settings(app)
        .get("shortcut")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
}

fn save_shortcut(app: &AppHandle, shortcut: &str) {
    write_setting(app, "shortcut", serde_json::json!(shortcut));
}

/// Keys of the in-app actions as src/main.js saves them: only the ones changed from the defaults, action id to
/// binding ("settings": "F2"). src/shortcuts.js checks every value when it reads them back (resolveBindings); here
/// only the shape is enforced, so a broken caller cannot fill the file.
const MAX_KEY_BINDINGS: usize = 32;

fn valid_key_bindings(bindings: &BTreeMap<String, String>) -> bool {
    bindings.len() <= MAX_KEY_BINDINGS
        && bindings.iter().all(|(action, keys)| {
            (1..=32).contains(&action.len())
                && action.chars().all(|c| c.is_ascii_alphanumeric())
                && (1..=64).contains(&keys.len())
                && keys.chars().all(|c| c.is_ascii_graphic())
        })
}

/// Icons already extracted, by path: every keystroke lists up to 50 apps again, and extracting and re-encoding
/// their icons each time cost more than the search itself. Emptied when the index is rebuilt.
static ICON_CACHE: Lazy<Mutex<std::collections::HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

fn get_file_icon_base64(path: &str) -> Option<String> {
    if let Some(cached) = ICON_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(path) {
        return cached.clone();
    }
    let icon = extract_file_icon_base64(path);
    ICON_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(path.to_string(), icon.clone());
    icon
}

fn extract_file_icon_base64(path: &str) -> Option<String> {
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
    show_main_window_with(app, false);
}

#[cfg(windows)]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const std::ffi::c_void, size: u32) -> i32;
}

/// DWMWA_CLOAK: the window stays shown for Windows and WebView2, which keeps painting, but DWM does not draw it.
fn set_cloaked(window: &tauri::WebviewWindow, cloaked: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        const DWMWA_CLOAK: u32 = 13;
        let value: i32 = cloaked.into();
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as isize,
                DWMWA_CLOAK,
                &value as *const i32 as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = (window, cloaked);
}

/// Shows the window centred near the top, cloaked: DWM would draw the Mica glass at once while the page still has to
/// paint, so the glass flashed empty (or with the last search) before the bar appeared. src/main.js clears the search
/// on "reset_state" (and opens the settings for the tray item "Impostazioni"), waits for that frame and calls
/// reveal_window; if the page does not answer in time the window is revealed anyway.
fn show_main_window_with(app: &AppHandle, open_settings: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let show_recents = *SHOW_RECENTS.lock().unwrap();
        let generation = REVEAL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        REVEAL_PENDING.store(true, Ordering::SeqCst);
        set_cloaked(&window, true);

        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: WINDOW_WIDTH,
            height: if show_recents { EXPANDED_HEIGHT } else { COLLAPSED_HEIGHT },
        }));

        let _ = window.center();
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: window.outer_position().unwrap().x,
            y: 100,
        }));
        let _ = window.unminimize();
        let _ = window.show();
        // Taken now, while this process may still bring a window to the foreground (the shortcut or the tray click).
        let _ = window.set_focus();
        let _ = window.emit("reset_state", serde_json::json!({ "openSettings": open_settings }));

        let wait = if PAGE_READY.load(Ordering::SeqCst) { REVEAL_FALLBACK } else { REVEAL_FALLBACK_LOADING };
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            if REVEAL_GENERATION.load(Ordering::SeqCst) == generation {
                reveal_main_window(&app);
            }
        });
    }
}

/// Uncloaks the window shown by show_main_window_with, once, and gives it the focus.
fn reveal_main_window(app: &AppHandle) {
    if !REVEAL_PENDING.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        set_cloaked(&window, false);
        let _ = window.set_focus();
        *SHOWN_AT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
        REFOCUS_ON_BLUR.store(true, Ordering::SeqCst);
    }
}

/// Called by src/main.js once it has painted the clean bar after "reset_state" (and once at start-up).
#[tauri::command]
fn reveal_window(app: AppHandle) {
    PAGE_READY.store(true, Ordering::SeqCst);
    reveal_main_window(&app);
}

/// Hides the window; src/main.js clears the search on "window_hidden", so the page is already clean for the next show.
fn hide_main_window(window: &tauri::WebviewWindow) {
    REVEAL_PENDING.store(false, Ordering::SeqCst);
    REFOCUS_ON_BLUR.store(false, Ordering::SeqCst);
    let _ = tauri::WebviewWindow::hide(window);
    // A hidden window is not drawn anyway; never leave it cloaked for a show that does not go through here.
    set_cloaked(window, false);
    let _ = window.emit("window_hidden", ());
}

/// Hides the window from the page (Esc on an empty search, and the other actions that close the bar).
#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        hide_main_window(&window);
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            hide_main_window(&window);
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

/// Registers a new global shortcut and saves it. The answer is "updated", a ShortcutProblem code (nothing was tried)
/// or "in_use" (Windows refused it: another app has it); on any refusal the previous shortcut stays registered.
#[tauri::command]
fn update_shortcut(app: AppHandle, new_shortcut: String) -> &'static str {
    if let Some(problem) = shortcut_problem(&new_shortcut) {
        return problem.as_str();
    }
    let mut current = CURRENT_SHORTCUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = app.global_shortcut().unregister(current.as_str());

    let outcome = match app.global_shortcut().register(new_shortcut.as_str()) {
        Ok(_) => {
            println!("Shortcut updated to: {}", new_shortcut);
            *current = new_shortcut.clone();
            save_shortcut(&app, &new_shortcut);
            *PREFERRED_SHORTCUT_BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            "updated"
        }
        Err(e) => {
            eprintln!("Failed to register {}: {:?}", new_shortcut, e);
            let _ = app.global_shortcut().register(current.as_str());
            "in_use"
        }
    };
    // Either way the shortcut in use is registered again, also after a recording suspended it.
    SHORTCUT_PAUSED.store(false, Ordering::SeqCst);
    outcome
}

/// For each combination, whether RocketLauncher could use it: not refused by shortcut_problem() and free, found by
/// registering it for a moment. The shortcut in use counts as available.
#[tauri::command]
fn check_shortcuts_availability(app: AppHandle, shortcuts: Vec<String>) -> Vec<bool> {
    let current = CURRENT_SHORTCUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let paused = SHORTCUT_PAUSED.load(Ordering::SeqCst);
    if !paused {
        let _ = app.global_shortcut().unregister(current.as_str());
    }

    let mut results = Vec::new();
    for sc in shortcuts {
        if sc == current {
            results.push(true);
        } else if shortcut_problem(&sc).is_some() {
            results.push(false);
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

    if !paused {
        let _ = app.global_shortcut().register(current.as_str());
    }
    results
}

/// Suspends the global shortcut while the settings record a combination (active = true) and registers it again
/// afterwards, so that pressing it is recorded instead of hiding the window.
#[tauri::command]
fn set_shortcut_recording(app: AppHandle, active: bool) {
    let current = CURRENT_SHORTCUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if active {
        if !SHORTCUT_PAUSED.swap(true, Ordering::SeqCst) {
            let _ = app.global_shortcut().unregister(current.as_str());
        }
    } else if SHORTCUT_PAUSED.swap(false, Ordering::SeqCst) {
        let _ = app.global_shortcut().register(current.as_str());
    }
}

/// Registers the global shortcut again if a recording suspended it: called when the window hides, so the shortcut
/// can never stay off.
fn resume_global_shortcut(app: &AppHandle) {
    if SHORTCUT_PAUSED.swap(false, Ordering::SeqCst) {
        let current = CURRENT_SHORTCUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let _ = app.global_shortcut().register(current.as_str());
    }
}

/// The global shortcut in use, whether this app has it registered right now, whether a recording suspended it and,
/// when a preset stands in for it this session, the saved shortcut another app was holding at start-up ("preferred").
#[tauri::command]
fn shortcut_status(app: AppHandle) -> serde_json::Value {
    let current = CURRENT_SHORTCUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let preferred = PREFERRED_SHORTCUT_BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    serde_json::json!({
        "shortcut": current,
        "registered": app.global_shortcut().is_registered(current.as_str()),
        "paused": SHORTCUT_PAUSED.load(Ordering::SeqCst),
        "preferred": preferred
    })
}

/// The changed keys of the in-app actions from settings.json (an empty object when none).
#[tauri::command]
fn get_key_bindings(app: AppHandle) -> serde_json::Value {
    read_settings(&app)
        .get("keyBindings")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Saves the changed keys of the in-app actions (an empty map restores the defaults). False when refused or not written.
#[tauri::command]
fn save_key_bindings(app: AppHandle, bindings: BTreeMap<String, String>) -> bool {
    valid_key_bindings(&bindings) && write_setting(&app, "keyBindings", serde_json::json!(bindings))
}

// ---------------------------------------------------------------------------
// Keyboard layout: the character each punctuation key shows on the user's layout, so the interface writes "Win + ù"
// on an Italian keyboard where a US one has "/".
// ---------------------------------------------------------------------------

/// Accelerator names of the punctuation keys and the virtual key tauri-plugin-global-shortcut registers for each.
const LAYOUT_TOKEN_KEYS: &[(&str, u32)] = &[
    ("`", 0xC0),
    ("-", 0xBD),
    ("=", 0xBB),
    ("[", 0xDB),
    ("]", 0xDD),
    ("\\", 0xDC),
    (";", 0xBA),
    ("'", 0xDE),
    (",", 0xBC),
    (".", 0xBE),
    ("/", 0xBF),
];

/// KeyboardEvent.code of the keys that write a character and their scan code (set 1): the in-app keys are matched
/// by physical key, whose character depends on the layout.
const LAYOUT_CODE_SCANCODES: &[(&str, u32)] = &[
    ("Backquote", 0x29), ("Digit1", 0x02), ("Digit2", 0x03), ("Digit3", 0x04), ("Digit4", 0x05), ("Digit5", 0x06),
    ("Digit6", 0x07), ("Digit7", 0x08), ("Digit8", 0x09), ("Digit9", 0x0A), ("Digit0", 0x0B), ("Minus", 0x0C),
    ("Equal", 0x0D), ("KeyQ", 0x10), ("KeyW", 0x11), ("KeyE", 0x12), ("KeyR", 0x13), ("KeyT", 0x14), ("KeyY", 0x15),
    ("KeyU", 0x16), ("KeyI", 0x17), ("KeyO", 0x18), ("KeyP", 0x19), ("BracketLeft", 0x1A), ("BracketRight", 0x1B),
    ("KeyA", 0x1E), ("KeyS", 0x1F), ("KeyD", 0x20), ("KeyF", 0x21), ("KeyG", 0x22), ("KeyH", 0x23), ("KeyJ", 0x24),
    ("KeyK", 0x25), ("KeyL", 0x26), ("Semicolon", 0x27), ("Quote", 0x28), ("Backslash", 0x2B), ("KeyZ", 0x2C),
    ("KeyX", 0x2D), ("KeyC", 0x2E), ("KeyV", 0x2F), ("KeyB", 0x30), ("KeyN", 0x31), ("KeyM", 0x32), ("Comma", 0x33),
    ("Period", 0x34), ("Slash", 0x35), ("IntlBackslash", 0x56),
];

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetKeyboardLayout(thread_id: u32) -> isize;
    fn MapVirtualKeyExW(code: u32, map_type: u32, layout: isize) -> u32;
}

#[cfg(windows)]
const MAPVK_VSC_TO_VK_EX: u32 = 3;
#[cfg(windows)]
const MAPVK_VK_TO_CHAR: u32 = 2;

/// The unshifted character of a virtual key on a layout. Letters and digits are named by the key itself.
#[cfg(windows)]
fn layout_key_label(vk: u32, layout: isize) -> Option<String> {
    match vk {
        0 => None,
        0x30..=0x39 | 0x41..=0x5A => char::from_u32(vk).map(String::from),
        _ => {
            // The high bit marks a dead key; the low word is its character either way.
            let value = unsafe { MapVirtualKeyExW(vk, MAPVK_VK_TO_CHAR, layout) } & 0xFFFF;
            char::from_u32(value).filter(|c| !c.is_control()).map(String::from)
        }
    }
}

/// "tokens": accelerator name -> character, for the global shortcut; "codes": KeyboardEvent.code -> character, for
/// the in-app keys. Both for the keyboard layout of the window's thread (the command runs on the main thread).
#[tauri::command]
fn keyboard_layout_labels() -> serde_json::Value {
    let mut tokens = serde_json::Map::new();
    let mut codes = serde_json::Map::new();
    #[cfg(windows)]
    {
        let layout = unsafe { GetKeyboardLayout(0) };
        for (token, vk) in LAYOUT_TOKEN_KEYS {
            if let Some(label) = layout_key_label(*vk, layout) {
                tokens.insert(token.to_string(), label.into());
            }
        }
        for (code, scancode) in LAYOUT_CODE_SCANCODES {
            let vk = unsafe { MapVirtualKeyExW(*scancode, MAPVK_VSC_TO_VK_EX, layout) };
            if let Some(label) = layout_key_label(vk, layout) {
                codes.insert(code.to_string(), label.into());
            }
        }
    }
    serde_json::json!({ "tokens": tokens, "codes": codes })
}

// ---------------------------------------------------------------------------
// Tray and start-up
// ---------------------------------------------------------------------------

/// Items of the tray menu (area di notifica), in order: id and label. "Impostazioni" shows the window with the
/// settings open, the way back when another program swallows the global shortcut.
const TRAY_MENU: [(&str, &str); 3] = [
    ("show", "Mostra RocketLauncher"),
    ("settings", "Impostazioni"),
    ("quit", "Esci"),
];

/// Argument of the sign-in start that tauri-plugin-autostart writes in the HKCU Run value. Started with it,
/// RocketLauncher stays in the notification area (indexing in the background) until the shortcut or the tray.
const AUTOSTART_ARG: &str = "--autostart";

fn started_by_autostart<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    args.into_iter().any(|arg| arg.as_ref() == AUTOSTART_ARG)
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
    rocket_command("rocket:media_play", "Multimediale: Riproduci/pausa", &["Media: Play/Pause", "media", "play", "pause", "riproduci", "pausa"], 189, true),
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
    (entry("nox:brightness_down", "Nox: Riduci oscuramento (\u{2212}10%)", &["Nox: Decrease Dimness (-10%)", "decrease", "riduci", "più chiaro"]), 197),
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
    // Running a command and searching the web are asked for by the first word of the query (private-mode
    // chips aside), as the interface reads it. Later on, such a word is a file extension, as upstream
    // treated every unknown word: `/c /cmd build` lists the build*.cmd scripts on C:.
    let mut past_first_word = false;

    for part in query_trim.split_whitespace() {
        if (part.starts_with('@') || part.starts_with('/')) && part.len() > 1 {
            let mut filter = classify_filter(&part[1..]);
            if filter == FilterToken::FrontendOnly && past_first_word {
                filter = FilterToken::Extension(fold_for_search(&part[1..]));
            }
            past_first_word |= filter != FilterToken::Private;
            filters.push(filter);
        } else {
            past_first_word = true;
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
        // The default browser through ShellExecute, never through `cmd /C start`: cmd would split an address
        // at `&` (`watch?v=x&t=10`) and run the rest as a command.
        if tauri_plugin_opener::open_url(&path, None::<&str>).is_ok() {
            success = true;
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
            hide_main_window(&window);
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
        hide_main_window(&window);
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

        // No known browser: the default one, in a normal window (ShellExecute, as open_file does).
        if !success && tauri_plugin_opener::open_url(&url, None::<&str>).is_ok() {
            success = true;
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
            hide_main_window(&window);
        }
    }
}

#[tauri::command]
fn reset_window(window: tauri::Window) {
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: WINDOW_WIDTH,
        height: COLLAPSED_HEIGHT,
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
        width: WINDOW_WIDTH,
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
        hide_main_window(&window);
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
        hide_main_window(&window);
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
        hide_main_window(&window);
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
    // A reinstalled or updated app may have a new icon: extract it again on the next search.
    ICON_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
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

/// Release check run by scripts/smoke-windows.ps1 as `RocketLauncher.exe --smoke=<version>`.
/// Exit codes: 0 everything matches, 10 getVersion() differs, 11 a frontend asset is missing, 12 wrong product name.
fn smoke_exit_code<R: tauri::Runtime>(context: &tauri::Context<R>, expected_version: &str) -> i32 {
    if context.package_info().version.to_string() != expected_version {
        return 10;
    }
    let assets = context.assets();
    if ["index.html", "main.js", "update-source.js", "icons.js", "shortcuts.js", "styles.css"]
        .iter()
        .any(|name| assets.get(&tauri::utils::assets::AssetKey::from(*name)).is_none())
    {
        return 11;
    }
    if context.config().product_name.as_deref() != Some("RocketLauncher") {
        return 12;
    }
    0
}

fn main() {
    let context = tauri::generate_context!();

    // Release smoke test: compare the version getVersion() returns and the embedded assets, then exit before any
    // plugin, window, tray, global shortcut, single-instance lock, autostart or indexing starts (no side effects).
    if let Some(expected) = std::env::args_os()
        .skip(1)
        .find_map(|arg| arg.to_str()?.strip_prefix("--smoke=").map(str::to_owned))
    {
        std::process::exit(smoke_exit_code(&context, &expected));
    }

    // start_periodic_indexing();

    tauri::Builder::default()
        // Starting RocketLauncher again shows the running one; a second sign-in start leaves it where it is.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !started_by_autostart(&argv) {
                show_main_window(app);
            }
        }))
        // A single registration with an explicit name: the HKCU Run value is called
        // "RocketLauncher" whatever package_info().name resolves to. It starts the exe with --autostart, so the
        // sign-in start stays in the notification area.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("RocketLauncher")
                .arg(AUTOSTART_ARG)
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
            show_in_explorer,
            window_material,
            set_shortcut_recording,
            shortcut_status,
            get_key_bindings,
            save_key_bindings,
            keyboard_layout_labels,
            reveal_window,
            hide_window
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

            // The window is still hidden here: the material is in place before the first show.
            apply_window_material(&window);

            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Focused(false) => {
                    // A recording in the settings never leaves the global shortcut suspended once the bar is gone.
                    resume_global_shortcut(w_clone.app_handle());
                    // Still cloaked, waiting for the page: reveal_main_window gives the focus back.
                    if REVEAL_PENDING.load(Ordering::SeqCst) {
                        return;
                    }
                    let just_shown = SHOWN_AT
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .is_some_and(|shown| shown.elapsed() < SHOW_FOCUS_GRACE);
                    if REFOCUS_ON_BLUR.swap(false, Ordering::SeqCst) && just_shown {
                        let _ = w_clone.set_focus();
                        let w_check = w_clone.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            if !w_check.is_focused().unwrap_or(false) {
                                hide_main_window(&w_check);
                            }
                        });
                    } else {
                        hide_main_window(&w_clone);
                    }
                }
                // Acrylic keeps the tint it was applied with: give it the one of the new theme.
                tauri::WindowEvent::ThemeChanged(_) if chosen_material() == WindowMaterial::Acrylic => {
                    apply_window_material(&w_clone);
                }
                _ => {}
            });

            let menu_owner = app.handle();
            let tray_items = TRAY_MENU
                .iter()
                .map(|(id, label)| MenuItem::with_id(menu_owner, *id, *label, true, None::<&str>))
                .collect::<Result<Vec<_>, _>>()?;
            let tray_item_refs: Vec<&dyn IsMenuItem<_>> =
                tray_items.iter().map(|item| item as &dyn IsMenuItem<_>).collect();
            let menu = Menu::with_items(app, &tray_item_refs)?;

            // Tray icon: the same master as the app icon, branding/rocketlauncher-icon.svg, rendered at 32 px by
            // `npm run icons`.
            let icon_bytes = include_bytes!("../icons/tray/32x32.png");
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
                    "settings" => {
                        show_main_window_with(app, true);
                    }
                    _ => {
                        println!("menu item {:?} not handled", event.id);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Tauri reports a click twice, on press and on release: acting on both showed the bar and hid it
                    // again at once (a Velocmd bug). Only the release counts.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        toggle_main_window(app);
                    }
                })
                .build(app)?;

            let loaded_shortcut = load_shortcut(app.handle());
            let mut current = CURRENT_SHORTCUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

            if shortcut_problem(&loaded_shortcut).is_none()
                && app.global_shortcut().register(loaded_shortcut.as_str()).is_ok()
            {
                *current = loaded_shortcut.clone();
            } else {
                eprintln!("Failed to register loaded shortcut, trying fallbacks...");
                // A saved shortcut that is no longer valid is replaced for good; one that another app holds right now
                // (often only while Windows is signing in) stays saved and is tried again at the next start.
                let saved_is_valid = shortcut_problem(&loaded_shortcut).is_none();
                let mut found = false;
                for sc in PRESET_SHORTCUTS {
                    if shortcut_problem(sc).is_none() && app.global_shortcut().register(*sc).is_ok() {
                        *current = sc.to_string();
                        if saved_is_valid {
                            *PREFERRED_SHORTCUT_BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                                Some(loaded_shortcut.clone());
                        } else {
                            save_shortcut(app.handle(), sc);
                        }
                        println!("Fallback shortcut registered: {}", sc);
                        found = true;
                        break;
                    }
                }
                if !found {
                    eprintln!("Failed to register any fallback shortcuts");
                }
            }
            drop(current);

            // Started at sign-in by "Avvia con Windows": stay in the notification area and index in the background;
            // the shortcut or the tray shows the bar. Any other start shows it, as before.
            if started_by_autostart(std::env::args_os()) {
                println!("Started at sign-in: RocketLauncher stays in the notification area.");
            } else {
                show_main_window(app.handle());
            }

            Ok(())
        })
        .run(context)
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
    fn picks_the_window_material_from_the_windows_build() {
        assert_eq!(material_for(26200, None), WindowMaterial::Mica);
        assert_eq!(material_for(22000, None), WindowMaterial::Mica);
        assert_eq!(material_for(19045, None), WindowMaterial::Acrylic);
        assert_eq!(material_for(17763, None), WindowMaterial::Acrylic);
        assert_eq!(material_for(17134, None), WindowMaterial::Plain);
    }

    #[test]
    fn lets_rocketlauncher_material_override_the_choice() {
        assert_eq!(material_for(26200, Some("none")), WindowMaterial::Plain);
        assert_eq!(material_for(26200, Some("acrylic")), WindowMaterial::Acrylic);
        assert_eq!(material_for(19045, Some(" Mica ")), WindowMaterial::Mica);
        assert_eq!(material_for(26200, Some("vetro")), WindowMaterial::Mica, "unknown values keep the default");
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
    fn a_run_or_search_word_after_the_first_word_is_a_file_extension() {
        let index = index_with(&[
            ("C:\\Tools\\build.cmd", "build.cmd", ItemKind::File),
            ("C:\\Tools\\build.ps1", "build.ps1", ItemKind::File),
            ("D:\\Tools\\build.cmd", "build.cmd", ItemKind::File),
        ]);
        assert_eq!(paths(&search_index(&index, "/c /cmd build")), vec!["C:\\Tools\\build.cmd"]);
        assert_eq!(paths(&search_index(&index, "build /cmd")).len(), 2);
        // As the first word (private-mode chips aside) it is still the interface's run or search row.
        assert!(search_index(&index, "/cmd build").is_empty());
        assert!(search_index(&index, "/esegui /c build").is_empty());
        assert_eq!(search_index(&index, "/privato /google").len(), WEB_PRESETS.len());
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

    fn problem(accelerator: &str) -> Option<&'static str> {
        shortcut_problem(accelerator).map(ShortcutProblem::as_str)
    }

    #[test]
    fn the_default_and_the_usable_velocmd_presets_pass_validation() {
        assert_eq!(PRESET_SHORTCUTS[0], DEFAULT_SHORTCUT);
        for preset in ["Super+Shift+.", "Alt+Space", "Ctrl+Space", "Ctrl+Shift+Space", "Alt+S", "Super+/"] {
            assert!(PRESET_SHORTCUTS.contains(&preset), "{preset} is a preset");
            assert_eq!(problem(preset), None, "{preset}");
        }
        // Windows search and the input language switch: listed as quick picks, locked as reserved.
        assert_eq!(problem("Super+S"), Some("reserved"));
        assert_eq!(problem("Super+Space"), Some("reserved"));
    }

    #[test]
    fn recorded_combinations_in_the_accelerator_syntax_are_accepted() {
        for accelerator in ["Ctrl+Shift+K", "Super+Ctrl+Alt+Shift+F12", "Ctrl+Alt+F5", "Alt+Shift+1", "F9", "Shift+F5",
            "Super+Shift+K", "Ctrl+Alt+Space", "Ctrl+Numpad5", "Super+`", "Ctrl+Shift+'", "Alt+MediaPlayPause"]
        {
            assert_eq!(problem(accelerator), None, "{accelerator}");
        }
    }

    #[test]
    fn a_global_shortcut_needs_ctrl_alt_or_win_unless_it_is_a_function_key() {
        assert_eq!(problem("A"), Some("missing_modifier"));
        assert_eq!(problem("Space"), Some("missing_modifier"));
        assert_eq!(problem("Escape"), Some("missing_modifier"));
        assert_eq!(problem("Shift+A"), Some("shift_only"));
        assert_eq!(problem("Shift+."), Some("shift_only"));
        assert_eq!(problem("F1"), None);
        assert_eq!(problem("F24"), None);
    }

    #[test]
    fn windows_reserved_and_dangerous_combinations_are_refused() {
        for accelerator in [
            "Super+L", "Super+Shift+L", "Ctrl+Alt+Delete", "Alt+Tab", "Alt+Shift+Tab", "Alt+F4", "Ctrl+Escape",
            "Ctrl+Shift+Escape", "Alt+Escape", "Super+D", "Super+E", "Super+R", "Super+I", "Super+S", "Super+X",
            "Super+Tab", "Super+1", "Super+0", "Super+.", "Super+;", "Super+Up", "Super+Shift+S", "Super+Shift+Left",
            "Super+Ctrl+D", "Super+Ctrl+Left", "Super+Alt+R", "Super+Ctrl+Shift+B", "Ctrl+Alt+Tab", "Shift+F10",
            "Alt+PrintScreen", "Super+PrintScreen",
        ] {
            assert_eq!(problem(accelerator), Some("reserved"), "{accelerator}");
        }
    }

    #[test]
    fn altgr_characters_and_editing_combinations_are_refused() {
        // AltGr is Ctrl+Alt on Windows: AltGr+ò (VK_OEM_3) types @, AltGr+à # , AltGr+è [, AltGr+E €.
        for accelerator in ["Ctrl+Alt+`", "Ctrl+Alt+'", "Ctrl+Alt+;", "Ctrl+Alt+E", "Ctrl+Alt+Shift+;", "Ctrl+Alt+1"] {
            assert_eq!(problem(accelerator), Some("altgr"), "{accelerator}");
        }
        assert_eq!(problem("Super+Ctrl+Alt+E"), None, "with Win it is not AltGr any more");
        for accelerator in [
            "Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+Insert", "Ctrl+S", "Ctrl+F", "Ctrl+P",
            "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+O", "Ctrl+Tab", "Ctrl+Backspace", "Ctrl+Delete", "Ctrl+Home", "Ctrl+End",
            "Ctrl+Shift+C", "Ctrl+Shift+V", "Ctrl+Shift+S", "Ctrl+Shift+P", "Ctrl+Shift+T", "Ctrl+Shift+Tab",
        ] {
            assert_eq!(problem(accelerator), Some("common"), "{accelerator}");
        }
        for accelerator in ["Ctrl+Shift+K", "Ctrl+Space", "Ctrl+Shift+Space", "Ctrl+Alt+F5", "Super+Ctrl+S"] {
            assert_eq!(problem(accelerator), None, "{accelerator}");
        }
        // Alt + keypad digits type characters by code in every app (Alt+64 is @): the hotkey would swallow the digit.
        for accelerator in ["Alt+Numpad0", "Alt+Numpad6", "Alt+Num4", "Alt+Numpad9"] {
            assert_eq!(problem(accelerator), Some("alt_code"), "{accelerator}");
        }
        for accelerator in ["Alt+Shift+Numpad6", "Ctrl+Numpad6", "Super+Alt+Numpad6", "Alt+NumpadAdd", "Alt+6"] {
            assert_eq!(problem(accelerator), None, "{accelerator}");
        }
    }

    #[test]
    fn unparsable_accelerators_are_invalid() {
        for accelerator in ["", "Ctrl+", "Ctrl+Shift", "Ctrl+K+Alt", "Win+K", "Ctrl+IntlBackslash", "Ctrl+Foo"] {
            assert_eq!(problem(accelerator), Some("invalid"), "{accelerator:?}");
        }
    }

    #[test]
    fn the_tray_menu_has_settings_between_show_and_quit() {
        assert_eq!(
            TRAY_MENU,
            [("show", "Mostra RocketLauncher"), ("settings", "Impostazioni"), ("quit", "Esci")]
        );
    }

    #[test]
    fn only_the_sign_in_start_is_silent() {
        assert!(started_by_autostart(["C:\\Programmi\\RocketLauncher.exe", "--autostart"]));
        assert!(started_by_autostart(vec!["RocketLauncher.exe".to_string(), AUTOSTART_ARG.to_string()]));
        assert!(!started_by_autostart(["C:\\Programmi\\RocketLauncher.exe"]));
        assert!(!started_by_autostart(["RocketLauncher.exe", "--autostartx", "autostart"]));
        assert!(!started_by_autostart(Vec::<String>::new()));
    }

    #[test]
    fn settings_json_keeps_the_values_it_does_not_change() {
        let settings = settings_from_text(Some(r#"{ "shortcut": "Alt+S", "other": 1 }"#));
        assert_eq!(settings.get("shortcut").and_then(|v| v.as_str()), Some("Alt+S"));
        assert_eq!(settings.get("other").and_then(|v| v.as_i64()), Some(1));
        assert!(settings_from_text(Some("[1, 2]")).is_empty());
        assert!(settings_from_text(Some("not json")).is_empty());
        assert!(settings_from_text(None).is_empty());
    }

    #[test]
    fn saved_key_bindings_must_look_like_action_ids_and_keys() {
        let ok = BTreeMap::from([("settings".to_string(), "F2".to_string()), ("reveal".to_string(), "Ctrl+Shift+Enter".to_string())]);
        assert!(valid_key_bindings(&ok));
        assert!(valid_key_bindings(&BTreeMap::new()));
        assert!(!valid_key_bindings(&BTreeMap::from([("set tings".to_string(), "F2".to_string())])));
        assert!(!valid_key_bindings(&BTreeMap::from([("settings".to_string(), String::new())])));
        assert!(!valid_key_bindings(&BTreeMap::from([("settings".to_string(), "Ctrl + A".to_string())])));
        let too_many: BTreeMap<String, String> = (0..=MAX_KEY_BINDINGS).map(|i| (format!("a{i}"), "F2".to_string())).collect();
        assert!(!valid_key_bindings(&too_many));
    }

    #[test]
    fn layout_tables_name_each_key_once() {
        let tokens: HashSet<&str> = LAYOUT_TOKEN_KEYS.iter().map(|(token, _)| *token).collect();
        let vks: HashSet<u32> = LAYOUT_TOKEN_KEYS.iter().map(|(_, vk)| *vk).collect();
        assert_eq!(tokens.len(), LAYOUT_TOKEN_KEYS.len());
        assert_eq!(vks.len(), LAYOUT_TOKEN_KEYS.len());
        // Every punctuation name is one the global shortcut plugin parses (the key is VK-based: "/" is VK_OEM_2).
        for (token, _) in LAYOUT_TOKEN_KEYS {
            assert!(Shortcut::from_str(&format!("Ctrl+{token}")).is_ok(), "{token}");
        }
        let codes: HashSet<&str> = LAYOUT_CODE_SCANCODES.iter().map(|(code, _)| *code).collect();
        let scancodes: HashSet<u32> = LAYOUT_CODE_SCANCODES.iter().map(|(_, sc)| *sc).collect();
        assert_eq!(codes.len(), LAYOUT_CODE_SCANCODES.len());
        assert_eq!(scancodes.len(), LAYOUT_CODE_SCANCODES.len());
        assert_eq!(LAYOUT_CODE_SCANCODES.len(), 26 + 10 + 12);
    }
}
