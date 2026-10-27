# Installs agent-mem with uv (uv installs a suitable Python by itself).
$ErrorActionPreference = "Stop"

# Run as `irm .../install.ps1 | iex`: `exit` would close the user's window before the message can be read.
function Fail($message) {
  throw "agent-mem install failed: $message"
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "Installing uv..."
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "uv is not installed or not on PATH (network?). See https://docs.astral.sh/uv/, open a new terminal and run this again."
  }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "git is missing; uv needs it to fetch agent-mem. Install Git for Windows (winget install Git.Git) and run this again."
}
# Search by meaning (onnxruntime) needs the Visual C++ runtime; a fresh Windows often lacks it and the import fails
# with "DLL load failed". Its installer asks for administrator rights once.
$system = Join-Path $env:SystemRoot "System32"
if (-not ((Test-Path "$system\msvcp140.dll") -and (Test-Path "$system\vcruntime140_1.dll"))) {
  Write-Host "Installing the Microsoft Visual C++ runtime (search by meaning needs it)..."
  try {
    $redist = Join-Path $env:TEMP "vc_redist.x64.exe"
    $ProgressPreference = "SilentlyContinue"  # PowerShell 5.1 downloads many times slower while it draws progress
    Invoke-WebRequest https://aka.ms/vs/17/release/vc_redist.x64.exe -OutFile $redist -UseBasicParsing
    Start-Process $redist -ArgumentList "/install", "/quiet", "/norestart" -Verb RunAs -Wait
  } catch {
    Write-Host "Skipped ($_). Search by words works; for search by meaning install https://aka.ms/vs/17/release/vc_redist.x64.exe"
  }
}
$before = if (Get-Command agent-mem -ErrorAction SilentlyContinue) { agent-mem --version } else { "" }
# Windows cannot replace the folder the viewer and background jobs run from: uv failed half way and left agent-mem
# without its package (then `agent-mem --version` above prints nothing, so this runs either way). Open sessions'
# MCP servers run through ~/.local/bin and keep running.
$tools = (Join-Path (uv tool dir) "agent-mem").ToLower()
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($tools) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# 3.13: uv would take the newest Python, and onnxruntime (search by meaning) has no wheels for it yet (3.15).
uv tool install --upgrade --python 3.13 "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"
if ($LASTEXITCODE -ne 0) { Fail "uv could not install agent-mem. The error above names the cause." }
uv tool update-shell | Out-Null
$exe = Join-Path (uv tool dir --bin) "agent-mem.exe"  # the copy just installed, even before PATH knows it
if ($before) {
  Write-Host "Updated: $before -> $(& $exe --version)"
  & $exe doctor --fix  # migrates the database, rewrites hooks an older release wrote
} else {
  Write-Host ""
  Write-Host "Installed. Connecting every harness on PATH..."
  & $exe setup all --write
  if ($LASTEXITCODE -ne 0) { Write-Host "No harness connected yet. Later: agent-mem setup all --write (or: claude, codex, copilot, opencode)" }
  Write-Host ""
  Write-Host "Undo with: agent-mem uninstall all. Check with: agent-mem doctor"
  Write-Host "If 'agent-mem' is not found, open a new terminal (uv added it to your PATH)."
}
