<#
.SYNOPSIS
    Windows convenience wrapper. Forwards to the cross-platform Node CLI
    (bin/workbuddy-skin.mjs install).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-skin.ps1
#>
[CmdletBinding()]
param(
    [string]$WorkBuddyPath
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error "Node.js not found on PATH. Install Node 18+ and retry."; exit 1 }
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\workbuddy-skin.mjs'

$cliArgs = @('install')
if ($WorkBuddyPath) { $cliArgs += @('--exe', $WorkBuddyPath) }

& node $entry @cliArgs
exit $LASTEXITCODE
<#
.SYNOPSIS
    Install / prepare WorkBuddy Skin (one-time). Validates Node, locates WorkBuddy,
    seeds the default theme into the local theme store. Does NOT modify WorkBuddy files.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-skin.ps1
#>
[CmdletBinding()]
param(
    [string]$WorkBuddyPath
)

. "$PSScriptRoot\common.ps1"

Write-WBInfo "Installing WorkBuddy Skin ..."

# 1. Node
$node = Get-WBNode
Write-WBOk "Node found: $node ($(& node --version))"

# 2. WorkBuddy
$exe = Get-WBExecutable -Override $WorkBuddyPath
Write-WBOk "WorkBuddy found: $exe"

# 3. State + theme store
$state = Get-WBStateDir
$themesDir = Join-Path $state 'themes'
if (-not (Test-Path $themesDir)) { New-Item -ItemType Directory -Path $themesDir -Force | Out-Null }

$defaultTheme = Join-Path $script:WBSkinAssets 'theme.json'
$seeded = Join-Path $themesDir 'aurora-glass.json'
Copy-Item -Path $defaultTheme -Destination $seeded -Force
Write-WBOk "Seeded default theme -> $seeded"

# 4. Persist install state
Save-WBState @{
    exe          = $exe
    installedAt  = (Get-Date).ToString('o')
    activeTheme  = 'aurora-glass'
    projectRoot  = $script:WBSkinRoot
}

Write-Host ""
Write-WBOk "Install complete."
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  Apply skin :  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\start-skin.ps1`"" -ForegroundColor Gray
Write-Host "  Restore    :  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\restore-skin.ps1`"" -ForegroundColor Gray
Write-Host "  Custom bg  :  ...\start-skin.ps1 -BackgroundImage C:\path\to\wallpaper.jpg" -ForegroundColor Gray
