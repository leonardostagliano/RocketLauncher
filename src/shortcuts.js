// Keyboard shortcuts of RocketLauncher: the global combination that shows the launcher from any app (registered by
// src-tauri/src/main.rs through tauri-plugin-global-shortcut) and the keys of the actions inside the app.
// Pure functions only, no DOM and no Tauri: tests/shortcuts.test.mjs exercises them directly. The key names and the
// messages about shortcuts that the user reads are defined here; the rest of the interface text is in main.js.
//
// Two notations, because the two kinds of keys are matched differently:
// - Global shortcut ("accelerator"), e.g. "Super+Shift+.": the syntax of tauri-plugin-global-shortcut. Windows
//   registers it by virtual key (RegisterHotKey), and the plugin maps each key name to the virtual key a US keyboard
//   gives it ("/" is VK_OEM_2). A recorded key is therefore named after the virtual key it produces on the user's
//   layout (KeyboardEvent.keyCode, which WebView2 fills with the Windows virtual key), so the registered hotkey is the
//   physical key that was pressed: on an Italian keyboard the "ù" key is VK_OEM_2, stored as "/", shown as "ù".
// - Keys inside the app ("binding"), e.g. "Ctrl+KeyA": KeyboardEvent.code, the physical key, matched in the page.
//
// Modifiers are stored and shown in the order Windows writes them: Win + Ctrl + Alt + Maiusc + key.

export const MODIFIERS = ["Super", "Ctrl", "Alt", "Shift"];

const MODIFIER_LABELS = { Super: "Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "Maiusc" };

// Names tauri-plugin-global-shortcut (global-hotkey) accepts for the modifiers, plus Win and Meta.
const MODIFIER_ALIASES = {
  super: "Super", win: "Super", meta: "Super", cmd: "Super", command: "Super",
  ctrl: "Ctrl", control: "Ctrl", commandorcontrol: "Ctrl", commandorctrl: "Ctrl", cmdorctrl: "Ctrl", cmdorcontrol: "Ctrl",
  alt: "Alt", option: "Alt",
  shift: "Shift"
};

// Keys that are not characters, with their Italian names (Windows, Italian edition). The key of a global shortcut and
// the KeyboardEvent.code of an in-app key share these names.
const NAMED_KEY_LABELS = {
  Space: "Spazio",
  Enter: "Invio",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Canc",
  Insert: "Ins",
  Home: "Home",
  End: "Fine",
  PageUp: "Pag↑",
  PageDown: "Pag↓",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PrintScreen: "Stamp",
  Pause: "Pausa",
  ScrollLock: "Bloc Scorr",
  CapsLock: "Bloc Maiusc",
  NumLock: "Bloc Num",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
  AudioVolumeMute: "Disattiva audio",
  AudioVolumeDown: "Volume −",
  AudioVolumeUp: "Volume +",
  MediaPlayPause: "Riproduci/pausa",
  MediaTrackNext: "Brano successivo",
  MediaTrackPrevious: "Brano precedente",
  MediaStop: "Interrompi"
};

// The action bar is narrow: there Enter is the same symbol as on the selected row.
const COMPACT_KEY_LABELS = { Enter: "↵" };

// Punctuation keys: the name in an accelerator (the US character) and the KeyboardEvent.code of the same US key.
const PUNCTUATION_CODES = {
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash"
};
const PUNCTUATION_BY_CODE = Object.fromEntries(Object.entries(PUNCTUATION_CODES).map(([token, code]) => [code, token]));

// Windows virtual keys of the non-character keys and of the punctuation keys (VK_OEM_*), as global-hotkey maps them.
const VIRTUAL_KEY_TOKENS = new Map([
  [0x08, "Backspace"], [0x09, "Tab"], [0x0d, "Enter"], [0x13, "Pause"], [0x14, "CapsLock"], [0x1b, "Escape"],
  [0x20, "Space"], [0x21, "PageUp"], [0x22, "PageDown"], [0x23, "End"], [0x24, "Home"], [0x25, "ArrowLeft"],
  [0x26, "ArrowUp"], [0x27, "ArrowRight"], [0x28, "ArrowDown"], [0x2c, "PrintScreen"], [0x2d, "Insert"],
  [0x2e, "Delete"], [0x6a, "NumpadMultiply"], [0x6b, "NumpadAdd"], [0x6d, "NumpadSubtract"], [0x6e, "NumpadDecimal"],
  [0x6f, "NumpadDivide"], [0x90, "NumLock"], [0x91, "ScrollLock"], [0xad, "AudioVolumeMute"],
  [0xae, "AudioVolumeDown"], [0xaf, "AudioVolumeUp"], [0xb0, "MediaTrackNext"], [0xb1, "MediaTrackPrevious"],
  [0xb2, "MediaStop"], [0xb3, "MediaPlayPause"], [0xba, ";"], [0xbb, "="], [0xbc, ","], [0xbd, "-"], [0xbe, "."],
  [0xbf, "/"], [0xc0, "`"], [0xdb, "["], [0xdc, "\\"], [0xdd, "]"], [0xde, "'"]
]);

// Shift, Ctrl, Alt and Win, left and right: pressed alone they only start a combination.
const MODIFIER_VIRTUAL_KEYS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);
const MODIFIER_KEY_NAMES = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS"]);
const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

