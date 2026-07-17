<#
.SYNOPSIS
    Windows convenience wrapper. Forwards to the cross-platform Node CLI
    (bin/workbuddy-skin.mjs apply). Kept for muscle memory; the CLI is the
    single source of truth.

.EXAMPLE
    .\scripts\start-skin.ps1 -BackgroundImage C:\wallpapers\aurora.jpg -Watch
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$Theme,
    [string]$BackgroundImage,
    [string]$WorkBuddyPath,
    [switch]$RestartExisting,
    [switch]$Watch,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Write-Error "Node.js not found on PATH. Install Node 18+ and retry."; exit 1 }
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\workbuddy-skin.mjs'

$cliArgs = @('apply')
if ($Port -gt 0)        { $cliArgs += @('--port', "$Port") }
if ($Theme)             { $cliArgs += @('--theme', $Theme) }
if ($BackgroundImage)   { $cliArgs += @('--bg', $BackgroundImage) }
if ($WorkBuddyPath)     { $cliArgs += @('--exe', $WorkBuddyPath) }
if ($RestartExisting)   { $cliArgs += '--restart' }
if ($Watch)             { $cliArgs += '--watch' }
if ($NoLaunch)          { $cliArgs += '--no-launch' }

& node $entry @cliArgs
exit $LASTEXITCODE
