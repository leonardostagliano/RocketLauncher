import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { mainBinaryName, productName } from '../scripts/windows-release.mjs'

// Contratto del repository con la pipeline di rilascio (.github/workflows/windows-release.yml): unica fonte della
// versione, pacchetti NSIS/MSI in italiano, workflow e collegamento dell'app al controllo di rilascio. Controlli sul
// testo dei file, senza compilare: falliscono in pochi secondi invece che dopo un build Rust di un quarto d'ora.

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/^﻿/, '')
const readJson = (path) => JSON.parse(read(path))
const tauriConfig = () => readJson('src-tauri/tauri.conf.json')

/** Il blocco [section] di un file TOML semplice, fino alla sezione successiva. */
function tomlSection(text, section) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `[${section}]`)
  assert.notEqual(start, -1, `[${section}] mancante`)
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

/** UUID v5 (RFC 4122) nello spazio DNS: come tauri-bundler deriva l'upgrade code MSI predefinito. */
function uuidV5Dns(name) {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const hash = createHash('sha1').update(namespace).update(name, 'utf8').digest().subarray(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

describe('single version source', () => {
  it('keeps the only literal version in package.json, as a stable SemVer base', () => {
    assert.match(readJson('package.json').version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
    assert.equal(tauriConfig().version, '../package.json')
  })

  it('freezes the Cargo package at 0.0.0 so a release never rewrites Cargo.toml or Cargo.lock', () => {
    assert.match(tomlSection(read('src-tauri/Cargo.toml'), 'package'), /^version = "0\.0\.0"$/m)
    const lock = read('src-tauri/Cargo.lock')
    assert.match(lock, /\[\[package\]\]\r?\nname = "rocket-launcher"\r?\nversion = "0\.0\.0"\r?\n/, 'Cargo.lock root entry')
  })

  it('aligns the VERSIONINFO strings with TAURI_CONFIG or package.json in build.rs', () => {
    const build = read('src-tauri/build.rs')
    assert.match(build, /env::var\("TAURI_CONFIG"\)/)
    assert.match(build, /\.\.\/package\.json/)
    assert.match(build, /env::set_var\("CARGO_PKG_VERSION", version\)/)
    assert.ok(
      build.indexOf('env::set_var("CARGO_PKG_VERSION"') < build.lastIndexOf('tauri_build::build()'),
      'CARGO_PKG_VERSION must be set before tauri_build::build() creates the resource'
    )
    assert.match(tomlSection(read('src-tauri/Cargo.toml'), 'build-dependencies'), /^serde_json = /m)
  })
})

describe('installer packaging', () => {
  it('builds only NSIS and MSI, both in Italian, with the Italian WiX strings file present', () => {
    const windows = tauriConfig().bundle.windows
    assert.deepEqual(tauriConfig().bundle.targets, ['nsis', 'msi'])
    assert.deepEqual(windows.nsis.languages, ['Italian'])
    const localePath = windows.wix.language['it-IT'].localePath
    const wxl = read(join('src-tauri', localePath))
    assert.match(wxl, /<WixLocalization Culture="it-it"/)
    for (const id of ['LaunchApp', 'DowngradeErrorMessage', 'PathEnvVarFeature', 'InstallAppFeature']) {
      assert.match(wxl, new RegExp(`<String Id="${id}">[^<]*RocketLauncher[^<]*</String>`), id)
    }
  })

  it('pins the MSI upgrade code Tauri derives for RocketLauncher, decoupled from later renames', () => {
    const config = tauriConfig()
    assert.equal(config.productName, productName)
    assert.equal(config.mainBinaryName, mainBinaryName)
    assert.equal(config.bundle.windows.wix.upgradeCode, uuidV5Dns(`${mainBinaryName}.exe.app.x64`))
    assert.equal(uuidV5Dns('python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d', 'RFC 4122 v5 reference value')
  })

  it('never commits staged release artifacts', () => {
    assert.match(read('.gitignore'), /^\/release\/$/m)
  })
})

describe('release workflow', () => {
  const workflow = read('.github/workflows/windows-release.yml')

  it('runs on the pinned Windows image, only for main, with full history and no persisted token', () => {
    assert.match(workflow, /^ {4}runs-on: windows-2022$/m)
    assert.match(workflow, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
    assert.match(workflow, /fetch-depth: 0/)
    assert.match(workflow, /persist-credentials: false/)
    assert.match(workflow, /^permissions:\r?\n {2}contents: write$/m)
  })

  it('pins every third-party action by commit and keeps runner.temp out of the job env', () => {
    for (const [, action, ref] of workflow.matchAll(/uses: ([^@\s]+)@(\S+)/g)) {
      if (!action.startsWith('actions/')) assert.match(ref, /^[0-9a-f]{40}$/, action)
    }
    const jobEnv = /^ {4}env:\r?\n((?: {6}.*\r?\n)+)/m.exec(workflow)?.[1] ?? ''
    assert.doesNotMatch(jobEnv, /runner\./)
  })

  it('tests, builds, stages, smoke-tests, checks the checkout and only then publishes', () => {
    const steps = [
      'node scripts/windows-release.mjs prepare',
      'npm ci',
      'npm test',
      'cargo test --locked',
      'node scripts/windows-release.mjs build',
      'node scripts/windows-release.mjs stage',
      'scripts/smoke-windows.ps1',
      'git status --porcelain --untracked-files=all',
      'node scripts/windows-release.mjs publish'
    ]
    const positions = steps.map((step) => workflow.indexOf(step))
    steps.forEach((step, index) => assert.notEqual(positions[index], -1, step))
    assert.deepEqual([...positions].sort((a, b) => a - b), positions)
    assert.doesNotMatch(workflow, /npm run [^\n]* -- /, 'pwsh drops -- when it calls npm.ps1')
  })

  it('runs every scripts/*.test.mjs and tests/*.test.mjs through npm test', () => {
    const test = readJson('package.json').scripts.test
    assert.equal(test, 'node --test "scripts/*.test.mjs" "tests/*.test.mjs"')
    assert.ok(readdirSync(join(root, 'scripts')).some((name) => name.endsWith('.test.mjs')))
  })
})

// Il collegamento dell'app al rilascio (src-tauri/src/main.rs, src/main.js, CSP) e' descritto con il codice esatto in
// handoff-release.md: questi test restano rossi finche' non viene applicato, cosi' nessuna release parte senza.
describe('app wiring for releases', () => {
  const frontendScripts = () =>
    readdirSync(join(root, 'src'), { recursive: true })
      .map((name) => String(name).replaceAll('\\', '/'))
      .filter((name) => name.endsWith('.js') && name !== 'update-source.js')

  it('handles the hidden --smoke flag in main.rs before any plugin, window or index starts', () => {
    const main = read('src-tauri/src/main.rs')
    assert.match(main, /strip_prefix\("--smoke="\)/)
    assert.match(main, /fn smoke_exit_code/)
    assert.match(main, /\.run\(context\)/, 'one generate_context!() shared by --smoke and the app')
    assert.equal(main.match(/generate_context!\(\)/g)?.length, 1)
    assert.ok(main.indexOf('strip_prefix("--smoke=")') < main.indexOf('tauri::Builder::default()'))
  })

  it('reads the installed version from getVersion() and checks updates through update-source.js', () => {
    const main = read('src/main.js')
    assert.match(main, /from ["']\.\/update-source\.js["']/)
    assert.match(main, /\bfindUpdate\b/)
    assert.match(main, /__TAURI__\.app\.getVersion\(\)/)
  })

  it('keeps the GitHub API, the fork URL and any hardcoded app version out of every other frontend script', () => {
    for (const name of frontendScripts()) {
      const text = read(join('src', name))
      assert.doesNotMatch(text, /api\.github\.com/, name)
      assert.doesNotMatch(text, /github\.com\/leonardostagliano\/RocketLauncher/i, name)
      assert.doesNotMatch(text, /CURRENT_VERSION\s*=\s*["'`]/, name)
    }
  })

  it('lets the update check reach api.github.com whenever a CSP is set', () => {
    const csp = tauriConfig().app?.security?.csp
    if (csp === null || csp === undefined) return
    const connect =
      typeof csp === 'string'
        ? (/(?:^|;)\s*connect-src\s+([^;]*)/.exec(csp)?.[1] ?? /(?:^|;)\s*default-src\s+([^;]*)/.exec(csp)?.[1] ?? '')
        : [csp['connect-src'] ?? csp['default-src'] ?? []].flat().join(' ')
    assert.match(connect, /(^|\s)https:\/\/api\.github\.com(\s|$)/, `connect-src: ${connect}`)
  })

  it('embeds the frontend files the --smoke check looks for', () => {
    for (const name of ['index.html', 'main.js', 'update-source.js', 'styles.css']) {
      assert.ok(existsSync(join(root, 'src', name)), name)
    }
  })
})
