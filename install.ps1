param(
  [string]$Project,
  [string]$Agents
)

$ErrorActionPreference = 'Stop'
$baseUrl = if ($env:AGENT_MEM_BASE_URL) { $env:AGENT_MEM_BASE_URL } elseif ($env:AGENT_MEMORY_V1_BASE_URL) { $env:AGENT_MEMORY_V1_BASE_URL } else { 'https://github.com/Abuarchiv/agent-mem/releases/latest/download' }
$version = if ($env:AGENT_MEM_VERSION) { $env:AGENT_MEM_VERSION } elseif ($env:AGENT_MEMORY_V1_VERSION) { $env:AGENT_MEMORY_V1_VERSION } else { 'latest' }
if (-not $baseUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'installer_requires_https' }
if ($version -notmatch '^(latest|v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$') { throw 'installer_version_invalid' }

$supportedTargets = 'darwin-arm64 darwin-x64 linux-x64 win-x64'
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -eq 'ARM64') { throw "native_target_not_published (supported: $supportedTargets)" }
elseif ($architecture -eq 'AMD64' -or $architecture -eq 'x86_64') { $target = 'win-x64' }
else { throw "native_platform_unsupported (supported: $supportedTargets)" }

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('agent-mem-' + [guid]::NewGuid().ToString('N'))
$archive = "agent-mem-$target.zip"
$archivePath = Join-Path $temp $archive
$checksumPath = "$archivePath.sha256"
$unpacked = Join-Path $temp 'unpacked'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  try {
    Invoke-WebRequest -Uri "$baseUrl/$archive" -OutFile $archivePath
    Invoke-WebRequest -Uri "$baseUrl/$archive.sha256" -OutFile $checksumPath
  } catch {
    throw 'native_archive_download_failed'
  }
  $expected = ((Get-Content -Raw $checksumPath).Trim() -split '\s+')[0].ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'native_archive_checksum_invalid' }
  try { $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant() }
  catch { throw 'native_archive_hash_failed' }
  if ($expected -ne $actual) { throw 'native_archive_hash_mismatch' }
  try { Expand-Archive -LiteralPath $archivePath -DestinationPath $unpacked -Force }
  catch { throw 'native_archive_invalid' }
  $package = Join-Path $unpacked 'agent-mem-package'
  if (-not (Test-Path -LiteralPath $package -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $package 'agent-mem.cmd') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $package 'manifest.json') -PathType Leaf)) { throw 'native_archive_invalid' }

  $dataHome = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Local' }
  if (-not [System.IO.Path]::IsPathRooted($dataHome)) { throw 'installer_data_path_invalid' }
  $installRoot = Join-Path $dataHome 'agent-mem'
  $releaseRoot = Join-Path $installRoot 'releases'
  $release = Join-Path $releaseRoot "$target-$version"
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  $previousRelease = $null
  if (Test-Path -LiteralPath $release) {
    $previousRelease = "$release.previous.$([guid]::NewGuid().ToString('N'))"
    Move-Item -LiteralPath $release -Destination $previousRelease
  }
  try { Move-Item -LiteralPath $package -Destination $release }
  catch {
    if ($previousRelease -and -not (Test-Path -LiteralPath $release) -and (Test-Path -LiteralPath $previousRelease)) { Move-Item -LiteralPath $previousRelease -Destination $release -ErrorAction SilentlyContinue }
    throw 'native_activation_failed'
  }

  $bin = Join-Path $installRoot 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $launcher = Join-Path $bin 'agent-mem.cmd'
  if (Test-Path -LiteralPath $launcher) { Move-Item -LiteralPath $launcher -Destination "$launcher.previous.$([guid]::NewGuid().ToString('N'))" }
  try { Set-Content -LiteralPath $launcher -Encoding ASCII -Value "@echo off`r`ncall `"$release\agent-mem.cmd`" %*`r`nexit /b %errorlevel%`r`n" }
  catch { throw 'native_launcher_activation_failed' }
  $legacyLauncher = Join-Path $bin 'memory.cmd'
  if (Test-Path -LiteralPath $legacyLauncher) { Move-Item -LiteralPath $legacyLauncher -Destination "$legacyLauncher.previous.$([guid]::NewGuid().ToString('N'))" }
  try { Set-Content -LiteralPath $legacyLauncher -Encoding ASCII -Value "@echo off`r`ncall `"$release\agent-mem.cmd`" %*`r`nexit /b %errorlevel%`r`n" }
  catch { throw 'native_launcher_activation_failed' }
  Write-Output "Agent Mem installed: $target"
  Write-Output "Add $bin to PATH, then run: agent-mem install"
  if ($Project) {
    if ($Agents) { & $launcher install --project $Project --agents $Agents --yes }
    else { & $launcher install --project $Project --yes }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
finally {
  if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