// Aliases global-hotkey accepts for key names (compared in lower case).
const KEY_ALIASES = {
  esc: "Escape", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pausebreak: "Pause",
  numadd: "NumpadAdd", numplus: "NumpadAdd", numpadplus: "NumpadAdd", numsubtract: "NumpadSubtract",
  nummultiply: "NumpadMultiply", numdivide: "NumpadDivide", numdecimal: "NumpadDecimal", numenter: "Enter",
  numpadenter: "Enter", volumeup: "AudioVolumeUp", volumedown: "AudioVolumeDown", volumemute: "AudioVolumeMute",
  mediatrackprev: "MediaTrackPrevious"
};
const NAMED_KEYS_LOWER = Object.fromEntries(Object.keys(NAMED_KEY_LABELS).map((name) => [name.toLowerCase(), name]));

const isLetter = (key) => /^[A-Z]$/.test(key);
const isDigit = (key) => /^[0-9]$/.test(key);
const isPunctuation = (key) => Object.hasOwn(PUNCTUATION_CODES, key);
const isFunctionKey = (key) => /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
const isArrow = (key) => /^Arrow(Up|Down|Left|Right)$/.test(key);
// A key that writes a character, alone or with Maiusc or AltGr.
const isCharacterKey = (key) => isLetter(key) || isDigit(key) || isPunctuation(key);

/** The accelerator name of a key name: "a", "KeyA" -> "A"; "Digit1" -> "1"; "Period" -> "."; "esc" -> "Escape". */
function canonicalKey(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    if (isLetter(upper) || isDigit(raw) || isPunctuation(raw)) return isLetter(upper) ? upper : raw;
    return null;
  }
  const lower = raw.toLowerCase();
  let match;
  if ((match = /^key([a-z])$/.exec(lower))) return match[1].toUpperCase();
  if ((match = /^digit([0-9])$/.exec(lower))) return match[1];
  if ((match = /^f([0-9]{1,2})$/.exec(lower)) && isFunctionKey(`F${Number(match[1])}`) && !match[1].startsWith("0")) return `F${match[1]}`;
  if ((match = /^num(?:pad)?([0-9])$/.exec(lower))) return `Numpad${match[1]}`;
  const punctuation = Object.entries(PUNCTUATION_BY_CODE).find(([code]) => code.toLowerCase() === lower);
  if (punctuation) return punctuation[1];
  return KEY_ALIASES[lower] ?? NAMED_KEYS_LOWER[lower] ?? null;
}

