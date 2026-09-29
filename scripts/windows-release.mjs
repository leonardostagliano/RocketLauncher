import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPDATE_REPOSITORY } from '../src/update-source.js'

// Rilascio Windows di RocketLauncher, eseguito dalla CI a ogni push su main.
//   prepare: calcola versione e tag dai conventional commit e dalle release GitHub (per la prima release del fork parte
//            dall'ultimo tag stabile di Velocmd raggiungibile), senza modificare alcun file del checkout.
//   build:   `tauri build` con la versione calcolata passata come patch JSON di --config (nessuna shell di mezzo).
//   stage:   copia setup NSIS, MSI ed eseguibile portable in release/ con i nomi stabili degli asset, scrive
//            SHA256SUMS.txt e aggiunge le licenze (LICENSE.txt, THIRD-PARTY-LICENSES.txt).
//   publish: ricontrolla SHA256SUMS.txt e le licenze, bozza, upload verificato, poi Latest.
//   plan:    solo in locale: la pianificazione di prepare senza GitHub (release da RELEASES_FILE, altrimenti nessuna)
//            e l'anteprima delle note; non scrive nulla su GitHub.

/** Base di versione: l'unico valore letterale. tauri.conf.json vi rimanda con "version": "../package.json". */
export const packageFile = 'package.json'
export const tauriConfigFile = 'src-tauri/tauri.conf.json'
export const tauriVersionReference = '../package.json'
export const productName = 'RocketLauncher'
export const mainBinaryName = 'RocketLauncher'
export const appIdentifier = 'it.stagliano.rocketlauncher'
export const msiLanguage = 'it-IT'
export const nsisLanguage = 'Italian'
export const checksumManifestName = 'SHA256SUMS.txt'
/**
 * Licenze pubblicate accanto agli eseguibili (nome dell'asset -> file del repository): il testo della GPL-3.0, che
 * anche i due installer mostrano (bundle.licenseFile), e le licenze di terze parti generate da `npm run licenses`.
 * Servono soprattutto a chi scarica il portable, che non ha un installer che le mostri.
 */
export const legalAssets = { 'LICENSE.txt': 'LICENSE', 'THIRD-PARTY-LICENSES.txt': 'THIRD-PARTY-LICENSES.txt' }
export const releaseDirectory = 'release'
export const tauriCli = 'node_modules/@tauri-apps/cli/tauri.js'

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function versionParts(version) {
  if (typeof version !== 'string' || !stableVersion.test(version))
    throw new Error(`Versione SemVer stabile non valida: ${version}`)
  return version.split('.').map(Number)
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function getBump(messages) {
  let bump = 'patch'
  for (const message of messages) {
    // Anche le righe successive: un commit di squash puo' contenere piu' intestazioni.
    if (
      /^[a-z][\w-]*(?:\([^\r\n)]+\))?!: .+/im.test(message) ||
      /^BREAKING[ -]CHANGE: .+/m.test(message)
    )
      return 'major'
    if (/^feat(?:\([^\r\n)]+\))?: .+/im.test(message)) bump = 'minor'
  }
  return bump
}

export function incrementVersion(version, bump) {
  const [major, minor, patch] = versionParts(version)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Incremento sconosciuto: ${bump}`)
}

/** WiX/MSI: major e minor al massimo 255, patch al massimo 65535 (validate_wix_version di tauri-bundler). */
export function assertMsiVersion(version) {
  const [major, minor, patch] = versionParts(version)
  if (major > 255 || minor > 255 || patch > 65535) {
    throw new Error(
      `La versione ${version} non è accettata dall'MSI: major e minor al massimo 255, patch al massimo 65535.`
    )
  }
  return version
}

/** Il tag stabile piu' recente per SemVer (v0.1.10 > v0.1.9); ignora pre-release, metadata e zeri iniziali. */
export function newestStableTag(names) {
  return (
    names
      .filter((name) => stableTag.test(name))
      .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0] ?? null
  )
}

