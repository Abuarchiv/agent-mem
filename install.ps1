param(
  [string]$Project,
  [string]$Agents
)

$ErrorActionPreference = 'Stop'
$baseUrl = if ($env:AGENT_MEMORY_V1_BASE_URL) { $env:AGENT_MEMORY_V1_BASE_URL } else { 'https://github.com/Abuarchiv/agent-memory-v1/releases/latest/download' }
$version = if ($env:AGENT_MEMORY_V1_VERSION) { $env:AGENT_MEMORY_V1_VERSION } else { 'latest' }
if (-not $baseUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'installer_requires_https' }

$architecture = $env:PROCESSOR_ARCHITECTURE
if ($architecture -eq 'ARM64') { $target = 'win-arm64' }
elseif ($architecture -eq 'AMD64' -or $architecture -eq 'x86_64') { $target = 'win-x64' }
else { throw 'native_platform_unsupported' }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('agent-memory-v1-' + [guid]::NewGuid().ToString('N'))
$archive = "agent-memory-v1-$target.zip"
$archivePath = Join-Path $temp $archive
$checksumPath = "$archivePath.sha256"
$unpacked = Join-Path $temp 'unpacked'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  Invoke-WebRequest -Uri "$baseUrl/$archive" -OutFile $archivePath
  Invoke-WebRequest -Uri "$baseUrl/$archive.sha256" -OutFile $checksumPath
  $expected = ((Get-Content -Raw $checksumPath).Trim() -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw 'native_archive_hash_mismatch' }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $unpacked -Force
  $package = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
  if ($null -eq $package -or -not (Test-Path (Join-Path $package.FullName 'memory.cmd')) -or -not (Test-Path (Join-Path $package.FullName 'manifest.json'))) { throw 'native_archive_invalid' }

  $installRoot = Join-Path $env:LOCALAPPDATA 'agent-memory-v1'
  $releaseRoot = Join-Path $installRoot 'releases'
  $release = Join-Path $releaseRoot "$target-$version"
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  if (Test-Path $release) { Move-Item -LiteralPath $release -Destination "$release.previous.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" }
  Move-Item -LiteralPath $package.FullName -Destination $release

  $bin = Join-Path $installRoot 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $launcher = Join-Path $bin 'memory.cmd'
  Set-Content -LiteralPath $launcher -Encoding ASCII -Value "@echo off`r`ncall `"$release\memory.cmd`" %*`r`nexit /b %errorlevel%`r`n"
  Write-Output "Agent Memory V1 installed: $target"
  Write-Output "Add $bin to PATH, then run: memory install"
  if ($Project) {
    if ($Agents) { & $launcher install --project $Project --agents $Agents --yes }
    else { & $launcher install --project $Project --yes }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