function modifiersOf(event) {
  // AltGr is Ctrl + Alt on Windows; some browsers report it only as the AltGraph modifier.
  const altGraph = isAltGraph(event);
  return {
    Super: Boolean(event.metaKey),
    Ctrl: Boolean(event.ctrlKey) || altGraph,
    Alt: Boolean(event.altKey) || altGraph,
    Shift: Boolean(event.shiftKey)
  };
}

function joinCombo(mods, key) {
  return [...MODIFIERS.filter((mod) => mods[mod]), key].join("+");
}

/** True when the event is typed with AltGr (Ctrl + Alt on Windows), which writes @ # [ ] € on an Italian keyboard. */
export function isAltGraph(event) {
  return Boolean(event.getModifierState?.("AltGraph")) || (Boolean(event.ctrlKey) && Boolean(event.altKey));
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------

// The upstream Velocmd presets, kept as quick picks; the first one is the default. main.rs has the same list.
export const PRESET_SHORTCUTS = [
  "Super+Shift+.",
  "Alt+Space",
  "Super+Space",
  "Ctrl+Space",
  "Ctrl+Shift+Space",
  "Super+S",
  "Alt+S",
  "Super+/"
];
export const DEFAULT_SHORTCUT = PRESET_SHORTCUTS[0];

/** { Super, Ctrl, Alt, Shift, key } of an accelerator, or null when tauri-plugin-global-shortcut would refuse it. */
export function parseAccelerator(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return null;
  const mods = { Super: false, Ctrl: false, Alt: false, Shift: false };
  // Modifiers first, then exactly one key: "Ctrl+X+Alt" and "Ctrl+Shift" are refused, as the plugin does.
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (!mod) return null;
    mods[mod] = true;
  }
  const key = canonicalKey(parts[parts.length - 1]);
  return key === null ? null : { ...mods, key };
}

/** The accelerator in the one spelling main.js stores and compares ("shift+super+KeyS" -> "Super+Shift+S"). */
export function normalizeAccelerator(text) {
  const parsed = parseAccelerator(text);
  return parsed === null ? null : joinCombo(parsed, parsed.key);
}

/** The accelerator name of a Windows virtual key, or null when the plugin cannot register that key. */
function keyFromVirtualKey(vk) {
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
  if (vk >= 0x60 && vk <= 0x69) return `Numpad${vk - 0x60}`;
  return VIRTUAL_KEY_TOKENS.get(vk) ?? null;
}

/** The accelerator name of a physical key (KeyboardEvent.code) on a US layout: the fallback when keyCode is unknown. */
function keyFromCode(code) {
  if (code === "NumpadEnter") return "Enter";
  if (Object.hasOwn(PUNCTUATION_BY_CODE, code)) return PUNCTUATION_BY_CODE[code];
  if (/^Key[A-Z]$|^Digit[0-9]$|^Numpad[0-9]$/.test(code)) return canonicalKey(code);
  if (isFunctionKey(code) || Object.hasOwn(NAMED_KEY_LABELS, code)) return code;
  return null;
}

/**
 * The global shortcut a keydown event describes.
 * { accelerator } for a complete combination, { pending, mods } while only modifiers are held,
 * { error: "unsupported" } for a key the plugin cannot register (for example the "<" key of European keyboards).
 */
export function acceleratorFromKeyEvent(event) {
  const mods = modifiersOf(event);
  const vk = Number(event.keyCode) || 0;
  if (MODIFIER_VIRTUAL_KEYS.has(vk) || MODIFIER_CODES.has(event.code) || MODIFIER_KEY_NAMES.has(event.key)) {
    return { pending: true, mods };
  }
  // 229: an input method is composing; 0: no virtual key. Only then the physical key stands in for it.
  const key = vk === 0 || vk === 229 ? keyFromCode(event.code) : keyFromVirtualKey(vk);
  if (key === null) return { error: "unsupported" };
  return { accelerator: joinCombo(mods, key) };
}

