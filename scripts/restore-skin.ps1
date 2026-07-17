<#
.SYNOPSIS
    Windows convenience wrapper. Forwards to the cross-platform Node CLI
    (bin/workbuddy-skin.mjs restore).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\restore-skin.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$KeepOpen,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error "Node.js not found on PATH. Install Node 18+ and retry."; exit 1 }
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\workbuddy-skin.mjs'

$cliArgs = @('restore')
if ($Port -gt 0)   { $cliArgs += @('--port', "$Port") }
if ($KeepOpen)     { $cliArgs += '--keep-open' }
if ($Uninstall)    { $cliArgs += '--uninstall' }

& node $entry @cliArgs
exit $LASTEXITCODE
<#
.SYNOPSIS
    Remove the WorkBuddy skin and restore the official appearance.
    Stops the watch daemon, does a best-effort live cleanup, then relaunches
    WorkBuddy normally (no debug port) for a guaranteed clean renderer.

.PARAMETER KeepOpen   Do not relaunch WorkBuddy after cleanup (leave it closed / as-is).
.PARAMETER Uninstall  Also delete the local state/theme store (%LOCALAPPDATA%\WorkBuddySkin).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\restore-skin.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$KeepOpen,
    [switch]$Uninstall
)

. "$PSScriptRoot\common.ps1"

$state = Get-WBState
$node = $null
try { $node = Get-WBNode } catch { Write-WBWarn "Node not found; skipping live cleanup." }

# ---- 1. Stop the watch daemon ----------------------------------------------
if ($state -and $state.watchPid) {
    try {
        $wp = Get-Process -Id ([int]$state.watchPid) -ErrorAction SilentlyContinue
        if ($wp) { $wp | Stop-Process -Force -ErrorAction SilentlyContinue; Write-WBInfo "Stopped watch daemon PID $($state.watchPid)." }
    } catch {}
}

# ---- 2. Best-effort live cleanup via CDP -----------------------------------
if ($Port -le 0 -and $state -and $state.port) { $Port = [int]$state.port }
if ($node -and $Port -gt 0) {
    $injector = Join-Path $PSScriptRoot 'injector.mjs'
    try {
        & $node $injector remove --port $Port
    } catch { Write-WBWarn "Live cleanup skipped: $($_.Exception.Message)" }
}

# ---- 3. Determine exe, then relaunch clean ---------------------------------
$exe = $null
if ($state -and $state.exe -and (Test-Path $state.exe)) { $exe = $state.exe }
else { try { $exe = Get-WBExecutable } catch { Write-WBWarn "WorkBuddy exe not found; will not relaunch." } }

Stop-WBProcesses

if (-not $KeepOpen -and $exe) {
    Start-Sleep -Milliseconds 500
    Start-WBNormal -Exe $exe
}

# ---- 4. Update / remove state ----------------------------------------------
if ($Uninstall) {
    $dir = $script:WBSkinState
    if (Test-Path $dir) {
        Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
        Write-WBOk "Removed local store: $dir"
    }
} else {
    if ($state) {
        Save-WBState @{
            exe         = if ($state.exe) { $state.exe } else { $exe }
            port        = 0
            activeTheme = if ($state.activeTheme) { $state.activeTheme } else { 'aurora-glass' }
            watchPid    = $null
            restoredAt  = (Get-Date).ToString('o')
            projectRoot = $script:WBSkinRoot
        }
    }
}

Write-WBOk "Restore complete. WorkBuddy is back to its official appearance."