function readJson(cwd, file) {
  let text
  try {
    text = readFileSync(resolve(cwd, file), 'utf8')
  } catch (error) {
    throw new Error(`Impossibile leggere ${file}: ${error.code ?? error.message}`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new Error(`${file} non è JSON valido: ${error.message}`)
  }
}

/**
 * Versione di base: `version` di package.json, SemVer stabile letterale. tauri.conf.json deve rimandarvi, altrimenti
 * esisterebbero due fonti (la CI sovrascrive comunque la chiave `version` della config con `tauri build --config`).
 */
export function readBaseVersion(cwd = process.cwd()) {
  const version = readJson(cwd, packageFile).version
  if (typeof version !== 'string' || !stableVersion.test(version))
    throw new Error(`${packageFile}: "version" non è una SemVer stabile MAJOR.MINOR.PATCH: ${version}`)
  const reference = readJson(cwd, tauriConfigFile).version
  if (reference !== tauriVersionReference) {
    throw new Error(
      `${tauriConfigFile}: "version" deve essere "${tauriVersionReference}" (unica fonte della versione), trovato ${JSON.stringify(reference)}.`
    )
  }
  return version
}

/** Scostamenti della config Tauri dal contratto di rilascio: nomi dei file, lingua degli installer, upgrade code MSI. */
export function releaseContractProblems(config) {
  const problems = []
  const expect = (label, actual, expected) => {
    if (actual !== expected)
      problems.push(`${label}: atteso ${JSON.stringify(expected)}, trovato ${JSON.stringify(actual)}`)
  }
  expect('productName', config?.productName, productName)
  expect('mainBinaryName', config?.mainBinaryName, mainBinaryName)
  expect('identifier', config?.identifier, appIdentifier)
  expect('version', config?.version, tauriVersionReference)
  const windows = config?.bundle?.windows
  // WiX accetta una stringa, una lista o una mappa lingua -> { localePath }: ogni lingua produce un MSI a parte.
  const wixLanguage = windows?.wix?.language
  const wixLanguages =
    typeof wixLanguage === 'string'
      ? [wixLanguage]
      : Array.isArray(wixLanguage)
        ? wixLanguage
        : wixLanguage && typeof wixLanguage === 'object'
          ? Object.keys(wixLanguage)
          : []
  if (wixLanguages.length !== 1 || wixLanguages[0] !== msiLanguage)
    problems.push(`bundle.windows.wix.language: atteso solo "${msiLanguage}", trovato ${JSON.stringify(wixLanguage)}`)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(windows?.wix?.upgradeCode ?? ''))
    problems.push('bundle.windows.wix.upgradeCode: serve un GUID fisso, o gli aggiornamenti MSI si duplicano')
  const languages = windows?.nsis?.languages
  if (!Array.isArray(languages) || languages.length !== 1 || languages[0] !== nsisLanguage)
    problems.push(`bundle.windows.nsis.languages: atteso ["${nsisLanguage}"], trovato ${JSON.stringify(languages)}`)
  const targets = config?.bundle?.targets
  if (!Array.isArray(targets) || [...targets].sort().join(',') !== 'msi,nsis')
    problems.push(`bundle.targets: atteso ["nsis", "msi"], trovato ${JSON.stringify(targets)}`)
  return problems
}

/** La CI deve pubblicare nello stesso repository in cui l'app cerca gli aggiornamenti (src/update-source.js). */
export function assertUpdateRepository(repository) {
  if (String(repository).toLowerCase() !== UPDATE_REPOSITORY.toLowerCase()) {
    throw new Error(
      `L'app controlla gli aggiornamenti su ${UPDATE_REPOSITORY} ma il rilascio andrebbe su ${repository}: aggiornare UPDATE_REPOSITORY in src/update-source.js.`
    )
  }
}

