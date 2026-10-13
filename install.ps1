# Installs agent-mem with uv (uv installs a suitable Python by itself).
$ErrorActionPreference = "Stop"

function Fail($message) {
  Write-Host "agent-mem install failed: $message" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "Installing uv..."
  try {
    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  } catch {
    Fail "could not install uv (network?). See https://docs.astral.sh/uv/ and run this again."
  }
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "uv was installed but is not on PATH. Open a new terminal and run this again."
  }
}
$before = if (Get-Command agent-mem -ErrorAction SilentlyContinue) { agent-mem --version } else { "" }
uv tool install --upgrade "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"
if ($LASTEXITCODE -ne 0) { Fail "uv could not install agent-mem (network or git missing?). The error above names the cause." }
uv tool update-shell | Out-Null
$exe = Join-Path (uv tool dir --bin) "agent-mem.exe"  # the copy just installed, even before PATH knows it
if ($before) {
  Write-Host "Updated: $before -> $(& $exe --version)"
  & $exe doctor --fix  # migrates the database, rewrites hooks an older release wrote
  exit 0
}
Write-Host ""
Write-Host "Installed. Connecting every harness on PATH..."
& $exe setup all --write
if ($LASTEXITCODE -ne 0) { Write-Host "No harness connected yet. Later: agent-mem setup all --write (or: claude, codex, copilot, opencode)" }
Write-Host ""
Write-Host "Undo with: agent-mem uninstall all. Check with: agent-mem doctor"
Write-Host "If 'agent-mem' is not found, open a new terminal (uv added it to your PATH)."
