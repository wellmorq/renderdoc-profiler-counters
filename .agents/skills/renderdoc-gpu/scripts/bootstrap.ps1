# First run on Windows: make sure Node.js 18+ exists (portable copy in the user profile, no admin),
# then run `rdgpu.mjs install` with the given arguments.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <skill>\scripts\bootstrap.ps1 [install args]
#   -NodeOnly   only find/install Node and print its path
# Works with Windows PowerShell 5.1 and PowerShell 7.
param(
  [switch]$NodeOnly,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar in 5.1

$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/share' }
$nodeDir = Join-Path $base 'rdgpu\node'
$portable = Join-Path $nodeDir 'node.exe'

function Test-Node([string]$exe) {
  try {
    $v = & $exe --version 2>$null
    if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18) { return $true }
  } catch { }
  return $false
}

$node = $null
if ((Test-Path $portable) -and (Test-Node $portable)) { $node = $portable }
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Node $cmd.Source)) { $node = $cmd.Source }
  elseif ($cmd) { Write-Host "[info] $($cmd.Source) is older than Node 18; installing a portable copy next to it" }
}

if (-not $node) {
  Write-Host "[do] installing portable Node.js LTS into $nodeDir (no admin rights needed)"
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
  $rel = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
  if (-not $rel) { throw "no Node.js LTS build for win-$arch found in https://nodejs.org/dist/index.json" }
  $ver = $rel.version
  $name = "node-$ver-win-$arch"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "rdgpu-$name"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory $tmp | Out-Null
  $zip = Join-Path $tmp "$name.zip"
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip
  $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
  $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))\s*$" } | Select-Object -First 1
  if (-not $line) { throw "checksum for $name.zip not found in SHASUMS256.txt" }
  $want = ($line -split '\s+')[0].ToLower()
  $have = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $have) { throw "checksum mismatch for $name.zip (download corrupted or intercepted)" }
  Expand-Archive $zip -DestinationPath $tmp -Force
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  New-Item -ItemType Directory (Split-Path $nodeDir) -Force | Out-Null
  Move-Item (Join-Path $tmp $name) $nodeDir
  Remove-Item $tmp -Recurse -Force
  if (-not (Test-Node $portable)) { throw "installed $portable but it does not run" }
  $node = $portable
  Write-Host "[ok] Node.js $ver installed"
}

Write-Host "[ok] node: $node"
$cli = Join-Path $PSScriptRoot 'rdgpu.mjs'
Write-Host "Run the CLI as:  & `"$node`" `"$cli`" <command> ..."
if ($NodeOnly) { exit 0 }
& $node $cli install @Rest
exit $LASTEXITCODE