/** Pianificazione in sola lettura sulla cronologia Git reale; le release sono i record dell'API GitHub. */
export function planRelease({ cwd = process.cwd(), releases, sha = 'HEAD' }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const ancestor = (before, after) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', before, after], { cwd })
    if (result.status !== 0 && result.status !== 1)
      throw new Error('Impossibile verificare la cronologia Git.')
    return result.status === 0
  }
  const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean)
  const head = git('rev-parse', `${sha}^{commit}`)
  const configVersion = readBaseVersion(cwd)
  const tags = new Set(lines(git('tag', '--list')))
  const candidates = releases
    .filter((release) => !release.prerelease && stableTag.test(release.tag_name))
    .map((release) => ({ ...release, version: release.tag_name.slice(1) }))
    .sort((a, b) => compareVersions(b.version, a.version))
  const published = candidates
    .filter((release) => !release.draft)
    .map((release) => ({
      ...release,
      commit: git('rev-parse', `refs/tags/${release.tag_name}^{commit}`)
    }))

  // Una riesecuzione non deve mai creare un'altra versione ne' riportare Latest su codice piu' vecchio.
  const existing = published.find((release) => ancestor(head, release.commit))
  if (existing) return { skip: true, tag: existing.tag_name, sha: head }

  const previous = published[0]
  if (previous && !ancestor(previous.commit, head)) {
    throw new Error(
      `HEAD non discende da ${previous.tag_name}: ripristinare la cronologia di main prima del rilascio.`
    )
  }
  const ownDraft = candidates.find((release) => release.draft && release.target_commitish === head)

  // Prima release del fork: il tag v0.1.8 di Velocmd va spinto sul fork prima di main (un fork creato con l'opzione
  // predefinita "solo il branch main" non ha tag, e le release non si copiano mai). Senza release pubblicate si parte dal tag stabile piu' recente raggiungibile
  // da HEAD e non rivendicato da una release di questo repository: le note elencano solo le modifiche successive a quel
  // tag e la versione non scende sotto la sua. Senza alcun tag la versione resta la stessa, ma il confronto manca.
  let baseline = null
  if (!previous) {
    const claimed = new Set(releases.map((release) => release.tag_name))
    baseline = newestStableTag(lines(git('tag', '--merged', head)).filter((name) => !claimed.has(name)))
    if (baseline && !ownDraft && git('rev-parse', `refs/tags/${baseline}^{commit}`) === head) {
      // HEAD e' esattamente il codice di upstream: non c'e' nulla da rilasciare.
      return { skip: true, tag: baseline, sha: head }
    }
  }
  const start = previous?.tag_name ?? baseline
  const range = start ? `${start}..${head}` : head
  const records = git('log', '--reverse', '--format=%H%x00%B%x00', range).split('\0')
  const commits = []
  for (let index = 0; index + 1 < records.length; index += 2) {
    commits.push({ sha: records[index].trim(), message: records[index + 1].trim() })
  }
  const bump = getBump(commits.map((commit) => commit.message))
  const floor = previous?.version ?? baseline?.slice(1)
  const baseVersion = floor && compareVersions(floor, configVersion) > 0 ? floor : configVersion
  let version = ownDraft?.version ?? incrementVersion(baseVersion, bump)
  if (compareVersions(version, baseVersion) <= 0) {
    throw new Error('La bozza di questo commit precede la versione di base corrente.')
  }
  // Un upload interrotto puo' lasciare una versione riservata: il push successivo deve comunque rilasciare
  // tutte le modifiche dall'ultima release pubblicata, senza sovrascriverla.
  while (candidates.some((release) => release.tag_name === `v${version}` && release !== ownDraft)) {
    version = incrementVersion(version, 'patch')
  }
  assertMsiVersion(version)
  const tag = `v${version}`
  const draft = candidates.find((release) => release.tag_name === tag && release.draft)
  if (tags.has(tag) && (!draft || git('rev-parse', `refs/tags/${tag}^{commit}`) !== head)) {
    throw new Error(`Il tag ${tag} esiste già e non è una bozza recuperabile di questo commit.`)
  }

  return {
    skip: false,
    sha: head,
    version,
    tag,
    baseVersion,
    bump,
    previousTag: start ?? null,
    baseline,
    commits
  }
}

/**
 * Cartella `release` di Cargo in cui `tauri build` lascia l'eseguibile e i bundle: `CARGO_TARGET_DIR` se impostata
 * (la CLI la rispetta), altrimenti `src-tauri/target`. Un percorso relativo e' rifiutato: Cargo lo risolverebbe dalla
 * cartella in cui la CLI lo avvia, non da quella del repository.
 */
export function cargoReleaseDirectory(env = process.env, cwd = process.cwd()) {
  const custom = env.CARGO_TARGET_DIR
  if (custom) {
    if (!isAbsolute(custom)) throw new Error(`CARGO_TARGET_DIR deve essere un percorso assoluto, trovato ${custom}.`)
    return join(custom, 'release')
  }
  return resolve(cwd, 'src-tauri', 'target', 'release')
}

