<#
.SYNOPSIS
    Smoke test degli artefatti di rilascio di RocketLauncher, senza installarli e senza avviare l'interfaccia.
.DESCRIPTION
    Controlla i tre file in -Directory e il loro SHA256SUMS.txt: checksum, intestazioni PE e OLE, VERSIONINFO
    dell'eseguibile e del setup NSIS, tabella Property dell'MSI. Poi esegue il portable con --smoke=<versione>: l'app
    confronta la versione di getVersion() e gli asset incorporati ed esce prima di creare finestra, tray, scorciatoia
    globale, single-instance, avvio automatico e indicizzazione, quindi senza effetti sul sistema.
.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-windows.ps1 -Version 1.0.0
#>
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$Version,
    [string]$Directory = 'release'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$product = $config.productName
$publisher = $config.bundle.publisher
$upgradeCode = $config.bundle.windows.wix.upgradeCode
$directoryPath = (Resolve-Path -LiteralPath $Directory).Path

function Get-Artifact([string]$Name) {
    $path = Join-Path $directoryPath $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manca $Name." }
    if ((Get-Item -LiteralPath $path).Length -le 0) { throw "${Name}: file vuoto." }
    return $path
}

function Assert-Equal($Actual, $Expected, [string]$What) {
    if ("$Actual" -cne "$Expected") { throw "${What}: '$Actual', atteso '$Expected'." }
}

# Stringhe FileVersion/ProductVersion (Esplora file, FileVersionInfo) e, con -Fixed, la parte numerica VS_FIXEDFILEINFO.
function Assert-VersionInfo([string]$Path, [string]$Name, [switch]$Fixed) {
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    Assert-Equal $info.ProductName $product "${Name} ProductName"
    Assert-Equal $info.FileVersion $Version "${Name} FileVersion"
    Assert-Equal $info.ProductVersion $Version "${Name} ProductVersion"
    if ($Fixed) {
        $file = "$($info.FileMajorPart).$($info.FileMinorPart).$($info.FileBuildPart).$($info.FilePrivatePart)"
        $productFixed = "$($info.ProductMajorPart).$($info.ProductMinorPart).$($info.ProductBuildPart).$($info.ProductPrivatePart)"
        Assert-Equal $file "$Version.0" "${Name} FILEVERSION"
        Assert-Equal $productFixed "$Version.0" "${Name} PRODUCTVERSION"
    }
    return $info
}

# MSI: la tabella Property letta con il COM di Windows Installer, senza installare nulla.
function Get-MsiProperty([string]$Path, [string]$Property) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $null
    $view = $null
    try {
        $database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($Path, 0))
        $query = "SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$Property'"
        $view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @($query))
        [void]$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
        $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
        $value = if ($record) { $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1)) } else { $null }
        [void]$view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
        return $value
    }
    finally {
        # Rilascio esplicito: il database MSI resta aperto finche' il COM non viene liberato.
        foreach ($com in @($view, $database, $installer)) {
            if ($null -ne $com) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($com) }
        }
    }
}

$setup = Get-Artifact "$product-$Version-win-x64-setup.exe"
$msi = Get-Artifact "$product-$Version-win-x64.msi"
$portable = Get-Artifact "$product-$Version-win-x64-portable.exe"

