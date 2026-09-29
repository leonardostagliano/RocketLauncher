import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HELP_URL,
  LATEST_RELEASE_API,
  LATEST_RELEASE_URL,
  RELEASES_URL,
  REPOSITORY_URL,
  UPDATE_REPOSITORY,
  compareVersions,
  fetchLatestRelease,
  findUpdate,
  isNewer,
  latestReleaseFrom,
  stableVersion
} from '../src/update-source.js'

describe('update source', () => {
  it('derives every RocketLauncher URL from one repository constant', () => {
    assert.equal(UPDATE_REPOSITORY, 'leonardostagliano/RocketLauncher')
    assert.equal(REPOSITORY_URL, 'https://github.com/leonardostagliano/RocketLauncher')
    assert.equal(HELP_URL, 'https://github.com/leonardostagliano/RocketLauncher#readme')
    assert.equal(RELEASES_URL, 'https://github.com/leonardostagliano/RocketLauncher/releases')
    assert.equal(LATEST_RELEASE_URL, 'https://github.com/leonardostagliano/RocketLauncher/releases/latest')
    assert.equal(LATEST_RELEASE_API, 'https://api.github.com/repos/leonardostagliano/RocketLauncher/releases/latest')
  })
})

describe('version comparison', () => {
  it('parses stable versions with or without v and rejects everything else', () => {
    assert.deepEqual(stableVersion('v0.10.2'), [0, 10, 2])
    assert.deepEqual(stableVersion(' 1.2.3 '), [1, 2, 3])
    for (const value of ['1.2', '1.2.3-rc.1', '1.2.3+build', '01.2.3', 'latest', '', null, 3]) {
      assert.equal(stableVersion(value), null, String(value))
    }
  })

  it('compares numerically, not as text', () => {
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
    assert.ok(compareVersions('v1.0.0', '0.99.99') > 0)
    assert.equal(compareVersions('v0.2.0', '0.2.0'), 0)
    assert.throws(() => compareVersions('0.2', '0.2.0'))
  })

  it('reports an update only for a strictly newer stable version', () => {
    assert.equal(isNewer('1.0.1', '1.0.0'), true)
    assert.equal(isNewer('v1.10.0', '1.9.0'), true)
    assert.equal(isNewer('1.0.0', '1.0.0'), false)
    assert.equal(isNewer('0.1.8', '1.0.0'), false, 'an older Latest must not look like an update')
    assert.equal(isNewer('garbage', '1.0.0'), false)
    assert.equal(isNewer('1.1.0', undefined), false, 'an unknown installed version never reports an update')
    assert.equal(isNewer('1.1.0', null), false)
  })
})

describe('latestReleaseFrom', () => {
  const release = { tag_name: 'v1.1.0', draft: false, prerelease: false, html_url: 'https://evil.example/x&calc' }

  it('builds the release URL from the fixed repository, never from the response', () => {
    assert.deepEqual(latestReleaseFrom(release), {
      version: '1.1.0',
      tag: 'v1.1.0',
      url: 'https://github.com/leonardostagliano/RocketLauncher/releases/tag/v1.1.0'
    })
  })

  it('ignores drafts, pre-releases, unstable tags and malformed responses', () => {
    assert.equal(latestReleaseFrom({ ...release, draft: true }), null)
    assert.equal(latestReleaseFrom({ ...release, prerelease: true }), null)
    assert.equal(latestReleaseFrom({ ...release, tag_name: 'v1.1.0-rc.1' }), null)
    assert.equal(latestReleaseFrom({ ...release, tag_name: 'v1.1.0&calc' }), null)
    assert.equal(latestReleaseFrom({ message: 'Not Found' }), null)
    assert.equal(latestReleaseFrom(null), null)
    assert.equal(latestReleaseFrom('v1.1.0'), null)
  })
})

describe('fetchLatestRelease and findUpdate', () => {
  // Una risposta minima con la stessa forma di quella di fetch nel WebView.
  const respond = (status, body) => {
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      return { status, ok: status >= 200 && status < 300, json: async () => body }
    }
    return { calls, fetchImpl }
  }
  const published = (tag) => ({ tag_name: tag, draft: false, prerelease: false })

  it('asks GitHub for the latest release of the fixed repository, bypassing the HTTP cache', async () => {
    const { calls, fetchImpl } = respond(200, published('v1.0.0'))
    await fetchLatestRelease(fetchImpl)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, LATEST_RELEASE_API)
    assert.equal(calls[0].options.cache, 'no-store')
    assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json')
  })

  it('treats 404 as "no release yet": the fork before its first release is up to date, not failing', async () => {
    assert.equal(await fetchLatestRelease(respond(404, { message: 'Not Found' }).fetchImpl), null)
    assert.equal(await findUpdate('1.0.0', respond(404, { message: 'Not Found' }).fetchImpl), null)
  })

  it('offers only a strictly newer published release', async () => {
    assert.deepEqual(await findUpdate('1.0.0', respond(200, published('v1.0.1')).fetchImpl), {
      version: '1.0.1',
      tag: 'v1.0.1',
      url: 'https://github.com/leonardostagliano/RocketLauncher/releases/tag/v1.0.1'
    })
    assert.equal(await findUpdate('1.0.1', respond(200, published('v1.0.1')).fetchImpl), null)
    assert.equal(await findUpdate('1.1.0', respond(200, published('v1.0.1')).fetchImpl), null)
    assert.equal(await findUpdate(null, respond(200, published('v1.0.1')).fetchImpl), null)
    assert.equal(await findUpdate('1.0.0', respond(200, { ...published('v2.0.0'), draft: true }).fetchImpl), null)
  })

  it('reports other HTTP errors and network failures to the caller', async () => {
    await assert.rejects(fetchLatestRelease(respond(403, { message: 'rate limit' }).fetchImpl), /403/)
    await assert.rejects(fetchLatestRelease(respond(500, {}).fetchImpl), /500/)
    await assert.rejects(
      findUpdate('1.0.0', async () => {
        throw new TypeError('Failed to fetch')
      }),
      /Failed to fetch/
    )
  })
})