/** Argomenti di `tauri build` in CI: la versione entra come patch JSON (merge RFC 7396) e la CLI la passa a cargo. */
export function tauriBuildArgs(version) {
  assertMsiVersion(version)
  return ['build', '--ci', '--bundles', 'nsis,msi', '--config', JSON.stringify({ version }), '--', '--locked']
}

/** Nomi esatti degli asset della release, gli stessi citati nelle note e verificati dallo smoke test. */
export function releaseAssetNames(version) {
  versionParts(version)
  return {
    setup: `${productName}-${version}-win-x64-setup.exe`,
    msi: `${productName}-${version}-win-x64.msi`,
    portable: `${productName}-${version}-win-x64-portable.exe`
  }
}

/** Nomi prodotti da tauri-bundler 2.x: `<productName>_<versione>_x64-setup.exe` e `<productName>_<versione>_x64_<lingua>.msi`. */
export function bundleOutputNames(version) {
  versionParts(version)
  return {
    nsis: `${productName}_${version}_x64-setup.exe`,
    msi: `${productName}_${version}_x64_${msiLanguage}.msi`,
    binary: `${mainBinaryName}.exe`
  }
}

function soleFile(directory, extension, expected) {
  let names
  try {
    names = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(extension))
  } catch (error) {
    throw new Error(`Impossibile leggere ${directory}: ${error.code ?? error.message}`)
  }
  if (names.length !== 1 || names[0] !== expected) {
    throw new Error(
      `Atteso esattamente ${expected} in ${directory}; trovati: ${names.sort().join(', ') || 'nessuno'}.`
    )
  }
  return join(directory, expected)
}

/**
 * Copia gli output di `tauri build` in `outputDirectory` con i nomi degli asset. Ogni cartella del bundle deve
 * contenere esattamente il file della versione calcolata: un residuo di un'altra versione o di un'altra lingua e' un
 * errore, non una scelta da indovinare.
 */
export function stageArtifacts({ targetDirectory, outputDirectory, version }) {
  const outputs = bundleOutputNames(version)
  const assets = releaseAssetNames(version)
  const sources = {
    setup: soleFile(join(targetDirectory, 'bundle', 'nsis'), '.exe', outputs.nsis),
    msi: soleFile(join(targetDirectory, 'bundle', 'msi'), '.msi', outputs.msi),
    portable: join(targetDirectory, outputs.binary)
  }
  if (!statSync(sources.portable, { throwIfNoEntry: false })?.isFile())
    throw new Error(`Manca l'eseguibile ${sources.portable}.`)
  mkdirSync(outputDirectory, { recursive: true })
  for (const [key, name] of Object.entries(assets)) copyFileSync(sources[key], join(outputDirectory, name))
  return collectArtifacts(outputDirectory, version)
}

/** Gli artefatti in `directory`: esattamente setup, MSI e portable della versione calcolata, non vuoti. */
export function collectArtifacts(directory, version) {
  const expected = Object.values(releaseAssetNames(version)).sort()
  const files = readdirSync(directory)
    .filter((name) => /\.(exe|msi)$/i.test(name))
    .sort()
  if (files.length !== expected.length || files.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Attesi esattamente ${expected.join(', ')} in ${directory}; trovati: ${files.join(', ') || 'nessuno'}.`
    )
  }
  for (const name of files) {
    if (statSync(resolve(directory, name)).size === 0) throw new Error(`Artefatto vuoto: ${name}`)
  }
  return files
}

/** Copia le licenze in `outputDirectory` con i nomi degli asset e le restituisce come collectLegalFiles. */
export function stageLegalFiles({ outputDirectory, cwd = process.cwd() }) {
  mkdirSync(outputDirectory, { recursive: true })
  for (const [asset, source] of Object.entries(legalAssets)) {
    try {
      copyFileSync(resolve(cwd, source), join(outputDirectory, asset))
    } catch (error) {
      throw new Error(`Impossibile copiare ${source}: ${error.code ?? error.message}`)
    }
  }
  return collectLegalFiles(outputDirectory)
}

/** Le licenze da pubblicare in `directory`: tutte presenti e non vuote, altrimenti la release non parte. */
export function collectLegalFiles(directory) {
  return Object.keys(legalAssets).map((name) => {
    const size = statSync(resolve(directory, name), { throwIfNoEntry: false })?.size ?? 0
    if (size === 0) throw new Error(`Manca ${name} in ${directory}: eseguire prima stage.`)
    return name
  })
}

/** Manifest nel formato di `sha256sum` (`<hash>  <nome>`, una riga per file, LF), verificabile con Get-FileHash. */
export function checksumManifest(directory, files) {
  const lines = [...files].sort().map((name) => {
    const bytes = readFileSync(resolve(directory, name))
    if (bytes.length === 0) throw new Error(`Artefatto vuoto: ${name}`)
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`
  })
  return `${lines.join('\n')}\n`
}