# SHA256SUMS.txt scritto da stage: una riga `<sha256>  <nome>` per ciascuno dei tre file, ricontrollata qui con
# Get-FileHash, cioe' come la verificherebbe un utente dopo il download.
$sums = Get-Artifact 'SHA256SUMS.txt'
$lines = @((Get-Content -LiteralPath $sums -Raw) -split "`n" | Where-Object { $_ -ne '' })
Assert-Equal $lines.Count 3 'SHA256SUMS.txt righe'
foreach ($path in @($setup, $msi, $portable)) {
    $name = Split-Path -Leaf $path
    $line = @($lines | Where-Object { $_ -match "^[0-9a-f]{64}  $([regex]::Escape($name))$" })
    if ($line.Count -ne 1) { throw "SHA256SUMS.txt: serve una sola riga per $name." }
    Assert-Equal $line[0].Substring(0, 64) (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() "SHA256 di $name"
}

# Portable: PE32+ x64 con sottosistema GUI e VERSIONINFO allineata alla versione calcolata.
$bytes = [System.IO.File]::ReadAllBytes($portable)
if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw 'Portable: manca l''intestazione MZ.' }
$pe = [System.BitConverter]::ToInt32($bytes, 0x3C)
if ($pe -le 0 -or $pe + 94 -gt $bytes.Length -or [System.BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550) { throw 'Portable: manca la firma PE.' }
Assert-Equal ('0x{0:X4}' -f [System.BitConverter]::ToUInt16($bytes, $pe + 4)) '0x8664' 'Portable Machine (x64)'
Assert-Equal ('0x{0:X3}' -f [System.BitConverter]::ToUInt16($bytes, $pe + 24)) '0x20B' 'Portable Magic (PE32+)'
Assert-Equal ([System.BitConverter]::ToUInt16($bytes, $pe + 24 + 68)) 2 'Portable Subsystem (GUI)'
$info = Assert-VersionInfo $portable 'Portable' -Fixed
Assert-Equal $info.CompanyName $publisher 'Portable CompanyName'
if (-not "$($info.LegalCopyright)".Contains('Yashvardhan Gupta')) { throw 'Portable: LegalCopyright senza l''attribuzione a Yashvardhan Gupta.' }

# Setup NSIS: stringhe VIAddVersionKey del template di tauri-bundler (la parte numerica dipende da makensis).
$head = [byte[]]::new(2)
$stream = [System.IO.File]::OpenRead($setup)
try { [void]$stream.Read($head, 0, 2) } finally { $stream.Dispose() }
if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { throw 'Setup: manca l''intestazione MZ.' }
[void](Assert-VersionInfo $setup 'Setup')

# MSI: file OLE compound con versione, nome, produttore, lingua italiana e upgrade code fisso.
$ole = [byte[]]::new(8)
$stream = [System.IO.File]::OpenRead($msi)
try { [void]$stream.Read($ole, 0, 8) } finally { $stream.Dispose() }
Assert-Equal ([System.BitConverter]::ToString($ole)) 'D0-CF-11-E0-A1-B1-1A-E1' 'MSI intestazione OLE'
Assert-Equal (Get-MsiProperty $msi 'ProductVersion') $Version 'MSI ProductVersion'
Assert-Equal (Get-MsiProperty $msi 'ProductName') $product 'MSI ProductName'
Assert-Equal (Get-MsiProperty $msi 'Manufacturer') $publisher 'MSI Manufacturer'
Assert-Equal (Get-MsiProperty $msi 'ProductLanguage') '1040' 'MSI ProductLanguage (it-IT)'
Assert-Equal ("$(Get-MsiProperty $msi 'UpgradeCode')".Trim('{', '}').ToLowerInvariant()) $upgradeCode.ToLowerInvariant() 'MSI UpgradeCode'

# Avvio controllato: --smoke=<versione> esce con 0 se getVersion(), asset e productName corrispondono.
$start = [System.Diagnostics.ProcessStartInfo]::new($portable)
$start.ArgumentList.Add("--smoke=$Version")
$start.UseShellExecute = $false
$process = [System.Diagnostics.Process]::Start($start)
if (-not $process.WaitForExit(60000)) {
    $process.Kill($true)
    throw '--smoke non termina entro 60 s: il flag non e'' gestito e l''app si e'' avviata.'
}
$reasons = @{ 10 = 'getVersion() diversa dalla versione calcolata'; 11 = 'asset del frontend mancanti'; 12 = 'productName diverso' }
if ($process.ExitCode -ne 0) { throw "--smoke=${Version}: codice $($process.ExitCode) ($($reasons[$process.ExitCode]))." }

foreach ($path in @($setup, $msi, $portable)) {
    Write-Host "$(Split-Path -Leaf $path): $((Get-Item -LiteralPath $path).Length) byte"
}
Write-Host "Smoke test $product $Version superato: checksum, VERSIONINFO, MSI e --smoke coerenti."
