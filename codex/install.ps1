# Wallvia for Codex Desktop — one-line installer
#
#   irm https://cdn.jsdelivr.net/gh/Maplelia/Wallvia@main/codex/install.ps1 | iex
#
# jsDelivr serves this script because raw.githubusercontent.com is unreachable on
# some networks; the repository ZIP is then fetched from codeload.github.com,
# which is reachable on those same networks. A github.com/archive fallback is
# included as well.
#
# The repository is a monorepo, so the CLI lives in its codex/ subdirectory; this
# script picks that folder out of the archive.
#
# Installs under %LOCALAPPDATA%\Wallvia\codex and puts a `wallvia` shim on your
# user PATH. No admin required, and no files inside the Codex app are touched --
# the wallpaper is injected at runtime over CDP.
param(
  [string]$Repo = "https://github.com/Maplelia/Wallvia",
  [string]$Branch = "main",
  [string]$Subdir = "codex",
  [string]$Dest = "$env:LOCALAPPDATA\Wallvia\codex"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # noticeably faster Invoke-WebRequest

# --- checks ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is required (>= 22). Install it from https://nodejs.org and retry." }
$major = [int]((& node --version).TrimStart('v') -split '\.')[0]
if ($major -lt 22) { throw "Node.js 22 or newer is required (found $major): the keeper uses the global WebSocket API." }

# --- download the repository ----------------------------------------------
$slug = ($Repo -replace '^https?://github\.com/', '' -replace '\.git$', '').Trim('/')
$sources = @(
  "https://codeload.github.com/$slug/zip/refs/heads/$Branch",
  "https://github.com/$slug/archive/refs/heads/$Branch.zip"
)

$tmp = Join-Path $env:TEMP ("wallvia-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'src.zip'

$ok = $false
foreach ($url in $sources) {
  try {
    Write-Host "Downloading $url ..." -ForegroundColor Cyan
    Invoke-WebRequest $url -OutFile $zip
    $ok = $true
    break
  } catch {
    Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor DarkYellow
  }
}
if (-not $ok) {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  throw "Could not download $slug. Check your network, or clone it manually:  git clone $Repo"
}

Expand-Archive -Path $zip -DestinationPath $tmp -Force
$root = Get-ChildItem $tmp -Directory | Select-Object -First 1
$src = if ($root) { Join-Path $root.FullName $Subdir } else { $null }
if (-not $src -or -not (Test-Path (Join-Path $src 'src\cli.mjs'))) {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  throw "Unexpected archive layout: $Subdir/src/cli.mjs was not found."
}

New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
Move-Item $src $Dest
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

# --- `wallvia` shim on the user PATH --------------------------------------
$shimDir = Join-Path $env:LOCALAPPDATA 'Wallvia\bin'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shim = Join-Path $shimDir 'wallvia.cmd'
$body = "@echo off`r`nnode `"$Dest\src\cli.mjs`" %*`r`n"
[System.IO.File]::WriteAllText($shim, $body, [System.Text.ASCIIEncoding]::new())

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$shimDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$shimDir", 'User')
  Write-Host "Added $shimDir to your user PATH." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Installed to $Dest" -ForegroundColor Green
Write-Host ""
Write-Host "Open a NEW terminal, then run:" -ForegroundColor Cyan
Write-Host "    wallvia watch        # mirror your current Wallpaper Engine wallpaper into Codex"
Write-Host "    wallvia status       # check the wallpaper, the debug port and Codex"
Write-Host "    wallvia stop         # restore"
Write-Host ""
Write-Host "Or double-click start-wallpaper.cmd in $Dest"