/** Scrive SHA256SUMS.txt accanto agli artefatti della versione e ne restituisce il testo. */
export function writeChecksumManifest(directory, version) {
  const text = checksumManifest(directory, collectArtifacts(directory, version))
  writeFileSync(resolve(directory, checksumManifestName), text)
  return text
}

/**
 * Prima dell'upload: SHA256SUMS.txt deve esistere e descrivere esattamente i file che si stanno per pubblicare, cosi'
 * un artefatto sostituito dopo lo smoke test non arriva nella release con un checksum sbagliato.
 */
export function verifyChecksumManifest(directory, files) {
  let written
  try {
    written = readFileSync(resolve(directory, checksumManifestName), 'utf8')
  } catch (error) {
    throw new Error(`Manca ${checksumManifestName} in ${directory}: eseguire prima stage (${error.code ?? error.message}).`)
  }
  if (written !== checksumManifest(directory, files))
    throw new Error(`${checksumManifestName} non corrisponde agli artefatti in ${directory}: rieseguire stage.`)
}

const conventionalSubject = /^[a-z][\w-]*(?:\([^\r\n)]+\))?!?: \S/
const mergeSubject = /^Merge (?:branch|pull request|remote-tracking branch|tag) /

export function releaseNotes(plan, repository) {
  const assets = releaseAssetNames(plan.version)
  const subject = (commit) => commit.message.split(/\r?\n/)[0]
  const line = (commit) => `- ${subject(commit)} (${commit.sha.slice(0, 7)})`
  // I merge non aggiungono modifiche proprie: le loro modifiche sono gia' elencate con i commit uniti.
  const changes = plan.commits.filter((commit) => !mergeSubject.test(subject(commit)))
  // Prima release del fork (nessuna release pubblicata prima): i commit di RocketLauncher seguono i conventional
  // commit, quelli senza tipo sono di Velocmd, successivi al tag di partenza. Si elencano a parte, con il loro autore;
  // senza tag di partenza sarebbero l'intera cronologia di Velocmd e restano solo nel repository.
  const firstRelease = Boolean(plan.baseline) || !plan.previousTag
  const upstream = firstRelease ? changes.filter((commit) => !conventionalSubject.test(subject(commit))) : []
  const own = changes.filter((commit) => !upstream.includes(commit))
  return [
    'RocketLauncher per Windows x64: installer, pacchetto MSI ed eseguibile portable.',
    '',
    `Versione **${plan.version}**: incremento **${plan.bump}** da ${plan.baseVersion}.`,
    `Commit: ${plan.sha}.`,
    ...(firstRelease
      ? [
          '',
          plan.baseline
            ? `Prima release di RocketLauncher: le modifiche elencate partono da Velocmd ${plan.baseline} di Yashvardhan Gupta.`
            : 'Prima release di RocketLauncher, basata su Velocmd di Yashvardhan Gupta.',
          'RocketLauncher è un\'applicazione distinta da Velocmd: impostazioni, elementi recenti e indice di Velocmd non vengono importati. Se Velocmd è ancora installato, disinstallarlo per liberare i tasti di scelta rapida.'
        ]
      : []),
    '',
    '## Modifiche',
    '',
    ...own.map(line),
    ...(upstream.length > 0 && plan.baseline
      ? ['', `Comprende anche questi commit di Velocmd successivi a ${plan.baseline}, di Yashvardhan Gupta:`, '', ...upstream.map(line)]
      : []),
    '',
    ...(plan.previousTag
      ? [
          `[Confronto completo](https://github.com/${repository}/compare/${plan.previousTag}...${plan.tag})`,
          ''
        ]
      : []),
    '## Download',
    '',
    `- \`${assets.setup}\`: installer consigliato, per l'utente corrente e senza privilegi di amministratore.`,
    `- \`${assets.msi}\`: pacchetto MSI per installazioni gestite, per tutti gli utenti (richiede privilegi di amministratore).`,
    `- \`${assets.portable}\`: eseguibile singolo senza installazione; usa il WebView2 Runtime già presente in Windows 10 e 11 aggiornati.`,
    `- \`${checksumManifestName}\`: checksum SHA-256 dei tre file (\`Get-FileHash <file> -Algorithm SHA256\`).`,
    '- `LICENSE.txt`: testo della licenza GPL-3.0 di RocketLauncher e Velocmd.',
    '- `THIRD-PARTY-LICENSES.txt`: licenze dei componenti di terze parti inclusi negli eseguibili (font, icone, crate Rust).',
    '',
    '## Aggiornamento',
    '',
    'Dall\'app: Impostazioni > "Controlla aggiornamenti" segnala una versione più recente e apre questa pagina.',
    'Installer: eseguire il nuovo setup, che aggiorna l\'installazione esistente; se trova un\'installazione MSI di RocketLauncher la rimuove prima. Scegliere un solo formato di installazione.',
    'Portable: uscire da RocketLauncher dall\'icona nell\'area di notifica e sostituire l\'eseguibile con quello nuovo; con l\'avvio automatico attivo, mantenere lo stesso nome e percorso del file oppure riattivarlo dalle Impostazioni.',
    `Gli aggiornamenti conservano tasti di scelta rapida e impostazioni (\`%APPDATA%\\${appIdentifier}\`), indice dei file e preferenze dell'interfaccia (\`%LOCALAPPDATA%\\${appIdentifier}\`).`,
    '',
    'I file non sono firmati digitalmente: al primo avvio Windows SmartScreen può mostrare "Windows ha protetto il PC". Dopo aver verificato il checksum, scegliere "Ulteriori informazioni" > "Esegui comunque".',
    '',
    'RocketLauncher è un fork di [Velocmd](https://github.com/YashvardhanG/Velocmd) di Yashvardhan Gupta, distribuito con licenza GPL-3.0: il codice sorgente di questa versione è quello del tag della release.',
    ''
  ].join('\n')
}