// Combinations Windows keeps for itself (lock, desktop, snap, task view, emoji panel, magnifier…) or that every
// window uses (Alt+Tab, Alt+F4, Ctrl+Esc…). RegisterHotKey refuses most of them anyway; this list gives a clear
// reason and also stops the few it would accept. main.rs (is_reserved_by_windows) applies the same list.
const WIN_RESERVED = {
  "": (key) => isLetter(key) || isDigit(key) || ["Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Home", "PrintScreen", ",", ".", ";", "=", "-", "Escape", "Pause", "NumpadAdd", "NumpadSubtract"].includes(key),
  Shift: (key) => isDigit(key) || isArrow(key) || ["S", "M", "R", "Space"].includes(key),
  Ctrl: (key) => isDigit(key) || ["D", "F4", "ArrowLeft", "ArrowRight", "Enter", "Space", "C", "F", "N", "O", "Q"].includes(key),
  Alt: (key) => isDigit(key) || ["R", "G", "B", "D", "K", "PrintScreen", "Space", "ArrowUp", "ArrowDown"].includes(key),
  "Ctrl+Shift": (key) => isDigit(key) || key === "B"
};
const OTHER_RESERVED = {
  Alt: ["Tab", "Escape", "F4", "PrintScreen"],
  "Alt+Shift": ["Tab", "Escape"],
  Ctrl: ["Escape"],
  "Ctrl+Shift": ["Escape"],
  "Ctrl+Alt": ["Tab", "Delete"],
  Shift: ["F10"]
};
// Ctrl (with or without Maiusc) + these keys are used by every app: select, copy, paste, cut, undo, redo, save,
// find, print, new, open, close and new tab, switch tab, delete a word, start and end of the text. main.rs
// (is_common_ctrl_key) has the same list.
const COMMON_CTRL_KEYS = new Set(["A", "C", "V", "X", "Z", "Y", "Insert", "S", "F", "P", "W", "T", "N", "O", "Tab",
  "Backspace", "Delete", "Home", "End"]);

function isReservedByWindows({ Super: win, Ctrl: ctrl, Alt: alt, Shift: shift, key }) {
  const others = [ctrl && "Ctrl", alt && "Alt", shift && "Shift"].filter(Boolean).join("+");
  if (win) return key === "L" || Boolean(WIN_RESERVED[others]?.(key));
  return Boolean(OTHER_RESERVED[others]?.includes(key));
}

// Alt + the digits of the numeric keypad types a character by its code in every app (Alt+64 is @).
const isNumpadDigit = (key) => /^Numpad[0-9]$/.test(key);

/**
 * Why a global shortcut cannot be used, before trying to register it; null when it can.
 * "invalid", "missing_modifier" (no Ctrl, Alt or Win and not F1-F24), "shift_only" (Maiusc alone would take capitals
 * and symbols from every app), "reserved" (Windows), "altgr" (Ctrl + Alt + a character key is AltGr, which types
 * @ # [ ] €), "alt_code" (Alt + a keypad digit types characters by code), "common" (Ctrl or Ctrl + Maiusc + a key
 * every app uses, COMMON_CTRL_KEYS). main.rs refuses the same combinations (shortcut_problem).
 */
export function globalShortcutProblem(accelerator) {
  const shortcut = parseAccelerator(accelerator);
  if (shortcut === null) return "invalid";
  const { Super: win, Ctrl: ctrl, Alt: alt, Shift: shift, key } = shortcut;
  if (!win && !ctrl && !alt && !isFunctionKey(key)) return shift ? "shift_only" : "missing_modifier";
  if (isReservedByWindows(shortcut)) return "reserved";
  if (ctrl && alt && !win && isCharacterKey(key)) return "altgr";
  if (alt && !ctrl && !shift && !win && isNumpadDigit(key)) return "alt_code";
  if (ctrl && !alt && !win && COMMON_CTRL_KEYS.has(key)) return "common";
  return null;
}

function acceleratorKeyLabel(key, layoutLabels) {
  if (isPunctuation(key)) return layoutLabels?.[key] || key;
  const numpad = /^Numpad([0-9])$/.exec(key);
  if (numpad) return `Num ${numpad[1]}`;
  return NAMED_KEY_LABELS[key] ?? key;
}

