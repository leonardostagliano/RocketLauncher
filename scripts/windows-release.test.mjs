import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { UPDATE_REPOSITORY } from '../src/update-source.js'
import {
  assertMsiVersion,
  assertUpdateRepository,
  bundleOutputNames,
  cargoReleaseDirectory,
  checksumManifest,
  checksumManifestName,
  collectArtifacts,
  compareVersions,
  getBump,
  incrementVersion,
  newestStableTag,
  packageFile,
  planRelease,
  readBaseVersion,
  releaseAssetNames,
  releaseContractProblems,
  releaseNotes,
  stageArtifacts,
  tauriBuildArgs,
  tauriConfigFile,
  verifyChecksumManifest,
  writeChecksumManifest
} from './windows-release.mjs'

const repositoryRoot = join(import.meta.dirname, '..')
const manifest = (version) => `${JSON.stringify({ name: 'rocketlauncher', private: true, version }, null, 2)}\n`
const tauriConfig = (version = '../package.json') =>
  `${JSON.stringify({ productName: 'RocketLauncher', version, identifier: 'it.stagliano.rocketlauncher' }, null, 2)}\n`
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

describe('getBump', () => {
  it('maps a feat commit to a minor bump', () => {
    assert.equal(getBump(['feat: add the calculator mode']), 'minor')
    assert.equal(getBump(['feat(search): rank recent files first']), 'minor')
  })

  it('maps a breaking marker to a major bump, whichever commit carries it', () => {
    assert.equal(getBump(['fix: typo', 'feat!: drop the legacy index format']), 'major')
    assert.equal(getBump(['refactor(core)!: rename the Tauri commands']), 'major')
    assert.equal(getBump(['chore: bump deps\n\nBREAKING CHANGE: settings move']), 'major')
    assert.equal(getBump(['chore: bump deps\n\nBREAKING-CHANGE: settings move']), 'major')
  })

  it('falls back to a patch bump, also for non-conventional upstream messages', () => {
    assert.equal(getBump(['fix: shortcut not restored']), 'patch')
    assert.equal(getBump(['chore: tidy up', 'docs: readme']), 'patch')
    assert.equal(getBump(['Velocmd Pages', 'v0.1.8 Release Notes', 'Medium fix']), 'patch')
    assert.equal(getBump([]), 'patch')
  })

  it('reads a header hidden in a squash commit body', () => {
    assert.equal(getBump(['chore: squash\n\nfeat: add the Italian UI\nfix: guard']), 'minor')
  })

  it('does not treat a mention of feat inside a sentence as a feature', () => {
    assert.equal(getBump(['fix: handle the feat: prefix in titles']), 'patch')
  })

  it('keeps the rebrand a major bump when GitHub squashes the fork branch into one commit', () => {
    // GitHub antepone "* " alla prima riga di ogni commit, ma il footer BREAKING CHANGE resta a inizio riga.
    const squash = [
      'RocketLauncher (#1)',
      '',
      '* feat!: rename Velocmd to RocketLauncher',
      '',
      'BREAKING CHANGE: the application identifier is now it.stagliano.rocketlauncher',
      '',
      '* fix: keep power confirmations out of recents'
    ].join('\n')
    assert.equal(getBump([squash]), 'major')
  })

  it('does not bump beyond patch for ci, build, test, docs or chore commits', () => {
    const tooling = [
      'ci: build and publish Windows releases from main',
      'build: derive every version from package.json',
      'test: cover the fork baseline',
      'docs: add RELEASE.md'
    ]
    assert.equal(getBump(tooling), 'patch')
  })
})

describe('incrementVersion', () => {
  it('increments and resets the lower fields', () => {
    assert.equal(incrementVersion('1.4.7', 'major'), '2.0.0')
    assert.equal(incrementVersion('1.4.7', 'minor'), '1.5.0')
    assert.equal(incrementVersion('1.4.7', 'patch'), '1.4.8')
  })

  it('rejects an unstable version or an unknown bump', () => {
    assert.throws(() => incrementVersion('1.4.7-rc.1', 'patch'))
    assert.throws(() => incrementVersion('01.4.7', 'patch'))
    assert.throws(() => incrementVersion('1.4.7', 'huge'))
  })
})

describe('compareVersions', () => {
  it('orders versions numerically', () => {
    assert.ok(compareVersions('0.2.0', '0.10.0') < 0)
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  })

  it('rejects a version that is not stable SemVer', () => {
    assert.throws(() => compareVersions('1.0', '1.0.0'))
    assert.throws(() => compareVersions('1.0.0', 'v1.0.0'))
  })
})

describe('assertMsiVersion', () => {
  it('accepts the largest version WiX can encode', () => {
    assert.equal(assertMsiVersion('255.255.65535'), '255.255.65535')
    assert.equal(assertMsiVersion('0.2.0'), '0.2.0')
  })

  it('rejects a major or minor above 255 and a patch above 65535', () => {
    for (const version of ['256.0.0', '0.256.0', '0.0.65536']) {
      assert.throws(() => assertMsiVersion(version), /MSI/, version)
    }
    assert.throws(() => assertMsiVersion('1.0.0-rc.1'), /SemVer stabile/)
  })
})

