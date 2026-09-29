import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  BINDING_PROBLEM_TEXT,
  DEFAULT_BINDINGS,
  DEFAULT_SHORTCUT,
  IN_APP_ACTIONS,
  PRESET_SHORTCUTS,
  SHORTCUT_PROBLEM_TEXT,
  acceleratorFromKeyEvent,
  acceleratorKeys,
  actionUsingAccelerator,
  bindingEqualsAccelerator,
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
  normalizeBinding,
  parseAccelerator,
  resolveBindings
} from '../src/shortcuts.js'

// Tasti di scelta rapida: the global shortcut (accelerator syntax of tauri-plugin-global-shortcut, registered by
// virtual key) and the keys of the in-app actions (KeyboardEvent.code). The cases of the global rules are the same as
// the Rust tests of shortcut_problem() in src-tauri/src/main.rs, so the two sides cannot drift apart unnoticed.

const root = join(import.meta.dirname, '..')
const mainRs = readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8')

// What main.rs keyboard_layout_labels answers on an Italian keyboard (KBDIT).
const ITALIAN = {
  tokens: { '`': 'ò', '-': '-', '=': '+', '[': "'", ']': 'ì', '\\': '\\', ';': 'è', "'": 'à', ',': ',', '.': '.', '/': 'ù' },
  codes: { Backquote: '\\', Minus: "'", Equal: 'ì', BracketLeft: 'è', BracketRight: '+', Semicolon: 'ò', Quote: 'à', Backslash: 'ù', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<', KeyA: 'A', Digit1: '1' }
}

/** A keydown as WebView2 reports it on Windows: keyCode is the Windows virtual key of the pressed key. */
function keydown({ key = '', code = '', keyCode = 0, ctrl = false, alt = false, shift = false, win = false, altGraph = false } = {}) {
  return {
    key, code, keyCode, ctrlKey: ctrl, altKey: alt, shiftKey: shift, metaKey: win,
    getModifierState: (name) => name === 'AltGraph' && altGraph
  }
}

describe('global shortcut: from a key press to an accelerator', () => {
  it('records the default Win + Maiusc + . as the upstream accelerator', () => {
    const event = keydown({ key: ':', code: 'Period', keyCode: 0xbe, win: true, shift: true })
    assert.deepEqual(acceleratorFromKeyEvent(event), { accelerator: 'Super+Shift+.' })
  })

  it('names a punctuation key after the virtual key the layout gives it, and shows the character of the layout', () => {
    // Italian keyboard: the ù key sits where a US keyboard has \ (code Backslash) but produces VK_OEM_2, which
    // global-hotkey registers for "/". The "Win + /" preset is that very key.
    const event = keydown({ key: 'ù', code: 'Backslash', keyCode: 0xbf, win: true })
    const { accelerator } = acceleratorFromKeyEvent(event)
    assert.equal(accelerator, 'Super+/')
    assert.equal(formatAccelerator(accelerator, ITALIAN.tokens), 'Win + ù')
    assert.equal(formatAccelerator('Super+/'), 'Win + /', 'US names without layout labels')
  })

  it('records letters, digits, function keys, Space and the numeric keypad', () => {
    const cases = [
      [{ key: 'K', code: 'KeyK', keyCode: 0x4b, ctrl: true, shift: true }, 'Ctrl+Shift+K'],
      [{ key: ' ', code: 'Space', keyCode: 0x20, ctrl: true }, 'Ctrl+Space'],
      [{ key: 'F12', code: 'F12', keyCode: 0x7b, ctrl: true, alt: true, shift: true, win: true }, 'Super+Ctrl+Alt+Shift+F12'],
      [{ key: '!', code: 'Digit1', keyCode: 0x31, alt: true, shift: true }, 'Alt+Shift+1'],
      [{ key: 'F9', code: 'F9', keyCode: 0x78 }, 'F9'],
      [{ key: '5', code: 'Numpad5', keyCode: 0x65, ctrl: true }, 'Ctrl+Numpad5'],
      [{ key: 'Enter', code: 'NumpadEnter', keyCode: 0x0d, ctrl: true, shift: true }, 'Ctrl+Shift+Enter'],
      [{ key: 'MediaPlayPause', code: 'MediaPlayPause', keyCode: 0xb3, alt: true }, 'Alt+MediaPlayPause']
    ]
    for (const [event, accelerator] of cases) assert.deepEqual(acceleratorFromKeyEvent(keydown(event)), { accelerator }, accelerator)
  })

  it('waits while only modifiers are held and previews them in Italian', () => {
    const result = acceleratorFromKeyEvent(keydown({ key: 'Shift', code: 'ShiftLeft', keyCode: 0x10, ctrl: true, shift: true }))
    assert.equal(result.pending, true)
    assert.equal(formatPendingModifiers(result.mods), 'Ctrl + Maiusc + …')
    assert.equal(acceleratorFromKeyEvent(keydown({ key: 'Meta', code: 'MetaLeft', keyCode: 0x5b, win: true })).pending, true)
    assert.equal(acceleratorFromKeyEvent(keydown({ key: 'AltGraph', code: 'AltRight', keyCode: 0x12, ctrl: true, alt: true })).pending, true)
    assert.equal(formatPendingModifiers({}), '')
  })

  it('refuses keys the plugin cannot register and uses the physical key only when there is no virtual key', () => {
    // The "<" key of European keyboards is VK_OEM_102: global-hotkey has no name for it.
    assert.deepEqual(acceleratorFromKeyEvent(keydown({ key: '<', code: 'IntlBackslash', keyCode: 0xe2, ctrl: true })), { error: 'unsupported' })
    assert.deepEqual(acceleratorFromKeyEvent(keydown({ key: 'Process', code: 'KeyJ', keyCode: 229, ctrl: true, alt: true, win: true })),
      { accelerator: 'Super+Ctrl+Alt+J' })
  })

  it('counts AltGr as Ctrl + Alt even when only the AltGraph modifier is reported', () => {
    const event = keydown({ key: '@', code: 'Semicolon', keyCode: 0xc0, altGraph: true })
    assert.equal(isAltGraph(event), true)
    assert.deepEqual(acceleratorFromKeyEvent(event), { accelerator: 'Ctrl+Alt+`' })
    assert.equal(globalShortcutProblem('Ctrl+Alt+`'), 'altgr')
  })
})

describe('global shortcut: accelerator syntax', () => {
  it('parses and normalizes the spellings the plugin accepts', () => {
    assert.equal(normalizeAccelerator('shift+super+KeyS'), 'Super+Shift+S')
    assert.equal(normalizeAccelerator('CommandOrControl+Shift+Space'), 'Ctrl+Shift+Space')
    assert.equal(normalizeAccelerator('Control+Alt+Period'), 'Ctrl+Alt+.')
    assert.equal(normalizeAccelerator('Super+Slash'), 'Super+/')
    assert.equal(normalizeAccelerator('alt+esc'), 'Alt+Escape')
    assert.equal(normalizeAccelerator('Ctrl+Digit7'), 'Ctrl+7')
    assert.equal(normalizeAccelerator('Ctrl+num3'), 'Ctrl+Numpad3')
    assert.deepEqual(parseAccelerator('Super+Shift+.'), { Super: true, Ctrl: false, Alt: false, Shift: true, key: '.' })
  })

  it('refuses what the plugin refuses', () => {
    for (const text of ['', 'Ctrl+', 'Ctrl+Shift', 'Ctrl+K+Alt', 'Ctrl+IntlBackslash', 'Ctrl+Foo', 'Ctrl++', 'Ctrl+F0', 'Ctrl+F25', null]) {
      assert.equal(parseAccelerator(text), null, String(text))
      assert.equal(globalShortcutProblem(text), 'invalid', String(text))
    }
  })

  it('shows the eight presets with Italian key names', () => {
    assert.deepEqual(PRESET_SHORTCUTS.map((preset) => formatAccelerator(preset)), [
      'Win + Maiusc + .', 'Alt + Spazio', 'Win + Spazio', 'Ctrl + Spazio', 'Ctrl + Maiusc + Spazio', 'Win + S', 'Alt + S', 'Win + /'
    ])
    assert.deepEqual(acceleratorKeys('Ctrl+Alt+Delete'), ['Ctrl', 'Alt', 'Canc'])
    assert.equal(formatAccelerator('Super+Shift+Enter'), 'Win + Maiusc + Invio')
    assert.equal(formatAccelerator('Ctrl+Escape'), 'Ctrl + Esc')
    assert.equal(formatAccelerator('Alt+Tab'), 'Alt + Tab')
    assert.equal(formatAccelerator('Ctrl+Numpad0'), 'Ctrl + Num 0')
    assert.equal(formatAccelerator('Ctrl+PageDown'), 'Ctrl + Pag↓')
    assert.equal(formatAccelerator('Ctrl+Shift+`', ITALIAN.tokens), 'Ctrl + Maiusc + ò')
  })

  it('keeps the presets and the default identical to main.rs', () => {
    const rustPresets = /const PRESET_SHORTCUTS: &\[&str\] = &\[([\s\S]*?)\];/.exec(mainRs)?.[1]
    assert.ok(rustPresets, 'PRESET_SHORTCUTS in main.rs')
    assert.deepEqual([...rustPresets.matchAll(/"([^"]+)"/g)].map((m) => m[1]), PRESET_SHORTCUTS)
    assert.ok(mainRs.includes(`const DEFAULT_SHORTCUT: &str = "${DEFAULT_SHORTCUT}";`), 'DEFAULT_SHORTCUT in main.rs')
    assert.equal(DEFAULT_SHORTCUT, PRESET_SHORTCUTS[0])
  })
})

describe('global shortcut: validation (same cases as the Rust tests)', () => {
  it('accepts the default and the usable Velocmd presets, and marks Win+S and Win+Spazio as reserved', () => {
    for (const preset of ['Super+Shift+.', 'Alt+Space', 'Ctrl+Space', 'Ctrl+Shift+Space', 'Alt+S', 'Super+/']) {
      assert.equal(globalShortcutProblem(preset), null, preset)
    }
    assert.equal(globalShortcutProblem('Super+S'), 'reserved')
    assert.equal(globalShortcutProblem('Super+Space'), 'reserved')
  })

  it('accepts recorded combinations', () => {
    for (const accelerator of ['Ctrl+Shift+K', 'Super+Ctrl+Alt+Shift+F12', 'Ctrl+Alt+F5', 'Alt+Shift+1', 'F9', 'Shift+F5',
      'Super+Shift+K', 'Ctrl+Alt+Space', 'Ctrl+Numpad5', 'Super+`', "Ctrl+Shift+'", 'Alt+MediaPlayPause']) {
      assert.equal(globalShortcutProblem(accelerator), null, accelerator)
    }
  })

  it('needs Ctrl, Alt or Win unless the key is F1-F24', () => {
    assert.equal(globalShortcutProblem('A'), 'missing_modifier')
    assert.equal(globalShortcutProblem('Space'), 'missing_modifier')
    assert.equal(globalShortcutProblem('Escape'), 'missing_modifier')
    assert.equal(globalShortcutProblem('Shift+A'), 'shift_only')
    assert.equal(globalShortcutProblem('Shift+.'), 'shift_only')
    assert.equal(globalShortcutProblem('F1'), null)
    assert.equal(globalShortcutProblem('F24'), null)
  })

  it('refuses Windows-reserved and dangerous combinations', () => {
    for (const accelerator of [
      'Super+L', 'Super+Shift+L', 'Ctrl+Alt+Delete', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Ctrl+Escape',
      'Ctrl+Shift+Escape', 'Alt+Escape', 'Super+D', 'Super+E', 'Super+R', 'Super+I', 'Super+S', 'Super+X',
      'Super+Tab', 'Super+1', 'Super+0', 'Super+.', 'Super+;', 'Super+Up', 'Super+Shift+S', 'Super+Shift+Left',
      'Super+Ctrl+D', 'Super+Ctrl+Left', 'Super+Alt+R', 'Super+Ctrl+Shift+B', 'Ctrl+Alt+Tab', 'Shift+F10',
      'Alt+PrintScreen', 'Super+PrintScreen'
    ]) {
      assert.equal(globalShortcutProblem(accelerator), 'reserved', accelerator)
    }
  })

  it('refuses AltGr characters and the editing combinations of every app', () => {
    for (const accelerator of ['Ctrl+Alt+`', "Ctrl+Alt+'", 'Ctrl+Alt+;', 'Ctrl+Alt+E', 'Ctrl+Alt+Shift+;', 'Ctrl+Alt+1']) {
      assert.equal(globalShortcutProblem(accelerator), 'altgr', accelerator)
    }
    assert.equal(globalShortcutProblem('Super+Ctrl+Alt+E'), null)
    for (const accelerator of ['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Insert', 'Ctrl+S',
      'Ctrl+F', 'Ctrl+P', 'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+O', 'Ctrl+Tab', 'Ctrl+Backspace', 'Ctrl+Delete',
      'Ctrl+Home', 'Ctrl+End', 'Ctrl+Shift+C', 'Ctrl+Shift+V', 'Ctrl+Shift+S', 'Ctrl+Shift+P', 'Ctrl+Shift+T',
      'Ctrl+Shift+Tab']) {
      assert.equal(globalShortcutProblem(accelerator), 'common', accelerator)
    }
    for (const accelerator of ['Ctrl+Shift+K', 'Ctrl+Space', 'Ctrl+Shift+Space', 'Ctrl+Alt+F5', 'Super+Ctrl+S']) {
      assert.equal(globalShortcutProblem(accelerator), null, accelerator)
    }
  })

  it('refuses Alt + a keypad digit, which types characters by code in every app (Alt+64 is @)', () => {
    for (const accelerator of ['Alt+Numpad0', 'Alt+Numpad6', 'Alt+Num4', 'Alt+Numpad9']) {
      assert.equal(globalShortcutProblem(accelerator), 'alt_code', accelerator)
    }
    for (const accelerator of ['Alt+Shift+Numpad6', 'Ctrl+Numpad6', 'Super+Alt+Numpad6', 'Alt+NumpadAdd', 'Alt+6']) {
      assert.equal(globalShortcutProblem(accelerator), null, accelerator)
    }
    const recorded = acceleratorFromKeyEvent(keydown({ key: '6', code: 'Numpad6', keyCode: 0x66, alt: true }))
    assert.deepEqual(recorded, { accelerator: 'Alt+Numpad6' })
    assert.equal(globalShortcutProblem(recorded.accelerator), 'alt_code')
  })

  it('has an Italian message for every outcome', () => {
    for (const reason of ['invalid', 'unsupported', 'missing_modifier', 'shift_only', 'reserved', 'altgr', 'alt_code', 'common', 'in_use']) {
      assert.equal(typeof SHORTCUT_PROBLEM_TEXT[reason], 'string', reason)
      assert.ok(SHORTCUT_PROBLEM_TEXT[reason].length > 0 && SHORTCUT_PROBLEM_TEXT[reason].length <= 45, reason)
    }
    assert.equal(SHORTCUT_PROBLEM_TEXT.reserved, 'Riservata a Windows')
    assert.equal(SHORTCUT_PROBLEM_TEXT.in_use, "Già in uso da un'altra app")
    assert.equal(SHORTCUT_PROBLEM_TEXT.in_app('Mostra in Esplora file'), "Già usata nell'app: “Mostra in Esplora file”")
    // Every refusal code main.rs can answer has a message.
    const rustCodes = [...mainRs.matchAll(/ShortcutProblem::\w+ => "(\w+)"/g)].map((m) => m[1])
    assert.deepEqual(rustCodes.sort(), ['alt_code', 'altgr', 'common', 'invalid', 'missing_modifier', 'reserved', 'shift_only'])
    for (const code of rustCodes) assert.ok(SHORTCUT_PROBLEM_TEXT[code], code)
  })
})

describe('in-app keys: actions, recording and matching', () => {
  it('lists every action that has a key, with the upstream keys as defaults', () => {
    assert.deepEqual(IN_APP_ACTIONS.map(({ id }) => id), ['settings', 'reveal', 'clear', 'removeChip', 'selectAll'])
    assert.deepEqual({ ...DEFAULT_BINDINGS }, {
      settings: 'Tab', reveal: 'Ctrl+Enter', clear: 'Escape', removeChip: 'Backspace', selectAll: 'Ctrl+KeyA'
    })
    assert.deepEqual(IN_APP_ACTIONS.map(({ binding }) => formatBinding(binding)),
      ['Tab', 'Ctrl + Invio', 'Esc', 'Backspace', 'Ctrl + A'])
    for (const { id, binding } of IN_APP_ACTIONS) assert.equal(bindingProblem(id, binding, DEFAULT_BINDINGS, DEFAULT_SHORTCUT), null, id)
  })

  it('records the physical key and its modifiers', () => {
    assert.deepEqual(bindingFromKeyEvent(keydown({ key: 'F2', code: 'F2', keyCode: 0x71 })), { binding: 'F2' })
    assert.deepEqual(bindingFromKeyEvent(keydown({ key: 'Enter', code: 'NumpadEnter', ctrl: true, shift: true })), { binding: 'Ctrl+Shift+Enter' })
    assert.deepEqual(bindingFromKeyEvent(keydown({ key: 'q', code: 'KeyQ', alt: true })), { binding: 'Alt+KeyQ' })
    assert.equal(bindingFromKeyEvent(keydown({ key: 'Control', code: 'ControlLeft', ctrl: true })).pending, true)
    assert.deepEqual(bindingFromKeyEvent(keydown({ key: 'Unidentified', code: 'Lang1' })), { error: 'unsupported' })
  })

  it('matches exactly one binding and never a key typed with AltGr', () => {
    assert.equal(matchesBinding(keydown({ key: 'Tab', code: 'Tab' }), 'Tab'), true)
    assert.equal(matchesBinding(keydown({ key: 'Tab', code: 'Tab', shift: true }), 'Tab'), false)
    assert.equal(matchesBinding(keydown({ key: 'Enter', code: 'NumpadEnter', ctrl: true }), 'Ctrl+Enter'), true)
    assert.equal(matchesBinding(keydown({ key: 'a', code: 'KeyA', ctrl: true }), 'Ctrl+KeyA'), true)
    assert.equal(matchesBinding(keydown({ key: 'Escape', code: '' }), 'Escape'), true, 'no code: the key stands in')
    // AltGr+ò types @ on an Italian keyboard; AltGr+E types €. Neither may ever be taken by an action.
    const at = keydown({ key: '@', code: 'Semicolon', ctrl: true, alt: true, altGraph: true })
    const euro = keydown({ key: '€', code: 'KeyE', ctrl: true, alt: true, altGraph: true })
    for (const binding of [...Object.values(DEFAULT_BINDINGS), 'Alt+KeyE', 'Ctrl+KeyE', 'Alt+Semicolon', 'KeyE']) {
      assert.equal(matchesBinding(at, binding), false, binding)
      assert.equal(matchesBinding(euro, binding), false, binding)
    }
  })

  it('refuses keys that would break typing in the search box', () => {
    const problem = (id, binding) => bindingProblem(id, binding)?.reason ?? null
    assert.equal(problem('settings', 'KeyQ'), 'types')
    assert.equal(problem('settings', 'Shift+Digit2'), 'types')
    assert.equal(problem('settings', 'Space'), 'types')
    assert.equal(problem('settings', 'IntlBackslash'), 'types')
    assert.equal(problem('settings', 'Ctrl+Alt+Semicolon'), 'altgr', 'AltGr + ò is @')
    assert.equal(problem('settings', 'Ctrl+Alt+KeyE'), 'altgr', 'AltGr + E is €')
    assert.equal(problem('settings', 'Ctrl+Alt+F5'), 'altgr', 'Ctrl + Alt is AltGr whatever the key')
    // Alt + keypad digits type characters by code (Alt+64 is @); with Ctrl or Maiusc they do not.
    assert.equal(problem('settings', 'Alt+Numpad6'), 'types')
    assert.equal(problem('settings', 'Alt+Numpad0'), 'types')
    assert.equal(problem('settings', 'Ctrl+Numpad6'), null)
    assert.equal(problem('settings', 'Alt+Shift+Numpad6'), null)
    assert.equal(problem('settings', 'Alt+Digit6'), null)
    assert.equal(problem('settings', 'Backspace'), 'editing')
    assert.equal(problem('clear', 'Delete'), 'editing')
    assert.equal(problem('settings', 'Ctrl+KeyV'), 'editing')
    assert.equal(problem('reveal', 'Ctrl+KeyA'), 'editing')
    assert.equal(problem('settings', 'Shift+Home'), 'editing')
    // The editing key an action already means stays possible.
    assert.equal(problem('removeChip', 'Delete'), null)
    assert.equal(problem('removeChip', 'Backspace'), null)
    assert.equal(problem('selectAll', 'Ctrl+KeyA'), null)
  })

  it('keeps arrows and Enter fixed and refuses Win and the combinations Windows acts on', () => {
    const problem = (id, binding) => bindingProblem(id, binding)?.reason ?? null
    for (const binding of ['ArrowUp', 'ArrowDown', 'Ctrl+ArrowLeft', 'Shift+ArrowRight', 'Enter']) {
      assert.equal(problem('settings', binding), 'fixed', binding)
    }
    assert.equal(problem('settings', 'Super+KeyK'), 'win')
    for (const binding of ['Alt+F4', 'Alt+Tab', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Alt+Space', 'CapsLock']) {
      assert.equal(problem('settings', binding), 'reserved', binding)
    }
    for (const binding of ['F2', 'Ctrl+Comma', 'Alt+KeyS', 'Ctrl+Shift+Enter', 'Shift+Tab', 'Ctrl+Space', 'Escape', 'Tab']) {
      assert.equal(problem('settings', binding), null, binding)
    }
  })

  it('warns about a key another action or the global shortcut already uses, without overwriting it', () => {
    assert.deepEqual(bindingProblem('settings', 'Ctrl+Enter', DEFAULT_BINDINGS), { reason: 'conflict', action: 'reveal' })
    assert.deepEqual(bindingProblem('reveal', 'Escape', DEFAULT_BINDINGS), { reason: 'conflict', action: 'clear' })
    assert.equal(bindingProblem('settings', 'Tab', DEFAULT_BINDINGS), null, 'its own key is no clash')
    assert.deepEqual(bindingProblem('settings', 'Ctrl+Space', DEFAULT_BINDINGS, 'Ctrl+Space'), { reason: 'global' })
    assert.deepEqual(bindingProblem('settings', 'Alt+KeyS', DEFAULT_BINDINGS, 'Alt+S'), { reason: 'global' })
    assert.equal(bindingProblem('settings', 'Alt+KeyS', DEFAULT_BINDINGS, DEFAULT_SHORTCUT), null)
    assert.equal(bindingEqualsAccelerator('Ctrl+Shift+Space', 'Ctrl+Shift+Space'), true)
    assert.equal(bindingEqualsAccelerator('Ctrl+Space', 'Super+Space'), false)
    // And the other way round: a global shortcut an action uses.
    assert.equal(actionUsingAccelerator('Ctrl+Space', { ...DEFAULT_BINDINGS, settings: 'Ctrl+Space' })?.id, 'settings')
    assert.equal(actionUsingAccelerator('Ctrl+Space', DEFAULT_BINDINGS), null)
  })

  it('compares the global shortcut and an in-app key as the same physical key on the user\'s layout', () => {
    // Italian keyboard: the ù key (code Backslash) is the virtual key of "/", the \ key (code Backquote) the one of
    // "\", the - key (code Slash) the one of "-". The global shortcut is registered by virtual key, the in-app keys by
    // physical key: US names would miss the first clash and invent the second.
    assert.equal(bindingEqualsAccelerator('Ctrl+Shift+Backslash', 'Ctrl+Shift+/', ITALIAN), true)
    assert.equal(bindingEqualsAccelerator('Ctrl+Shift+Backslash', 'Ctrl+Shift+\\', ITALIAN), false)
    assert.equal(bindingEqualsAccelerator('Ctrl+Shift+Backquote', 'Ctrl+Shift+\\', ITALIAN), true)
    assert.equal(bindingEqualsAccelerator('Alt+Slash', 'Alt+-', ITALIAN), true)
    assert.equal(bindingEqualsAccelerator('Ctrl+IntlBackslash', 'Ctrl+\\', ITALIAN), false, '< has no accelerator name')
    // Letters, digits and the keys that are not characters do not depend on the layout; AZERTY: KeyQ is A.
    assert.equal(bindingEqualsAccelerator('Alt+KeyS', 'Alt+S', ITALIAN), true)
    assert.equal(bindingEqualsAccelerator('Ctrl+Shift+Enter', 'Ctrl+Shift+Enter', ITALIAN), true)
    assert.equal(bindingEqualsAccelerator('Alt+KeyQ', 'Alt+A', { tokens: {}, codes: { KeyQ: 'A' } }), true)
    // Without the layout labels (not read yet, or a US keyboard) the US names are used.
    assert.equal(bindingEqualsAccelerator('Ctrl+Shift+Backslash', 'Ctrl+Shift+\\'), true)
    assert.deepEqual(bindingProblem('reveal', 'Ctrl+Shift+Backslash', DEFAULT_BINDINGS, 'Ctrl+Shift+/', ITALIAN), { reason: 'global' })
    assert.equal(bindingProblem('reveal', 'Ctrl+Shift+Backslash', DEFAULT_BINDINGS, 'Ctrl+Shift+\\', ITALIAN), null)
    const withReveal = { ...DEFAULT_BINDINGS, reveal: 'Ctrl+Shift+Backslash' }
    assert.equal(actionUsingAccelerator('Ctrl+Shift+/', withReveal, ITALIAN)?.id, 'reveal')
    assert.equal(actionUsingAccelerator('Ctrl+Shift+\\', withReveal, ITALIAN), null)
  })

  it('has an Italian message for every refusal', () => {
    for (const reason of ['invalid', 'unsupported', 'win', 'altgr', 'fixed', 'reserved', 'types', 'editing', 'global']) {
      assert.equal(typeof BINDING_PROBLEM_TEXT[reason], 'string', reason)
    }
    assert.equal(BINDING_PROBLEM_TEXT.conflict('Mostra in Esplora file'), 'Già usata per “Mostra in Esplora file”')
    assert.equal(BINDING_PROBLEM_TEXT.types, 'Scriverebbe nella ricerca')
  })
})

describe('in-app keys: labels', () => {
  it('shows the keys in Italian, with the characters of the layout and Enter as ↵ in the action bar', () => {
    assert.deepEqual(bindingKeys('Ctrl+Enter'), ['Ctrl', 'Invio'])
    assert.deepEqual(bindingKeys('Ctrl+Enter', {}, { compact: true }), ['Ctrl', '↵'])
    assert.deepEqual(bindingKeys('Ctrl+Shift+Delete'), ['Ctrl', 'Maiusc', 'Canc'])
    assert.equal(formatBinding('Alt+Backslash', ITALIAN.codes), 'Alt + ù')
    assert.equal(formatBinding('Ctrl+Semicolon', ITALIAN.codes), 'Ctrl + ò')
    assert.equal(formatBinding('Ctrl+Semicolon'), 'Ctrl + ;')
    assert.equal(formatBinding('Ctrl+IntlBackslash'), 'Ctrl + <')
    assert.equal(formatBinding('Ctrl+KeyQ', { KeyQ: 'A' }), 'Ctrl + A', 'AZERTY: the key at the Q position reads A')
    assert.equal(formatBinding('F2'), 'F2')
    assert.equal(formatBinding('Shift+Tab'), 'Maiusc + Tab')
    assert.equal(formatBinding('Alt+Numpad7'), 'Alt + Num 7')
  })
})

describe('in-app keys: persistence and reset', () => {
  it('saves only the keys that differ from the defaults and reads them back', () => {
    const changed = { ...DEFAULT_BINDINGS, settings: 'F2', reveal: 'Ctrl+Shift+Enter' }
    const saved = bindingOverrides(changed)
    assert.deepEqual(saved, { settings: 'F2', reveal: 'Ctrl+Shift+Enter' })
    assert.deepEqual(resolveBindings(JSON.parse(JSON.stringify(saved))), changed)
    assert.deepEqual(bindingOverrides(DEFAULT_BINDINGS), {})
  })

  it('restores the defaults from an empty, missing or broken settings object (Ripristina)', () => {
    for (const stored of [{}, null, undefined, [], 'Tab', 42]) {
      assert.deepEqual(resolveBindings(stored), { ...DEFAULT_BINDINGS }, JSON.stringify(stored))
    }
  })

  it('ignores unknown actions and unusable keys', () => {
    assert.deepEqual(resolveBindings({ settings: 'KeyQ', reveal: 'Ctrl+Alt+KeyE', clear: 42, bogus: 'F2', selectAll: 'Ctrl+Shift+KeyA' }),
      { ...DEFAULT_BINDINGS, selectAll: 'Ctrl+Shift+KeyA' })
  })

  it('accepts two actions that swapped keys and resolves a clash back to the default of the later action', () => {
    assert.deepEqual(resolveBindings({ settings: 'Ctrl+Enter', reveal: 'Tab' }),
      { ...DEFAULT_BINDINGS, settings: 'Ctrl+Enter', reveal: 'Tab' })
    assert.deepEqual(resolveBindings({ settings: 'F2', reveal: 'F2' }), { ...DEFAULT_BINDINGS, settings: 'F2' })
    assert.deepEqual(resolveBindings({ settings: 'Ctrl+Enter' }), { ...DEFAULT_BINDINGS })
  })

  it('normalizes the spelling of a stored key', () => {
    assert.equal(normalizeBinding('shift+ctrl+KeyK'), 'Ctrl+Shift+KeyK')
    assert.equal(normalizeBinding('Control+NumpadEnter'), 'Ctrl+Enter')
    assert.equal(normalizeBinding('Ctrl+K'), null, 'bindings name the physical key: KeyK')
  })
})

describe('app wiring', () => {
  it('registers autostart with --autostart and starts silently only then', () => {
    assert.match(mainRs, /const AUTOSTART_ARG: &str = "--autostart";/)
    assert.match(mainRs, /\.arg\(AUTOSTART_ARG\)/)
    assert.match(mainRs, /if started_by_autostart\(std::env::args_os\(\)\) \{/)
  })

  it('puts "Impostazioni" in the tray menu between "Mostra RocketLauncher" and "Esci"', () => {
    const menu = /const TRAY_MENU: \[\(&str, &str\); 3\] = \[([\s\S]*?)\];/.exec(mainRs)?.[1]
    assert.ok(menu, 'TRAY_MENU in main.rs')
    assert.deepEqual([...menu.matchAll(/\("(\w+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]]),
      [['show', 'Mostra RocketLauncher'], ['settings', 'Impostazioni'], ['quit', 'Esci']])
    assert.match(mainRs, /"settings" => \{\s*show_main_window_with\(app, true\);/)
  })

  it('preselects "No, annulla" in the shutdown and restart confirmation', () => {
    const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8')
    assert.match(mainJs, /const POWER_CANCEL_INDEX = 1;/)
    assert.equal(mainJs.match(/state\.selectedIndex = POWER_CANCEL_INDEX;/g)?.length, 2)
  })

  it('toggles the window once per tray click: on the release, not on the press as well', () => {
    assert.match(mainRs, /TrayIconEvent::Click \{\s*button: MouseButton::Left,\s*button_state: MouseButtonState::Up,/)
  })

  it('hides the window only through hide_main_window, which lets the page clear the search', () => {
    // Every other hide skipped "window_hidden" and let the next show flash the last search.
    const hides = [...mainRs.matchAll(/\.hide\(\)|WebviewWindow::hide\(/g)].length
    assert.equal(hides, 1, 'a single hide call, inside hide_main_window')
    assert.match(mainRs, /fn hide_main_window\(window: &tauri::WebviewWindow\) \{[\s\S]*?WebviewWindow::hide\(window\)[\s\S]*?emit\("window_hidden"/)
    const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8')
    assert.doesNotMatch(mainJs, /getCurrentWindow\(\)\.hide\(\)/)
    assert.match(mainJs, /listen\("window_hidden"/)
  })

  it('reveals the cloaked window only after the page painted the clean bar, without an entrance animation', () => {
    assert.match(mainRs, /fn show_main_window_with[\s\S]*?set_cloaked\(&window, true\)[\s\S]*?emit\("reset_state"/)
    assert.match(mainRs, /fn reveal_main_window[\s\S]*?set_cloaked\(&window, false\)/)
    const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8')
    assert.match(mainJs, /listen\('reset_state'[\s\S]*?await afterPaint\(\);\s*await invoke\("reveal_window"\);/)
    const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
    assert.doesNotMatch(css + mainJs, /is-opening|rl-open/)
  })

  it('does not save a stand-in shortcut when the saved one was only busy at start-up', () => {
    assert.match(mainRs, /let saved_is_valid = shortcut_problem\(&loaded_shortcut\)\.is_none\(\);/)
    assert.match(mainRs, /if saved_is_valid \{\s*\*PREFERRED_SHORTCUT_BUSY/)
    assert.match(mainRs, /"preferred": preferred/)
  })
})
