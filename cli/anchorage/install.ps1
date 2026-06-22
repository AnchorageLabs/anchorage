# Anchorage CLI installer (Windows, PowerShell).
#
#   irm https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.ps1 | iex
#
# Downloads the standalone Windows binary from the latest GitHub Release and
# installs it under %LOCALAPPDATA%\Anchorage\bin (override with ANCHORAGE_BIN_DIR).
# No Node/Bun required. Override the source with ANCHORAGE_CLI_BASE_URL.
$ErrorActionPreference = "Stop"

$repo = "AnchorageLabs/anchorage"
$base = if ($env:ANCHORAGE_CLI_BASE_URL) { $env:ANCHORAGE_CLI_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
$asset = "anchorage-windows-x64.exe"

$dir = if ($env:ANCHORAGE_BIN_DIR) { $env:ANCHORAGE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Anchorage\bin" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$out = Join-Path $dir "anchorage.exe"

Write-Host "Downloading $asset…"
Invoke-WebRequest -Uri "$base/$asset" -OutFile $out

Write-Host "Installed: $out"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
  Write-Host "Added $dir to your user PATH — restart your terminal to pick it up."
}
