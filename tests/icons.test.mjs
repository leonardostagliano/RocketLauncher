import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { iconNameFor } from '../src/icons.js'

describe('result icons', () => {
  it('gives the user folders their own icon, as Velocmd did', () => {
    const cases = [
      ['C:\\Users\\Ada\\Downloads', 'folder-down'],
      ['C:\\Users\\Ada\\Pictures', 'image'],
      ['C:\\Users\\Ada\\Documents', 'file-text'],
      ['C:\\Users\\Ada\\Music', 'music'],
      ['C:\\Users\\Ada\\Videos', 'clapperboard'],
      ['C:\\Users\\Ada\\Desktop', 'monitor'],
      ['c:/users/ada/downloads', 'folder-down'],
      ['C:\\Documents and Settings\\Ada\\Desktop', 'monitor']
    ]
    for (const [path, name] of cases) assert.equal(iconNameFor(path, 'folder'), name, path)
  })

  it('keeps the plain folder icon outside the user profile root', () => {
    assert.equal(iconNameFor('C:\\Users\\Ada\\Progetti', 'folder'), 'folder')
    assert.equal(iconNameFor('C:\\Users\\Ada\\Progetti\\Downloads', 'folder'), 'folder')
    assert.equal(iconNameFor('D:\\Downloads', 'folder'), 'folder')
  })

  it('maps commands, kinds and extensions', () => {
    assert.equal(iconNameFor('rocket:help', 'command'), 'circle-question-mark')
    assert.equal(iconNameFor('nox:toggle_hyper', 'command'), 'moon')
    assert.equal(iconNameFor('ms-settings:display', 'command'), 'sliders-horizontal')
    assert.equal(iconNameFor('C:\\$Recycle.Bin\\RecycleBinFolder', 'folder'), 'trash')
    assert.equal(iconNameFor('C:\\app\\RocketLauncher.exe', 'app'), 'app-window')
    assert.equal(iconNameFor('C:\\docs\\Relazione.PDF', 'file'), 'file-text')
    assert.equal(iconNameFor('C:\\docs\\sconosciuto.xyz', 'file'), 'file')
  })
})
