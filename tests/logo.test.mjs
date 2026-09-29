import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// Il logo "Orbita" e' identico ovunque: branding/rocketlauncher-icon.svg e' l'unico sorgente delle icone (npm run
// icons) e src/index.html ne ripete a mano il disegno nel simbolo #rl-logo. Questi test fermano una modifica fatta
// in un solo punto.

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const bytes = (path) => readFileSync(join(root, path))

// Contenitori che non disegnano nulla: cambiano tra file SVG e sprite in linea senza cambiare il disegno.
const WRAPPERS = new Set(['svg', 'title', 'defs', 'symbol', 'use'])

/** Gli elementi di un frammento SVG in ordine, ciascuno con i suoi attributi in ordine. */
function drawing(markup) {
  const withoutComments = markup.replace(/<!--[\s\S]*?-->/g, '')
  const elements = []
  for (const [, tag, attributes] of withoutComments.matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
    if (WRAPPERS.has(tag)) continue
    elements.push([tag, [...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => `${name}=${value}`)])
  }
  return elements
}

describe('Orbita logo', () => {
  it('repeats the master SVG exactly in the #rl-logo symbol of the launcher', () => {
    const master = drawing(read('branding/rocketlauncher-icon.svg'))
    const sprite = /<svg class="svg-sprite"[\s\S]*?<\/svg>/.exec(read('src/index.html'))
    assert.ok(sprite, 'svg-sprite block missing in src/index.html')
    assert.match(sprite[0], /<symbol id="rl-logo" viewBox="0 0 1024 1024">/)
    assert.equal(master.length, 15)
    assert.deepEqual(drawing(sprite[0]), master)
  })

  it('uses the app icon itself for the tray and the README', () => {
    assert.ok(bytes('src-tauri/icons/tray/32x32.png').equals(bytes('src-tauri/icons/32x32.png')), 'tray icon')
    assert.ok(bytes('docs/images/logo.png').equals(bytes('src-tauri/icons/128x128@2x.png')), 'README logo')
    assert.match(read('src-tauri/src/main.rs'), /include_bytes!\("\.\.\/icons\/tray\/32x32\.png"\)/)
  })
})
