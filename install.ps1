# Installs agent-mem with uv (uv installs a suitable Python by itself).
$ErrorActionPreference = "Stop"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "Installing uv..."
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
uv tool install --upgrade "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"
uv tool update-shell | Out-Null
Write-Host ""
Write-Host "Installed. Next steps:"
Write-Host "  agent-mem setup claude --write    # or: codex, copilot, opencode (writes hooks + MCP with absolute paths)"
Write-Host "Write-Host "  agent-mem doctor"
