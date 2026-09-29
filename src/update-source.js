// Origine degli aggiornamenti, fissata in build: l'unico punto del codice in cui compare il repository GitHub.
// La usano il controllo aggiornamenti di main.js e scripts/windows-release.mjs (che rifiuta di pubblicare su un
// repository diverso da questo, altrimenti l'app controllerebbe le release di un altro progetto).
export const UPDATE_REPOSITORY = "leonardostagliano/RocketLauncher";
export const REPOSITORY_URL = `https://github.com/${UPDATE_REPOSITORY}`;
export const HELP_URL = `${REPOSITORY_URL}#readme`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

const STABLE_VERSION = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** [major, minor, patch] di una SemVer stabile, con o senza "v"; null per pre-release, metadata o zeri iniziali. */
export function stableVersion(value) {
  if (typeof value !== "string") return null;
  const match = STABLE_VERSION.exec(value.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Confronto numerico di due versioni stabili (0.10.0 > 0.9.0); lancia se una delle due non lo e'. */
export function compareVersions(left, right) {
  const a = stableVersion(left);
  const b = stableVersion(right);
  if (!a || !b) throw new Error(`Versione SemVer stabile non valida: ${a ? right : left}`);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** true solo se `latest` e' strettamente piu' recente di `current`; una versione non valida non segnala mai aggiornamenti. */
export function isNewer(latest, current) {
  if (!stableVersion(latest) || !stableVersion(current)) return false;
  return compareVersions(latest, current) > 0;
}

/**
 * La release stabile pubblicata descritta dalla risposta di /releases/latest, o null. L'URL da aprire e' costruito qui
 * dal repository fissato in build, mai preso dalla risposta (html_url): il comando open_file lo passa a `cmd /C start`.
 */
export function latestReleaseFrom(data) {
  if (!data || typeof data !== "object" || data.draft !== false || data.prerelease !== false) return null;
  const parts = stableVersion(data.tag_name);
  if (!parts) return null;
  return {
    version: parts.join("."),
    tag: data.tag_name,
    url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`
  };
}

/**
 * L'ultima release stabile pubblicata, o null se il repository non ne ha ancora: GitHub risponde 404 a
 * /releases/latest finche' non esiste una release pubblicata (il fork prima della prima release), e non e' un errore.
 * Ogni altra risposta non riuscita, o un errore di rete, viene rilanciata al chiamante.
 */
export async function fetchLatestRelease(fetchImpl = (...args) => globalThis.fetch(...args)) {
  const response = await fetchImpl(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store"
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ha risposto ${response.status}`);
  return latestReleaseFrom(await response.json());
}

/**
 * La release da proporre all'utente: solo se strettamente piu' recente di `currentVersion` (la versione restituita da
 * getVersion()). null se si e' gia' aggiornati, se non esistono release o se una delle due versioni non e' valida.
 */
export async function findUpdate(currentVersion, fetchImpl) {
  const latest = await fetchLatestRelease(fetchImpl);
  return latest && isNewer(latest.version, currentVersion) ? latest : null;
}