/**
 * The keys of an accelerator as the user reads them: ["Win", "Maiusc", "."].
 * layoutLabels maps punctuation names to the character the user's layout gives that virtual key (main.rs,
 * keyboard_layout_labels): with an Italian layout "Super+/" reads "Win + ù".
 */
export function acceleratorKeys(accelerator, layoutLabels = {}) {
  const shortcut = parseAccelerator(accelerator);
  if (shortcut === null) return [String(accelerator ?? "")];
  return [...MODIFIERS.filter((mod) => shortcut[mod]).map((mod) => MODIFIER_LABELS[mod]),
    acceleratorKeyLabel(shortcut.key, layoutLabels)];
}

export function formatAccelerator(accelerator, layoutLabels = {}) {
  return acceleratorKeys(accelerator, layoutLabels).join(" + ");
}

// ---------------------------------------------------------------------------
// Keys inside the app
// ---------------------------------------------------------------------------

// Every action of the search bar and of the settings that has a key, in the order the settings list them. The
// arrows and Enter are fixed; Esc always cancels a recording and goes back from the keys page (index.html says so).
export const IN_APP_ACTIONS = [
  { id: "settings", label: "Apri e chiudi le impostazioni", binding: "Tab" },
  { id: "reveal", label: "Mostra in Esplora file", binding: "Ctrl+Enter" },
  { id: "clear", label: "Azzera la ricerca o nascondi", binding: "Escape" },
  { id: "removeChip", label: "Rimuovi l'ultimo filtro", hint: "Con la ricerca vuota", binding: "Backspace" },
  { id: "selectAll", label: "Seleziona testo e filtri", binding: "Ctrl+KeyA" }
];

export const DEFAULT_BINDINGS = Object.freeze(Object.fromEntries(IN_APP_ACTIONS.map(({ id, binding }) => [id, binding])));

const LETTER_CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `Key${letter}`);
const DIGIT_CODES = "0123456789".split("").map((digit) => `Digit${digit}`);
const NUMPAD_DIGIT_CODES = "0123456789".split("").map((digit) => `Numpad${digit}`);
const FUNCTION_CODES = Array.from({ length: 24 }, (_, index) => `F${index + 1}`);
const PUNCTUATION_KEY_CODES = [...Object.values(PUNCTUATION_CODES), "IntlBackslash"];
const KNOWN_CODES = new Set([...LETTER_CODES, ...DIGIT_CODES, ...NUMPAD_DIGIT_CODES, ...FUNCTION_CODES,
  ...PUNCTUATION_KEY_CODES, ...Object.keys(NAMED_KEY_LABELS)]);

