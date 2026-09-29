import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { inputsFingerprint, licensesFile } from '../scripts/rust-licenses.mjs'

// Le licenze che accompagnano gli eseguibili: il testo della GPL-3.0 identico a Velocmd e THIRD-PARTY-LICENSES.txt
// allineato a Cargo.lock. Controlli sul testo, senza cargo: un Cargo.lock aggiornato senza `npm run licenses` ferma
// npm test (e quindi la release) invece di pubblicare note di terze parti superate.

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

describe('licenses shipped with the release', () => {
  it('keeps LICENSE byte-identical to the one published by Velocmd (git blob 571170ef)', () => {
    const text = Buffer.from(read('LICENSE').replace(/\r\n/g, '\n'))
    const blob = createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex')
    assert.equal(blob, '571170ef42a33a57853c7a820e21c74b2fe58697')
  })

  it('shows the GPL in both installers', () => {
    assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).bundle.licenseFile, '../LICENSE')
  })

  it('has THIRD-PARTY-LICENSES.txt generated from the current Cargo.lock and notices', () => {
    const recorded = /^Inputs: sha256 ([0-9a-f]{64}) /m.exec(read(licensesFile))?.[1]
    assert.equal(recorded, inputsFingerprint(root), `${licensesFile} is out of date: run npm run licenses`)
  })

  it('lists the crates of the executable with their licenses, and the interface notices', () => {
    const text = read(licensesFile)
    const lock = read('src-tauri/Cargo.lock')
    for (const name of ['tauri', 'wry', 'tao', 'serde_json', 'jwalk', 'systemicons', 'bincode', 'image']) {
      const versions = [...lock.matchAll(new RegExp(`\\nname = "${name}"\\r?\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1])
      assert.ok(versions.length > 0, `${name} in Cargo.lock`)
      assert.ok(
        versions.some((version) => new RegExp(`^${name} ${version.replaceAll('.', '\\.')} - \\S`, 'm').test(text)),
        `${name} ${versions.join('/')} in ${licensesFile}`
      )
    }
    assert.doesNotMatch(text, /^rocket-launcher /m, 'the app itself is GPL-3.0, not a third party')
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/i)
    assert.match(text, /ISC License/)
    assert.match(text, /Apache License\s+Version 2\.0/)
  })
})