describe('newestStableTag', () => {
  it('picks the highest stable tag by SemVer, not by name', () => {
    assert.equal(newestStableTag(['v0.1.9', 'v0.1.10', 'v0.1.2']), 'v0.1.10')
  })

  it('ignores pre-releases, leading zeros and foreign tags', () => {
    assert.equal(newestStableTag(['v0.1.8', 'v0.2.0-rc.1', 'v01.0.0', 'nightly', '0.9.0']), 'v0.1.8')
    assert.equal(newestStableTag(['nightly']), null)
    assert.equal(newestStableTag([]), null)
  })
})

describe('readBaseVersion', () => {
  let dir = ''

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocketlauncher-version-'))
    mkdirSync(join(dir, 'src-tauri'))
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads package.json when tauri.conf.json defers to it', () => {
    writeFileSync(join(dir, packageFile), manifest('0.1.8'))
    writeFileSync(join(dir, tauriConfigFile), tauriConfig())
    assert.equal(readBaseVersion(dir), '0.1.8')
  })

  it('tolerates a UTF-8 BOM and CRLF line endings', () => {
    writeFileSync(join(dir, packageFile), `﻿${manifest('0.4.2').replace(/\n/g, '\r\n')}`)
    assert.equal(readBaseVersion(dir), '0.4.2')
  })

  it('rejects a literal version in tauri.conf.json: package.json must be the only source', () => {
    writeFileSync(join(dir, packageFile), manifest('0.1.8'))
    writeFileSync(join(dir, tauriConfigFile), tauriConfig('0.1.8'))
    assert.throws(() => readBaseVersion(dir), /unica fonte/)
    writeFileSync(join(dir, tauriConfigFile), tauriConfig())
  })

  it('rejects a pre-release, metadata, leading zeros or a missing version', () => {
    for (const value of ['0.2.0-beta.1', '0.2.0+abc', '0.02.0', '1.0', '1.0.0.0', '', undefined]) {
      writeFileSync(join(dir, packageFile), manifest(value))
      assert.throws(() => readBaseVersion(dir), /SemVer stabile/, String(value))
    }
    writeFileSync(join(dir, packageFile), manifest('0.1.8'))
  })

  it('explains a missing file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'rocketlauncher-empty-'))
    try {
      assert.throws(() => readBaseVersion(empty), /Impossibile leggere package\.json/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('matches the version committed in this repository', () => {
    assert.match(readBaseVersion(repositoryRoot), /^\d+\.\d+\.\d+$/)
  })
})

describe('release contract', () => {
  const committed = () => readJson(join(repositoryRoot, tauriConfigFile))

  it('is satisfied by the committed tauri.conf.json', () => {
    assert.deepEqual(releaseContractProblems(committed()), [])
  })

  it('accepts it-IT as a string, a one-item list or a localized map', () => {
    const config = committed()
    for (const language of ['it-IT', ['it-IT'], { 'it-IT': { localePath: 'wix/it-IT.wxl' } }]) {
      config.bundle.windows.wix.language = language
      assert.deepEqual(releaseContractProblems(config), [], JSON.stringify(language))
    }
    config.bundle.windows.wix.language = { 'it-IT': {}, 'en-US': {} }
    assert.match(releaseContractProblems(config).join('\n'), /wix\.language/)
  })

  it('names every deviation that would change file names, installer language or MSI identity', () => {
    const config = committed()
    config.productName = 'Rocket Launcher'
    config.bundle.windows.wix.language = ['en-US', 'it-IT']
    delete config.bundle.windows.wix.upgradeCode
    config.bundle.windows.nsis.languages = ['English', 'Italian']
    config.bundle.targets = 'all'
    const problems = releaseContractProblems(config).join('\n')
    for (const key of ['productName', 'wix.language', 'upgradeCode', 'nsis.languages', 'bundle.targets']) {
      assert.match(problems, new RegExp(key.replace('.', '\\.')), key)
    }
  })

  it('publishes only to the repository the app checks for updates', () => {
    assert.doesNotThrow(() => assertUpdateRepository(UPDATE_REPOSITORY))
    assert.doesNotThrow(() => assertUpdateRepository(UPDATE_REPOSITORY.toUpperCase()))
    assert.throws(() => assertUpdateRepository('someone/RocketLauncher'), /UPDATE_REPOSITORY/)
    assert.throws(() => assertUpdateRepository('YashvardhanG/Velocmd'), /UPDATE_REPOSITORY/)
  })

  it('declares the npm scripts used locally and in CI', () => {
    const scripts = readJson(join(repositoryRoot, packageFile)).scripts
    assert.match(scripts['build:win'], /tauri build --bundles nsis,msi/)
    // Glob espansi da Node (anche sotto cmd.exe): ogni nuovo *.test.mjs entra nella CI senza toccare il workflow.
    assert.match(scripts.test, /^node --test "scripts\/\*\.test\.mjs" "tests\/\*\.test\.mjs"$/)
  })

  it('finds the Tauri outputs in CARGO_TARGET_DIR when it is set, and only as an absolute path', () => {
    const cwd = join(tmpdir(), 'rocketlauncher-checkout')
    assert.equal(cargoReleaseDirectory({}, cwd), join(cwd, 'src-tauri', 'target', 'release'))
    const custom = join(tmpdir(), 'rocketlauncher-target')
    assert.equal(cargoReleaseDirectory({ CARGO_TARGET_DIR: custom }, cwd), join(custom, 'release'))
    assert.throws(() => cargoReleaseDirectory({ CARGO_TARGET_DIR: 'target' }, cwd), /assoluto/)
  })

  it('passes the computed version to tauri build as an inline JSON patch, with a locked Cargo build', () => {
    const args = tauriBuildArgs('0.2.0')
    assert.deepEqual(args.slice(0, 4), ['build', '--ci', '--bundles', 'nsis,msi'])
    assert.deepEqual(JSON.parse(args[args.indexOf('--config') + 1]), { version: '0.2.0' })
    assert.deepEqual(args.slice(-2), ['--', '--locked'])
    assert.throws(() => tauriBuildArgs('0.256.0'), /MSI/)
  })
})

describe('release artifacts', () => {
  let dir = ''
  let target = ''
  let output = ''
  const put = (path, content = 'MZ payload') => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rocketlauncher-artifacts-'))
    target = join(dir, 'target', 'release')
    output = join(dir, 'release')
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names the three assets and the Tauri bundle outputs exactly', () => {
    assert.deepEqual(releaseAssetNames('1.2.3'), {
      setup: 'RocketLauncher-1.2.3-win-x64-setup.exe',
      msi: 'RocketLauncher-1.2.3-win-x64.msi',
      portable: 'RocketLauncher-1.2.3-win-x64-portable.exe'
    })
    assert.deepEqual(bundleOutputNames('1.2.3'), {
      nsis: 'RocketLauncher_1.2.3_x64-setup.exe',
      msi: 'RocketLauncher_1.2.3_x64_it-IT.msi',
      binary: 'RocketLauncher.exe'
    })
    assert.throws(() => releaseAssetNames('1.2.3-rc.1'))
    assert.throws(() => bundleOutputNames('v1.2.3'))
  })

  it('stages exactly one output per bundle folder under the asset names', () => {
    assert.throws(
      () => stageArtifacts({ targetDirectory: target, outputDirectory: output, version: '1.2.3' }),
      /Impossibile leggere/
    )
    put(join(target, 'bundle', 'nsis', 'RocketLauncher_1.2.3_x64-setup.exe'), 'MZ setup')
    put(join(target, 'bundle', 'msi', 'RocketLauncher_1.2.3_x64_it-IT.msi'), 'MSI package')
    assert.throws(
      () => stageArtifacts({ targetDirectory: target, outputDirectory: output, version: '1.2.3' }),
      /Manca l'eseguibile/
    )
    put(join(target, 'RocketLauncher.exe'), 'MZ portable')
    assert.deepEqual(stageArtifacts({ targetDirectory: target, outputDirectory: output, version: '1.2.3' }), [
      'RocketLauncher-1.2.3-win-x64-portable.exe',
      'RocketLauncher-1.2.3-win-x64-setup.exe',
      'RocketLauncher-1.2.3-win-x64.msi'
    ])
    assert.equal(readFileSync(join(output, 'RocketLauncher-1.2.3-win-x64.msi'), 'utf8'), 'MSI package')
  })

  it('refuses a leftover of another version or another installer language', () => {
    const stage = () => stageArtifacts({ targetDirectory: target, outputDirectory: join(dir, 'other'), version: '1.2.3' })
    put(join(target, 'bundle', 'nsis', 'RocketLauncher_1.2.2_x64-setup.exe'))
    assert.throws(stage, /Atteso esattamente RocketLauncher_1\.2\.3_x64-setup\.exe .*1\.2\.2/)
    rmSync(join(target, 'bundle', 'nsis', 'RocketLauncher_1.2.2_x64-setup.exe'))
    rmSync(join(target, 'bundle', 'msi', 'RocketLauncher_1.2.3_x64_it-IT.msi'))
    put(join(target, 'bundle', 'msi', 'RocketLauncher_1.2.3_x64_en-US.msi'))
    assert.throws(stage, /it-IT\.msi .*en-US/)
    assert.throws(
      () => stageArtifacts({ targetDirectory: target, outputDirectory: output, version: '1.2.4' }),
      /Atteso esattamente/
    )
  })

  it('requires exactly the three files of the planned version', () => {
    assert.equal(collectArtifacts(output, '1.2.3').length, 3)
    assert.throws(() => collectArtifacts(output, '1.2.4'), /Attesi esattamente/)
    writeFileSync(join(output, 'RocketLauncher.exe'), 'MZ stray')
    assert.throws(() => collectArtifacts(output, '1.2.3'), /Attesi esattamente/)
    rmSync(join(output, 'RocketLauncher.exe'))
    writeFileSync(join(output, 'RocketLauncher-1.2.3-win-x64.msi'), '')
    assert.throws(() => collectArtifacts(output, '1.2.3'), /vuoto/)
    writeFileSync(join(output, 'RocketLauncher-1.2.3-win-x64.msi'), 'MSI package')
    writeFileSync(join(output, 'SHA256SUMS.txt'), 'ignored by the artifact check')
    assert.equal(collectArtifacts(output, '1.2.3').length, 3)
  })

  it('writes a sha256sum manifest with one LF-terminated line per file', () => {
    const files = collectArtifacts(output, '1.2.3')
    const text = checksumManifest(output, files)
    const hash = (name) => createHash('sha256').update(readFileSync(join(output, name))).digest('hex')
    assert.equal(text, files.map((name) => `${hash(name)}  ${name}\n`).join(''))
    for (const line of text.trimEnd().split('\n')) assert.match(line, /^[a-f0-9]{64} {2}\S+$/)
    assert.deepEqual(readdirSync(output).filter((name) => name.endsWith('.txt')), ['SHA256SUMS.txt'])
  })

  it('writes SHA256SUMS.txt at stage time and refuses to publish files it does not describe', () => {
    const files = collectArtifacts(output, '1.2.3')
    const text = writeChecksumManifest(output, '1.2.3')
    assert.equal(readFileSync(join(output, checksumManifestName), 'utf8'), text)
    assert.doesNotThrow(() => verifyChecksumManifest(output, files))
    writeFileSync(join(output, 'RocketLauncher-1.2.3-win-x64-portable.exe'), 'MZ replaced after the smoke test')
    assert.throws(() => verifyChecksumManifest(output, files), /non corrisponde/)
    rmSync(join(output, checksumManifestName))
    assert.throws(() => verifyChecksumManifest(output, files), /Manca SHA256SUMS\.txt/)
    writeChecksumManifest(output, '1.2.3')
    assert.doesNotThrow(() => verifyChecksumManifest(output, files))
  })

  it('writes Italian release notes with the three assets, update steps and the SmartScreen note', () => {
    const notes = releaseNotes(
      {
        version: '0.3.0',
        tag: 'v0.3.0',
        baseVersion: '0.2.4',
        bump: 'minor',
        sha: 'a'.repeat(40),
        previousTag: 'v0.2.4',
        baseline: null,
        commits: [
          { sha: 'b'.repeat(40), message: 'feat: add the Italian UI\n\nCorpo del commit.' },
          { sha: 'c'.repeat(40), message: 'fix: shortcut not restored' }
        ]
      },
      'owner/RocketLauncher'
    )
    assert.match(notes, /Versione \*\*0\.3\.0\*\*: incremento \*\*minor\*\* da 0\.2\.4\./)
    assert.match(notes, /^- feat: add the Italian UI \(bbbbbbb\)$/m)
    assert.match(notes, /^- fix: shortcut not restored \(ccccccc\)$/m)
    assert.doesNotMatch(notes, /Corpo del commit/)
    assert.match(notes, /compare\/v0\.2\.4\.\.\.v0\.3\.0/)
    assert.match(notes, /`RocketLauncher-0\.3\.0-win-x64-setup\.exe`: installer/)
    assert.match(notes, /`RocketLauncher-0\.3\.0-win-x64\.msi`: pacchetto MSI/)
    assert.match(notes, /`RocketLauncher-0\.3\.0-win-x64-portable\.exe`: eseguibile singolo/)
    assert.match(notes, /`SHA256SUMS\.txt`/)
    assert.match(notes, /## Aggiornamento/)
    assert.match(notes, /"Controlla aggiornamenti"/)
    assert.match(notes, /%APPDATA%\\it\.stagliano\.rocketlauncher/)
    assert.match(notes, /SmartScreen/)
    assert.match(notes, /Velocmd\]\(https:\/\/github\.com\/YashvardhanG\/Velocmd\) di Yashvardhan Gupta/)
    assert.doesNotMatch(notes, /Prima release di RocketLauncher/)
  })

  it('introduces the first fork release relative to the Velocmd baseline', () => {
    const first = releaseNotes(
      { version: '0.2.0', tag: 'v0.2.0', baseVersion: '0.1.8', bump: 'minor', sha: 'a'.repeat(40), previousTag: 'v0.1.8', baseline: 'v0.1.8', commits: [] },
      'owner/RocketLauncher'
    )
    assert.match(first, /Prima release di RocketLauncher: .*Velocmd v0\.1\.8/)
    assert.match(first, /impostazioni, elementi recenti e indice di Velocmd non vengono importati/)
    assert.match(first, /compare\/v0\.1\.8\.\.\.v0\.2\.0/)
    const orphan = releaseNotes(
      { version: '0.2.0', tag: 'v0.2.0', baseVersion: '0.1.8', bump: 'minor', sha: 'a'.repeat(40), previousTag: null, baseline: null, commits: [] },
      'owner/RocketLauncher'
    )
    assert.doesNotMatch(orphan, /Confronto completo/)
  })
})

