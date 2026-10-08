param(
    [string] $CopilotHome = $(if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' })
)
$ErrorActionPreference = 'Stop'
$plugins = & copilot plugin list --json
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect installed plugins.' }
$old = $plugins | ConvertFrom-Json | Where-Object { $_.name -eq 'basic-memory-copilot' -and $_.enabled }
if ($old) { throw 'Disable basic-memory-copilot and restart affected CLI sessions before installing the extension.' }
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'extension'
$destination = Join-Path $CopilotHome 'extensions\basic-memory-bridge'
if (Test-Path -LiteralPath $destination) { throw 'Extension destination already exists; inspect it before updating.' }
$null = New-Item -ItemType Directory -Path $destination
foreach ($name in @('extension.mjs', 'bridge.mjs', 'config.json')) {
    [System.IO.File]::Copy((Join-Path $source $name), (Join-Path $destination $name), $false)
}
Write-Output "Installed native extension: $destination"
Write-Output 'Start a fresh interactive CLI with --experimental; do not re-enable the old plugin.'
