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
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$version = & $node --version
if ($LASTEXITCODE -ne 0 -or [int]($version.TrimStart('v').Split('.')[0]) -lt 22) {
    throw 'Node.js 22 or newer is required.'
}
Push-Location -LiteralPath $root
try {
    $dependency = & $node --input-type=module --eval 'import {pathToFileURL,fileURLToPath} from "node:url"; const {utilityFiles}=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify({files:utilityFiles,root:fileURLToPath(new URL("../",import.meta.resolve("copilot-extension-utils/diagnostics/trace")))}));' (Join-Path $root 'scripts\install.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Run npm install in the repository before using the source installer.' }
    $dependency = $dependency | ConvertFrom-Json
} finally {
    Pop-Location
}
$files = @('extension.mjs', 'bridge.mjs', 'commands.mjs', 'status-publisher.mjs', 'diagnostics.mjs', 'config.json') |
    ForEach-Object { @{ source = Join-Path $source $_; target = Join-Path $destination $_ } }
$files += $dependency.files | ForEach-Object {
    @{ source = Join-Path $dependency.root $_; target = Join-Path (Join-Path $destination 'lib') $_ }
}
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file.source -PathType Leaf)) { throw "Missing installed source: $($file.source)" }
}
$null = New-Item -ItemType Directory -Path $destination
foreach ($file in $files) {
    $directory = Split-Path $file.target -Parent
    if (-not (Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory }
    [System.IO.File]::Copy($file.source, $file.target, $false)
}
Write-Output "Installed native extension: $destination"
Write-Output 'Start a fresh interactive CLI with --experimental; do not re-enable the old plugin.'