// Un solo repository usa-e-getta serve tutti gli scenari: su Windows git e' abbastanza lento da rendere dominante la
// ricostruzione della fixture per ogni test. planRelease e' in sola lettura, quindi gli scenari differiscono solo per
// lo `sha` da cui si pianifica e per le release passate (package.json viene riscritto e ripristinato da pochi test).
//
//   chore: initial import          (package.json 0.1.0, tauri.conf.json -> ../package.json)
//   fix: first fix                 tag v0.1.1  (come i tag di Velocmd copiati nel fork)
//   feat: second feature           tag v0.2.0-rc.1 e nightly (da ignorare)
//   fix: third fix
//   divergent, da initial: fix: parallel work
describe('planRelease', () => {
  const PUBLISHED_V011 = { tag_name: 'v0.1.1', draft: false, prerelease: false }
  let repo = ''
  let sha = {}

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rocketlauncher-release-'))
    const git = (...args) =>
      execFileSync(
        'git',
        ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'RocketLauncher Test',
            GIT_AUTHOR_EMAIL: 'test@example.invalid',
            GIT_COMMITTER_NAME: 'RocketLauncher Test',
            GIT_COMMITTER_EMAIL: 'test@example.invalid'
          }
        }
      ).trim()
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { encoding: 'utf8' })
    mkdirSync(join(repo, 'src-tauri'))
    writeFileSync(join(repo, packageFile), manifest('0.1.0'))
    writeFileSync(join(repo, tauriConfigFile), tauriConfig())
    git('add', '--', packageFile, tauriConfigFile)
    git('commit', '-q', '-m', 'chore: initial import')
    // Commit vuoti per tenere veloce la fixture: si leggono solo la cronologia e i due manifest.
    const commit = (message) => git('commit', '-q', '--allow-empty', '-m', message)
    commit('fix: first fix')
    git('tag', 'v0.1.1')
    commit('feat: second feature')
    git('tag', 'v0.2.0-rc.1')
    git('tag', 'nightly')
    commit('fix: third fix')
    git('checkout', '-q', '-b', 'divergent', 'v0.1.1~1')
    commit('fix: parallel work')
    const history = git('log', '--format=%H %s', '--all').split('\n')
    const find = (subject) => history.find((line) => line.endsWith(subject)).split(' ')[0]
    sha = {
      initial: find('chore: initial import'),
      firstFix: find('fix: first fix'),
      secondFeature: find('feat: second feature'),
      thirdFix: find('fix: third fix'),
      divergent: find('fix: parallel work')
    }
  })

  after(() => {
    // Su Windows gli oggetti Git sono in sola lettura e un antivirus puo' tenerli aperti per un attimo.
    rmSync(repo, { recursive: true, force: true, maxRetries: 5 })
  })

  const withManifest = (version, action) => {
    const path = join(repo, packageFile)
    const original = readFileSync(path, 'utf8')
    try {
      writeFileSync(path, manifest(version))
      return action()
    } finally {
      writeFileSync(path, original)
    }
  }

  it('starts the first fork release from the newest reachable upstream tag', () => {
    const plan = planRelease({ cwd: repo, releases: [], sha: sha.thirdFix })
    assert.equal(plan.skip, false)
    assert.equal(plan.sha, sha.thirdFix)
    assert.equal(plan.baseline, 'v0.1.1')
    assert.equal(plan.previousTag, 'v0.1.1')
    assert.equal(plan.baseVersion, '0.1.1')
    assert.equal(plan.bump, 'minor')
    assert.equal(plan.version, '0.2.0')
    assert.equal(plan.tag, 'v0.2.0')
    assert.deepEqual(
      plan.commits.map((entry) => entry.message),
      ['feat: second feature', 'fix: third fix']
    )
  })

  it('skips when HEAD is exactly the upstream baseline: there is nothing to release', () => {
    const plan = planRelease({ cwd: repo, releases: [], sha: sha.firstFix })
    assert.deepEqual(plan, { skip: true, tag: 'v0.1.1', sha: sha.firstFix })
  })

  it('uses the whole history when no stable tag is reachable, from the manifest version', () => {
    const plan = withManifest('1.0.0', () => planRelease({ cwd: repo, releases: [], sha: sha.initial }))
    assert.equal(plan.baseline, null)
    assert.equal(plan.previousTag, null)
    assert.equal(plan.baseVersion, '1.0.0')
    assert.equal(plan.version, '1.0.1')
    assert.deepEqual(plan.commits.map((entry) => entry.sha), [sha.initial])
  })

  it('keeps the manifest version as the base when it is ahead of the upstream baseline', () => {
    const plan = withManifest('0.5.0', () => planRelease({ cwd: repo, releases: [], sha: sha.secondFeature }))
    assert.equal(plan.baseline, 'v0.1.1')
    assert.equal(plan.baseVersion, '0.5.0')
    assert.equal(plan.version, '0.6.0')
  })

  it('skips when HEAD is already contained in a published release', () => {
    const plan = planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.firstFix })
    assert.deepEqual(plan, { skip: true, tag: 'v0.1.1', sha: sha.firstFix })
    const older = planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.initial })
    assert.deepEqual(older, { skip: true, tag: 'v0.1.1', sha: sha.initial })
  })

  it('counts only the commits after the last published release, ignoring the baseline', () => {
    const plan = planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.thirdFix })
    assert.equal(plan.skip, false)
    assert.equal(plan.baseline, null)
    assert.equal(plan.baseVersion, '0.1.1')
    assert.equal(plan.bump, 'minor')
    assert.equal(plan.version, '0.2.0')
    assert.equal(plan.previousTag, 'v0.1.1')
    assert.deepEqual(
      plan.commits.map((entry) => entry.message),
      ['feat: second feature', 'fix: third fix']
    )
  })

  it('throws when HEAD does not descend from the last published release', () => {
    assert.throws(
      () => planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.divergent }),
      /non discende/
    )
  })

  it('skips a version already reserved by another release', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [
        PUBLISHED_V011,
        { tag_name: 'v0.2.0', draft: true, prerelease: false, target_commitish: 'another-commit' }
      ],
      sha: sha.thirdFix
    })
    assert.equal(plan.version, '0.2.1')
    assert.equal(plan.tag, 'v0.2.1')
  })

  it('resumes the draft left by an interrupted run of the same commit', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [
        PUBLISHED_V011,
        { tag_name: 'v0.2.0', draft: true, prerelease: false, target_commitish: sha.thirdFix }
      ],
      sha: sha.thirdFix
    })
    assert.equal(plan.version, '0.2.0')
    assert.equal(plan.tag, 'v0.2.0')
  })

  it('resumes an interrupted first fork release without moving the baseline', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [{ tag_name: 'v0.2.0', draft: true, prerelease: false, target_commitish: sha.thirdFix }],
      sha: sha.thirdFix
    })
    assert.equal(plan.baseline, 'v0.1.1')
    assert.equal(plan.version, '0.2.0')
  })

  it('accepts an existing tag only for the recoverable draft of this commit', () => {
    const draft = (target) => ({ tag_name: 'v0.1.1', draft: true, prerelease: false, target_commitish: target })
    const plan = planRelease({ cwd: repo, releases: [draft(sha.firstFix)], sha: sha.firstFix })
    assert.equal(plan.skip, false)
    assert.equal(plan.version, '0.1.1')
    assert.equal(plan.baseline, null, 'a tag claimed by a release of this repository is never the upstream baseline')
    assert.throws(
      () => planRelease({ cwd: repo, releases: [draft(sha.secondFeature)], sha: sha.secondFeature }),
      /Il tag v0\.1\.1 esiste già/
    )
  })

  it('throws when the computed tag already exists outside the history of HEAD', () => {
    assert.throws(
      () => planRelease({ cwd: repo, releases: [], sha: sha.divergent }),
      /Il tag v0\.1\.1 esiste già/
    )
  })

  it('refuses a draft of this commit that does not move past the base version', () => {
    assert.throws(
      () =>
        planRelease({
          cwd: repo,
          releases: [{ tag_name: 'v0.1.0', draft: true, prerelease: false, target_commitish: sha.initial }],
          sha: sha.initial
        }),
      /precede la versione di base/
    )
  })

  it('ignores pre-releases and tags that are not stable versions', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [
        { tag_name: 'v9.0.0', draft: false, prerelease: true },
        { tag_name: 'v1.0.0-rc.1', draft: false, prerelease: false },
        { tag_name: 'nightly', draft: false, prerelease: false }
      ],
      sha: sha.secondFeature
    })
    assert.equal(plan.version, '0.2.0')
    assert.equal(plan.baseline, 'v0.1.1')
    assert.deepEqual(plan.commits.map((entry) => entry.message), ['feat: second feature'])
  })

  it('uses the manifest version as the base when it is ahead of the last release', () => {
    withManifest('1.0.0', () => {
      const plan = planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.thirdFix })
      assert.equal(plan.baseVersion, '1.0.0')
      assert.equal(plan.version, '1.1.0')
      assert.equal(plan.previousTag, 'v0.1.1')
    })
    withManifest('1.0.0-preview.1', () =>
      assert.throws(
        () => planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.thirdFix }),
        /SemVer stabile/
      )
    )
  })

  it('refuses a version that the MSI cannot encode', () => {
    withManifest('0.255.3', () =>
      assert.throws(() => planRelease({ cwd: repo, releases: [PUBLISHED_V011], sha: sha.thirdFix }), /MSI/)
    )
  })
})

