# Builds dist/OnZVoIP.op — the single file a player drops into Openplanet4\Plugins.
#
# An .op is a plain zip that OpenPlanet reads without unpacking. The only layout
# rule is that info.toml sits at the ARCHIVE ROOT; the .as files may be anywhere
# below it (checked against the installed plugins on this machine: EditorTrails
# keeps them at the root, BlocksItemsCounter under Source/, ServersList under
# lib/). Ours are flat, so the archive is simply the contents of
# openplanet-plugin/ — note the trailing \* : zipping the folder itself would
# bury info.toml one level down and OpenPlanet would not see the plugin at all.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\build-op.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'openplanet-plugin'
$dist = Join-Path $root 'dist'
$op   = Join-Path $dist 'OnZVoIP.op'
$zip  = Join-Path $dist 'OnZVoIP.zip'

if (-not (Test-Path (Join-Path $src 'info.toml'))) {
    throw "info.toml introuvable dans $src"
}

# The version players will report back is whatever is in info.toml, so echo it:
# building an .op that still carries the previous number is the easy mistake.
$version = (Select-String -Path (Join-Path $src 'info.toml') -Pattern '^\s*version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value

if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $op)  { Remove-Item $op  -Force }

Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zip
Rename-Item -Path $zip -NewName 'OnZVoIP.op'

$size = [math]::Round((Get-Item $op).Length / 1KB, 1)
Write-Output "OnZVoIP.op v$version  ($size KB)  ->  $op"