function gh(...args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  }).trim()
}


function listReleases() {
  const pages = JSON.parse(
    gh('api', '--paginate', '--slurp', `repos/${process.env.GH_REPO}/releases?per_page=100`)
  )
  return pages.flat()
}

function readPlan() {
  return JSON.parse(readFileSync(process.env.RELEASE_PLAN, 'utf8'))
}

function assertReleaseContract() {
  const problems = releaseContractProblems(readJson(process.cwd(), tauriConfigFile))
  if (problems.length > 0)
    throw new Error(`${tauriConfigFile} non rispetta il contratto di rilascio:\n- ${problems.join('\n- ')}`)
}

function describePlan(plan) {
  return `${plan.baseVersion} -> ${plan.version} (${plan.bump}, ${plan.commits.length} commit${plan.baseline ? `, da ${plan.baseline}` : ''})`
}

function prepare() {
  assertUpdateRepository(process.env.GH_REPO)
  assertReleaseContract()
  const plan = planRelease({ releases: listReleases(), sha: process.env.GITHUB_SHA || 'HEAD' })
  writeFileSync(process.env.RELEASE_PLAN, `${JSON.stringify(plan, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `skip=${plan.skip}\ntag=${plan.tag}\nversion=${plan.version ?? ''}\n`
    )
  }
  if (plan.skip) {
    console.log(`Commit già incluso in ${plan.tag}; nessun nuovo rilascio.`)
    return
  }

  // Nessun file del checkout viene modificato: la versione arriva a `tauri build` con --config. Tag e release
  // restano l'autorita' sulla versione; niente commit del bot, scritture sul branch, PAT o build a catena.
  console.log(describePlan(plan))
}

/**
 * Anteprima locale di prepare: stessa pianificazione, ma le release vengono da RELEASES_FILE (l'output di
 * `gh api --paginate --slurp repos/<repo>/releases`, oppure un array) e senza file si assume che non ce ne siano,
 * come prima della prima release del fork. Scrive RELEASE_PLAN se impostata, cosi' build, stage e smoke si possono
 * provare in locale con la versione che la CI calcolerebbe.
 */
function plan() {
  assertReleaseContract()
  const releases = process.env.RELEASES_FILE ? JSON.parse(readFileSync(process.env.RELEASES_FILE, 'utf8')).flat() : []
  const result = planRelease({ releases, sha: process.env.RELEASE_SHA || 'HEAD' })
  if (process.env.RELEASE_PLAN) writeFileSync(process.env.RELEASE_PLAN, `${JSON.stringify(result, null, 2)}\n`)
  if (result.skip) {
    console.log(`Commit già incluso in ${result.tag}; nessun nuovo rilascio.`)
    return
  }
  console.log(`${result.tag}: ${describePlan(result)}\n`)
  console.log(releaseNotes(result, UPDATE_REPOSITORY))
}

function build() {
  const plan = readPlan()
  if (plan.skip) return
  // node + array di argomenti: il JSON di --config non passa da pwsh, npm.ps1 o cmd.exe.
  const result = spawnSync(process.execPath, [resolve(tauriCli), ...tauriBuildArgs(plan.version)], {
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tauri build non riuscito (codice ${result.status ?? result.signal}).`)
}