// La cronologia reale del fork: i tag di Velocmd v0.1.0..v0.1.8 copiati da GitHub (senza release), alcuni commit di
// upstream successivi a v0.1.8 con messaggi non convenzionali e un merge, poi i commit di RocketLauncher a partire dal
// rebrand `feat!:` con footer BREAKING CHANGE (nuovo identificatore, dati di Velocmd non importati).
//
//   Initial commit                       tag v0.1.0   (package.json 0.1.8: la base resta quella di upstream)
//   v0.1.N Release Notes (N = 1..8)      tag v0.1.N
//   Velocmd Pages  +  File-Explorer Feature (ramo)  ->  Merge branch 'main' of https://github.com/YashvardhanG/Velocmd
//   feat!: rename Velocmd to RocketLauncher (BREAKING CHANGE)
//   fix: keep power confirmations and non-reopenable rows out of recents
//   build: derive every version from package.json
//   ci: build and publish Windows releases from main          <- primo push su main del fork
//   fix: follow-up after the first release                     <- push successivo
describe('planRelease on the RocketLauncher fork of Velocmd', () => {
  const upstreamSubjects = [
    'Velocmd Pages',
    'File-Explorer Feature',
    "Merge branch 'main' of https://github.com/YashvardhanG/Velocmd"
  ]
  const forkSubjects = [
    'feat!: rename Velocmd to RocketLauncher',
    'fix: keep power confirmations and non-reopenable rows out of recents',
    'build: derive every version from package.json',
    'ci: build and publish Windows releases from main'
  ]
  const upstreamTags = Array.from({ length: 9 }, (_, index) => `v0.1.${index}`)
  let repo = ''
  let git = () => ''
  const sha = {}
  const tagCommits = {}

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rocketlauncher-fork-'))
    git = (...args) =>
      execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'RocketLauncher Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'RocketLauncher Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid'
        }
      }).trim()
    const commit = (message) => {
      git('commit', '-q', '--allow-empty', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { encoding: 'utf8' })
    mkdirSync(join(repo, 'src-tauri'))
    writeFileSync(join(repo, packageFile), manifest('0.1.8'))
    writeFileSync(join(repo, tauriConfigFile), tauriConfig())
    git('add', '--', packageFile, tauriConfigFile)
    git('commit', '-q', '-m', 'Initial commit')
    tagCommits['v0.1.0'] = git('rev-parse', 'HEAD')
    for (let patch = 1; patch <= 8; patch += 1) tagCommits[`v0.1.${patch}`] = commit(`v0.1.${patch} Release Notes`)
    for (const [tag, commitSha] of Object.entries(tagCommits)) git('tag', tag, commitSha)
    sha.v018 = tagCommits['v0.1.8']
    commit('Velocmd Pages')
    git('checkout', '-q', '-b', 'upstream-side', 'v0.1.8')
    commit('File-Explorer Feature')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', upstreamSubjects[2], 'upstream-side')
    sha.upstreamHead = git('rev-parse', 'HEAD')
    sha.rebrand = commit(
      [
        forkSubjects[0],
        '',
        'Rebrand the fork of Velocmd v0.1.8 as RocketLauncher.',
        '',
        'BREAKING CHANGE: the application identifier is now it.stagliano.rocketlauncher, so Velocmd settings,',
        'recents and index cache are not imported.'
      ].join('\n')
    )
    sha.recentsFix = commit(forkSubjects[1])
    sha.buildCommit = commit(forkSubjects[2])
    sha.forkHead = commit(forkSubjects[3])
    sha.nextFix = commit('fix: follow-up after the first release')
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5 })
  })

  const subjects = (plan) => plan.commits.map((entry) => entry.message.split('\n')[0])
  // Solo per la durata di `action`: il tag che GitHub crea quando la release esce dalla bozza.
  const withTag = (tag, target, action) => {
    git('tag', tag, target)
    try {
      return action()
    } finally {
      git('tag', '-d', tag)
    }
  }

  it('releases the rebrand as 1.0.0, counting only the changes after Velocmd v0.1.8', () => {
    const plan = planRelease({ cwd: repo, releases: [], sha: sha.forkHead })
    assert.equal(plan.skip, false)
    assert.equal(plan.baseline, 'v0.1.8')
    assert.equal(plan.previousTag, 'v0.1.8')
    assert.equal(plan.baseVersion, '0.1.8')
    assert.equal(plan.bump, 'major')
    assert.equal(plan.version, '1.0.0')
    assert.equal(plan.tag, 'v1.0.0')
    assert.deepEqual([...subjects(plan)].sort(), [...upstreamSubjects, ...forkSubjects].sort())
    assert.deepEqual(subjects(plan).slice(-forkSubjects.length), forkSubjects)
  })

  it('writes first-release notes that start from Velocmd v0.1.8 and compare v0.1.8...v1.0.0', () => {
    const plan = planRelease({ cwd: repo, releases: [], sha: sha.forkHead })
    const notes = releaseNotes(plan, UPDATE_REPOSITORY)
    assert.match(notes, /Versione \*\*1\.0\.0\*\*: incremento \*\*major\*\* da 0\.1\.8\./)
    assert.match(notes, /Prima release di RocketLauncher: le modifiche elencate partono da Velocmd v0\.1\.8 di Yashvardhan Gupta\./)
    assert.match(notes, /impostazioni, elementi recenti e indice di Velocmd non vengono importati/)
    assert.match(notes, /compare\/v0\.1\.8\.\.\.v1\.0\.0\)/)
    assert.match(notes, /^- feat!: rename Velocmd to RocketLauncher \([0-9a-f]{7}\)$/m)
    assert.match(notes, /^- Velocmd Pages \([0-9a-f]{7}\)$/m)
    assert.doesNotMatch(notes, /Release Notes \(|Initial commit/, 'history up to v0.1.8 is Velocmd, not this release')
    assert.doesNotMatch(notes, /BREAKING CHANGE/, 'only the first line of each commit is listed')
    assert.match(notes, /`RocketLauncher-1\.0\.0-win-x64-setup\.exe`/)
  })

  it('skips a push of pure Velocmd code at the baseline tag', () => {
    assert.deepEqual(planRelease({ cwd: repo, releases: [], sha: sha.v018 }), {
      skip: true,
      tag: 'v0.1.8',
      sha: sha.v018
    })
  })

  it('resumes the draft of an interrupted first release on a rerun of the same commit', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [{ tag_name: 'v1.0.0', draft: true, prerelease: false, target_commitish: sha.forkHead }],
      sha: sha.forkHead
    })
    assert.equal(plan.skip, false)
    assert.equal(plan.version, '1.0.0')
    assert.equal(plan.baseline, 'v0.1.8')
    assert.equal(plan.previousTag, 'v0.1.8')
  })

  it('leaves the draft of another commit alone and releases 1.0.1 with all changes since v0.1.8', () => {
    const plan = planRelease({
      cwd: repo,
      releases: [{ tag_name: 'v1.0.0', draft: true, prerelease: false, target_commitish: sha.rebrand }],
      sha: sha.forkHead
    })
    assert.equal(plan.version, '1.0.1')
    assert.equal(plan.bump, 'major')
    assert.equal(plan.baseline, 'v0.1.8')
    assert.deepEqual(subjects(plan).slice(-forkSubjects.length), forkSubjects)
  })

  it('never releases again once 1.0.0 is published: reruns and older commits skip', () => {
    const published = [{ tag_name: 'v1.0.0', draft: false, prerelease: false }]
    withTag('v1.0.0', sha.forkHead, () => {
      for (const commit of [sha.forkHead, sha.rebrand, sha.upstreamHead]) {
        assert.deepEqual(planRelease({ cwd: repo, releases: published, sha: commit }), {
          skip: true,
          tag: 'v1.0.0',
          sha: commit
        })
      }
    })
  })

  it('bumps the next push after 1.0.0 from the published release, without the Velocmd baseline', () => {
    const published = [{ tag_name: 'v1.0.0', draft: false, prerelease: false }]
    const plan = withTag('v1.0.0', sha.forkHead, () => planRelease({ cwd: repo, releases: published, sha: sha.nextFix }))
    assert.equal(plan.baseline, null)
    assert.equal(plan.previousTag, 'v1.0.0')
    assert.equal(plan.baseVersion, '1.0.0')
    assert.equal(plan.bump, 'patch')
    assert.equal(plan.version, '1.0.1')
    assert.deepEqual(subjects(plan), ['fix: follow-up after the first release'])
    assert.doesNotMatch(releaseNotes(plan, UPDATE_REPOSITORY), /Prima release/)
  })

  it('still releases 1.0.0 when the fork was created without the Velocmd tags', () => {
    for (const tag of upstreamTags) git('tag', '-d', tag)
    try {
      const plan = planRelease({ cwd: repo, releases: [], sha: sha.forkHead })
      assert.equal(plan.baseline, null)
      assert.equal(plan.previousTag, null)
      assert.equal(plan.baseVersion, '0.1.8')
      assert.equal(plan.version, '1.0.0')
      assert.ok(subjects(plan).includes('Initial commit'), 'without a baseline the notes cover the whole history')
    } finally {
      for (const tag of upstreamTags) git('tag', tag, tagCommits[tag])
    }
  })
})