// Keys that write in the search box when pressed alone or with Maiusc.
const TYPING_CODES = new Set([...LETTER_CODES, ...DIGIT_CODES, ...NUMPAD_DIGIT_CODES, ...PUNCTUATION_KEY_CODES,
  "Space", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal"]);

// Keys that edit the text of the search box: deleting, moving the caret, selecting, clipboard, undo.
const EDITING_BINDINGS = new Set([
  "Backspace", "Delete", "Home", "End", "Shift+Backspace", "Shift+Delete", "Shift+Home", "Shift+End", "Shift+Insert",
  "Ctrl+Backspace", "Ctrl+Delete", "Ctrl+Home", "Ctrl+End", "Ctrl+Insert", "Ctrl+Shift+Home", "Ctrl+Shift+End",
  "Ctrl+KeyA", "Ctrl+KeyC", "Ctrl+KeyV", "Ctrl+KeyX", "Ctrl+KeyZ", "Ctrl+KeyY", "Ctrl+Shift+KeyZ"
]);
// The editing keys an action may keep: it does what the key already means (removing a filter only when the search
// box is empty, selecting everything).
const EDITING_ALLOWED = { removeChip: new Set(["Backspace", "Delete"]), selectAll: new Set(["Ctrl+KeyA"]) };

// Combinations Windows or the window itself acts on (close, switch window, Start, Task Manager, window menu), and the
// lock keys.
const IN_APP_RESERVED = new Set(["Alt+F4", "Alt+Tab", "Alt+Shift+Tab", "Alt+Escape", "Ctrl+Escape", "Ctrl+Shift+Escape",
  "Alt+Space", "CapsLock", "NumLock", "ScrollLock"]);

/** { Super, Ctrl, Alt, Shift, code } of a binding, or null. */
export function parseBinding(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return null;
  const mods = { Super: false, Ctrl: false, Alt: false, Shift: false };
  for (const part of parts.slice(0, -1)) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (!mod) return null;
    mods[mod] = true;
  }
  const code = parts[parts.length - 1] === "NumpadEnter" ? "Enter" : parts[parts.length - 1];
  return KNOWN_CODES.has(code) ? { ...mods, code } : null;
}

export function normalizeBinding(text) {
  const parsed = parseBinding(text);
  return parsed === null ? null : joinCombo(parsed, parsed.code);
}

const CODE_FROM_KEY = {
  Enter: "Enter", Escape: "Escape", Esc: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", " ": "Space"
};

// The physical key of an event. The Enter of the numeric keypad counts as Enter; events without a code (some
// virtual keyboards) fall back to the key they produce.
function eventCode(event) {
  const code = typeof event.code === "string" ? event.code : "";
  if (code === "NumpadEnter") return "Enter";
  if (code !== "" && code !== "Unidentified") return code;
  if (Object.hasOwn(CODE_FROM_KEY, event.key)) return CODE_FROM_KEY[event.key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key;
  if (typeof event.key === "string" && /^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (typeof event.key === "string" && /^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  return "";
}

/** The binding a keydown event describes: { binding }, { pending, mods } or { error: "unsupported" }. */
export function bindingFromKeyEvent(event) {
  const mods = modifiersOf(event);
  const code = eventCode(event);
  if (MODIFIER_CODES.has(code) || MODIFIER_KEY_NAMES.has(event.key)) return { pending: true, mods };
  if (!KNOWN_CODES.has(code)) return { error: "unsupported" };
  return { binding: joinCombo(mods, code) };
}

/**
 * True when the event is exactly the binding (same physical key, same modifiers). Keys typed with AltGr never match,
 * so @ # [ ] € always reach the search box.
 */
export function matchesBinding(event, binding) {
  const parsed = parseBinding(binding);
  if (parsed === null || event.getModifierState?.("AltGraph")) return false;
  return eventCode(event) === parsed.code
    && Boolean(event.ctrlKey) === parsed.Ctrl
    && Boolean(event.altKey) === parsed.Alt
    && Boolean(event.shiftKey) === parsed.Shift
    && Boolean(event.metaKey) === parsed.Super;
}

/**
 * The accelerator name of the key at a physical position (KeyboardEvent.code): the virtual key the user's layout gives
 * that key, which is what the global shortcut registers. layout is what main.rs keyboard_layout_labels answers
 * ({ tokens, codes }): a character key is found by the character both tables give it (on an Italian keyboard the ù
 * key, code Backslash, is "/"; the \ key, code Backquote, is "\"). Without it the US layout is assumed; null when the
 * key has no accelerator name on that layout.
 */
function acceleratorKeyOfCode(code, layout) {
  const character = layout?.codes?.[code];
  if (typeof character !== "string" || character.length === 0) return keyFromCode(code);
  // main.rs names letters and digits by their virtual key, which is also their accelerator name.
  if (/^[A-Z0-9]$/.test(character)) return character;
  const tokens = layout.tokens ?? {};
  return Object.keys(tokens).find((token) => tokens[token] === character) ?? null;
}

/**
 * True when the global shortcut and an in-app binding are the same keys (the global one would take them). layout:
 * see acceleratorKeyOfCode; without it punctuation keys are compared by their US names.
 */
export function bindingEqualsAccelerator(binding, accelerator, layout = null) {
  const parsed = parseBinding(binding);
  const shortcut = parseAccelerator(accelerator);
  if (parsed === null || shortcut === null) return false;
  return MODIFIERS.every((mod) => parsed[mod] === shortcut[mod]) && acceleratorKeyOfCode(parsed.code, layout) === shortcut.key;
}

/**
 * Why an action cannot use a binding; null when it can. The result is { reason } or, for a clash with another action,
 * { reason: "conflict", action } where action is that action's id.
 * Reasons: "invalid", "win" (Windows keeps the Win key), "altgr" (Ctrl + Alt is AltGr), "fixed" (arrows and Enter),
 * "reserved", "types" (the key would write in the search box, also Alt + a keypad digit, which types by code),
 * "editing" (it edits the text), "conflict", "global" (the global shortcut takes it). bindings are the current keys of
 * every action; globalAccelerator the global shortcut; layout the keyboard layout labels (bindingEqualsAccelerator).
 * Without them only the binding itself is checked.
 */
export function bindingProblem(actionId, binding, bindings = null, globalAccelerator = null, layout = null) {
  const parsed = parseBinding(binding);
  if (parsed === null) return { reason: "invalid" };
  const { Super: win, Ctrl: ctrl, Alt: alt, Shift: shift, code } = parsed;
  const canonical = joinCombo(parsed, code);
  if (win) return { reason: "win" };
  if (ctrl && alt) return { reason: "altgr" };
  if (isArrow(code) || canonical === "Enter") return { reason: "fixed" };
  if (IN_APP_RESERVED.has(canonical)) return { reason: "reserved" };
  if (!ctrl && !alt && TYPING_CODES.has(code)) return { reason: "types" };
  if (alt && !ctrl && !shift && isNumpadDigit(code)) return { reason: "types" };
  if (EDITING_BINDINGS.has(canonical) && !EDITING_ALLOWED[actionId]?.has(canonical)) return { reason: "editing" };
  if (bindings) {
    const other = IN_APP_ACTIONS.find(({ id }) => id !== actionId && normalizeBinding(bindings[id]) === canonical);
    if (other) return { reason: "conflict", action: other.id };
  }
  if (globalAccelerator && bindingEqualsAccelerator(canonical, globalAccelerator, layout)) return { reason: "global" };
  return null;
}

/** The action already using a global shortcut inside the app, or null. layout: see bindingEqualsAccelerator. */
export function actionUsingAccelerator(accelerator, bindings, layout = null) {
  return IN_APP_ACTIONS.find(({ id }) => bindingEqualsAccelerator(bindings?.[id], accelerator, layout)) ?? null;
}

/**
 * The keys of every action from what settings.json holds (only the keys the user changed). Unknown actions and
 * unusable values are ignored; when two changed actions end up on the same keys, the later one goes back to its
 * default. An empty or missing object gives the defaults (the reset).
 */
export function resolveBindings(stored) {
  const result = { ...DEFAULT_BINDINGS };
  const changed = new Set();
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const { id } of IN_APP_ACTIONS) {
      const canonical = typeof stored[id] === "string" ? normalizeBinding(stored[id]) : null;
      if (canonical !== null && bindingProblem(id, canonical) === null) {
        result[id] = canonical;
        if (canonical !== DEFAULT_BINDINGS[id]) changed.add(id);
      }
    }
  }
  for (let collided = true; collided;) {
    collided = false;
    for (const { id } of [...IN_APP_ACTIONS].reverse()) {
      if (!changed.has(id)) continue;
      if (IN_APP_ACTIONS.some((other) => other.id !== id && result[other.id] === result[id])) {
        result[id] = DEFAULT_BINDINGS[id];
        changed.delete(id);
        collided = true;
      }
    }
  }
  return result;
}

/** What settings.json keeps: only the actions whose keys differ from the default. */
export function bindingOverrides(bindings) {
  return Object.fromEntries(IN_APP_ACTIONS
    .filter(({ id }) => typeof bindings?.[id] === "string" && bindings[id] !== DEFAULT_BINDINGS[id])
    .map(({ id }) => [id, bindings[id]]));
}

function codeLabel(code, codeLabels, compact) {
  if (compact && COMPACT_KEY_LABELS[code]) return COMPACT_KEY_LABELS[code];
  if (Object.hasOwn(NAMED_KEY_LABELS, code)) return NAMED_KEY_LABELS[code];
  const fromLayout = codeLabels?.[code];
  if (typeof fromLayout === "string" && fromLayout.length > 0) return /^[a-z]$/.test(fromLayout) ? fromLayout.toUpperCase() : fromLayout;
  let match;
  if ((match = /^Key([A-Z])$/.exec(code))) return match[1];
  if ((match = /^Digit([0-9])$/.exec(code))) return match[1];
  if ((match = /^Numpad([0-9])$/.exec(code))) return `Num ${match[1]}`;
  if (code === "IntlBackslash") return "<";
  return PUNCTUATION_BY_CODE[code] ?? code;
}

/**
 * The keys of a binding as the user reads them: ["Ctrl", "Invio"]. codeLabels maps KeyboardEvent.code to the
 * character of the user's layout (main.rs, keyboard_layout_labels); compact writes Enter as ↵ for the action bar.
 */
export function bindingKeys(binding, codeLabels = {}, { compact = false } = {}) {
  const parsed = parseBinding(binding);
  if (parsed === null) return [String(binding ?? "")];
  return [...MODIFIERS.filter((mod) => parsed[mod]).map((mod) => MODIFIER_LABELS[mod]),
    codeLabel(parsed.code, codeLabels, compact)];
}

export function formatBinding(binding, codeLabels = {}, options = {}) {
  return bindingKeys(binding, codeLabels, options).join(" + ");
}

/** Held modifiers while a combination is being recorded: "Ctrl + Maiusc + …", or "" when none is held. */
export function formatPendingModifiers(mods) {
  const held = MODIFIERS.filter((mod) => mods?.[mod]).map((mod) => MODIFIER_LABELS[mod]);
  return held.length === 0 ? "" : `${held.join(" + ")} + …`;
}

// ---------------------------------------------------------------------------
// Messages (Italian)
// ---------------------------------------------------------------------------

// Why a global shortcut was not accepted: the reasons of globalShortcutProblem, "unsupported" from the recorder,
// "in_use" when Windows refuses to register it (main.rs, update_shortcut) and "in_app" when an action uses it.
export const SHORTCUT_PROBLEM_TEXT = {
  invalid: "Combinazione non valida",
  unsupported: "Tasto non supportato",
  missing_modifier: "Serve Ctrl, Alt o Win, oppure F1–F24",
  shift_only: "Con Maiusc serve anche Ctrl, Alt o Win",
  reserved: "Riservata a Windows",
  altgr: "Ctrl + Alt è AltGr: scrive @ # € [ ]",
  alt_code: "Alt + tastierino numerico scrive caratteri",
  common: "Usata da tutte le app (salva, copia, cerca…)",
  in_use: "Già in uso da un'altra app",
  in_app: (actionLabel) => `Già usata nell'app: “${actionLabel}”`
};

// Why an in-app key was not accepted: the reasons of bindingProblem, plus "unsupported" from the recorder.
export const BINDING_PROBLEM_TEXT = {
  invalid: "Combinazione non valida",
  unsupported: "Tasto non supportato",
  win: "Il tasto Win è riservato a Windows",
  altgr: "Ctrl + Alt è AltGr: scrive @ # € [ ]",
  fixed: "Frecce e Invio sono fissi",
  reserved: "Riservata a Windows",
  types: "Scriverebbe nella ricerca",
  editing: "Serve a modificare il testo",
  conflict: (actionLabel) => `Già usata per “${actionLabel}”`,
  global: "Apre già RocketLauncher"
};

export function actionLabel(actionId) {
  return IN_APP_ACTIONS.find(({ id }) => id === actionId)?.label ?? actionId;
}