function stage() {
  const plan = readPlan()
  if (plan.skip) return
  const directory = resolve(releaseDirectory)
  const files = stageArtifacts({
    targetDirectory: cargoReleaseDirectory(),
    outputDirectory: directory,
    version: plan.version
  })
  process.stdout.write(writeChecksumManifest(directory, plan.version))
  const legal = stageLegalFiles({ outputDirectory: directory })
  for (const name of [...files, ...legal]) console.log(`${name}  ${statSync(resolve(directory, name)).size} byte`)
}

function publish() {
  const plan = readPlan()
  if (plan.skip) return
  const directory = resolve(releaseDirectory)
  const files = collectArtifacts(directory, plan.version)
  verifyChecksumManifest(directory, files)
  const legal = collectLegalFiles(directory)
  const notesPath = `${process.env.RELEASE_PLAN}.md`
  writeFileSync(notesPath, releaseNotes(plan, process.env.GH_REPO))
  const existing = listReleases().find((release) => release.tag_name === plan.tag)
  if (existing && (!existing.draft || existing.target_commitish !== plan.sha)) {
    throw new Error(`${plan.tag} è già pubblicata o appartiene a un altro commit.`)
  }
  if (!existing) {
    gh(
      'release',
      'create',
      plan.tag,
      '--draft',
      '--target',
      plan.sha,
      '--title',
      plan.tag,
      '--notes-file',
      notesPath
    )
  } else {
    gh('release', 'edit', plan.tag, '--title', plan.tag, '--notes-file', notesPath)
  }
  const assets = [...files, checksumManifestName, ...legal]
  gh('release', 'upload', plan.tag, ...assets.map((name) => resolve(directory, name)), '--clobber')
  const uploaded = JSON.parse(gh('release', 'view', plan.tag, '--json', 'assets')).assets
  for (const name of assets) {
    const asset = uploaded.find((item) => item.name === name)
    if (!asset || asset.size !== statSync(resolve(directory, name)).size) {
      throw new Error(`Upload incompleto: ${name}; la release resta in bozza.`)
    }
  }
  gh('release', 'edit', plan.tag, '--draft=false', '--latest')
  const url = `https://github.com/${process.env.GH_REPO}/releases/tag/${plan.tag}`
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release pubblicata: [${plan.tag}](${url})\n`)
  console.log(url)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = { prepare, plan, build, stage, publish }
  const command = commands[process.argv[2]]
  try {
    if (!command) throw new Error('Uso: node scripts/windows-release.mjs prepare|plan|build|stage|publish')
    if (command !== plan && !process.env.RELEASE_PLAN) throw new Error('RELEASE_PLAN è obbligatorio.')
    if ((command === prepare || command === publish) && !process.env.GH_REPO)
      throw new Error('GH_REPO è obbligatorio per prepare e publish.')
    command()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
