<#
.SYNOPSIS
  Stop a DSH web server started by launch-scratch-web.ps1.

.DESCRIPTION
  Reads scratch/logs/web-<Port>.pid, verifies through WMI that the PID still is a
  DeepSeek Harness process whose command line mentions the expected profile and
  the web entrypoint, then stops exactly that process. Never kills unrelated
  DeepSeek Harness processes (the user's desktop app / web profile).

.PARAMETER Port
  Port of the managed instance to stop. Default: 3090.

.PARAMETER Profile
  Expected profile name used as a command-line sanity check. Default:
  predictor-scratch.
#>
[CmdletBinding()]
param(
  [int]$Port = 3090,
  [string]$Profile = 'predictor-scratch',
  [string]$LogDir,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $LogDir) { $LogDir = Join-Path $repoRoot 'scratch\logs' }
$pidFile = Join-Path $LogDir "web-$Port.pid"
$urlFile = Join-Path $LogDir "web-$Port.url.txt"

$result = [ordered]@{ ok = $false; port = $Port; pid = $null; action = 'noop'; reason = '' }

if (-not (Test-Path -LiteralPath $pidFile)) {
  $result.ok = $true
  $result.reason = "no PID file at $pidFile (already stopped?)"
  if (-not $Quiet) { $result | ConvertTo-Json -Depth 4 }
  exit 0
}

$targetPid = 0
$raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if (-not [int]::TryParse($raw, [ref]$targetPid)) {
  throw "PID file $pidFile does not contain an integer: '$raw'"
}
$result.pid = $targetPid

$procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
if ($null -eq $procInfo) {
  Remove-Item -LiteralPath $pidFile, $urlFile -Force -ErrorAction SilentlyContinue
  $result.ok = $true
  $result.action = 'cleaned-stale'
  $result.reason = "PID $targetPid no longer exists"
  if (-not $Quiet) { $result | ConvertTo-Json -Depth 4 }
  exit 0
}

$cmd = [string]$procInfo.CommandLine
$looksLikeOurs =
  ($procInfo.Name -eq 'DeepSeek Harness.exe') -and
  ($cmd -match [regex]::Escape("--profile `"$Profile`"")) -and
  ($cmd -match 'dsh-desktop-host') -and
  ($cmd -match "(^|\s)--port\s+`"?$Port`"?(\s|$)")
if (-not $looksLikeOurs) {
  throw ("Refusing to kill PID ${targetPid}: command line does not look like the managed " +
    "predictor-scratch web server.`n$cmd")
}

Stop-Process -Id $targetPid -Force
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 250
}
$still = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($still) { throw "PID $targetPid is still running after Stop-Process." }

# Children of the Electron-as-Node process (if any) belong to the same managed instance.
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetPid" -ErrorAction SilentlyContinue
foreach ($child in $children) {
  if ($child.Name -eq 'DeepSeek Harness.exe') {
    Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
$result.ok = $true
$result.action = 'stopped'
$result.reason = "stopped managed web server on port $Port"
if (-not $Quiet) { $result | ConvertTo-Json -Depth 4 }


