// Rigenera le icone dell'app dall'unico sorgente branding/rocketlauncher-icon.svg (npm run icons).
// Il logo e' identico ovunque: nessuna variante semplificata per la tray o per l'interfaccia.
// - src-tauri/icons: icona dell'app (ico per exe, NSIS e MSI; png per la finestra)
// - src-tauri/icons/tray/32x32.png: icona dell'area di notifica (main.rs la include con include_bytes!)
// - docs/images/logo.png: logo del README (256 px)
// Il simbolo #rl-logo in src/index.html ripete lo stesso disegno: se il logo cambia, va aggiornato anche li'.
// `tauri icon` genera anche le icone per Android, iOS, macOS e Microsoft Store: l'app e' solo per Windows e le
// installa con NSIS e MSI, quindi quei file vengono rimossi.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const icons = join(root, 'src-tauri', 'icons')
const tauri = (...args) =>
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tauri', 'icon', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

tauri('branding/rocketlauncher-icon.svg')
tauri('branding/rocketlauncher-icon.svg', '--output', 'src-tauri/icons/tray', '--png', '32')

for (const name of [
  'android',
  'ios',
  'icon.icns',
  'StoreLogo.png',
  ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((size) => `Square${size}x${size}Logo.png`)
]) {
  rmSync(join(icons, name), { recursive: true, force: true })
}

mkdirSync(join(root, 'docs', 'images'), { recursive: true })
copyFileSync(join(icons, '128x128@2x.png'), join(root, 'docs', 'images', 'logo.png'))
console.log('Icone rigenerate da branding/.')
