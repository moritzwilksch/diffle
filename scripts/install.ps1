# Installs the diffle binary from a GitHub release.
#   irm https://github.com/moritzwilksch/diffle/releases/latest/download/install.ps1 | iex
# DIFFLE_VERSION picks a release tag (default: latest); DIFFLE_INSTALL_DIR the target
# (default: %LOCALAPPDATA%\Programs\diffle); DIFFLE_DOWNLOAD_URL a mirror of the release assets.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell's progress bar slows downloads tenfold.

$repo = 'moritzwilksch/diffle'
$version = if ($env:DIFFLE_VERSION) { $env:DIFFLE_VERSION } else { 'latest' }
$dir = if ($env:DIFFLE_INSTALL_DIR) { $env:DIFFLE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\diffle' }

function Fail($msg) {
  throw "diffle install: $msg"
}

if ($env:OS -ne 'Windows_NT') { Fail 'this installer is for Windows; use install.sh elsewhere' }

# OSArchitecture reports the machine, not the process, so x64 PowerShell on ARM still picks arm64.
$arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { Fail "no binary for $_; install with npm or pixi instead" }
}

$base = if ($env:DIFFLE_DOWNLOAD_URL) { $env:DIFFLE_DOWNLOAD_URL }
elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" }
else { "https://github.com/$repo/releases/download/$version" }
$asset = "diffle-windows-$arch.zip"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "diffle-install-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "downloading $base/$asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

  # A `*` before the name marks binary mode in sha256sum's format.
  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { (($_ -split '\s+')[1] -replace '^\*') -eq $asset }
  if (-not $line) { Fail "SHA256SUMS lists no $asset" }
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash
  if ($expected -ne $actual) { Fail "checksum mismatch for $asset" } # -ne ignores case

  Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force (Join-Path $tmp 'diffle.exe') (Join-Path $dir 'diffle.exe')
} finally {
  Remove-Item -Recurse -Force $tmp
}

$exe = Join-Path $dir 'diffle.exe'
Write-Host "installed $(& $exe --version) to $exe"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $dir) | Where-Object { $_ }) -join ';', 'User')
  $env:Path = "$env:Path;$dir"
  Write-Host "added $dir to your user PATH; restart other terminals to pick it up"
}
