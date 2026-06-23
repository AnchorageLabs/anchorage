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
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("anchorage-" + [System.Guid]::NewGuid().ToString() + ".exe")
$sums = Join-Path ([System.IO.Path]::GetTempPath()) ("anchorage-" + [System.Guid]::NewGuid().ToString() + ".SHA256SUMS")

try {
  Write-Host "Downloading $asset…"
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $tmp

  Write-Host "Verifying checksum…"
  Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums
  $expected = Get-Content $sums |
    Where-Object { $_ -match "\s$([Regex]::Escape($asset))$" } |
    ForEach-Object { ($_ -split "\s+")[0] } |
    Select-Object -First 1
  if (-not $expected) { throw "checksum for $asset not found in SHA256SUMS" }

  $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) { throw "checksum mismatch for $asset" }

  Move-Item -Force -Path $tmp -Destination $out
}
finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp, $sums
}

Write-Host "Installed: $out"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
  Write-Host "Added $dir to your user PATH — restart your terminal to pick it up."
}
