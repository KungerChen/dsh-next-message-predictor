#requires -Version 5.1
<#
.SYNOPSIS
  Start/stop/status for the local mock LLM used by the predictor-scratch E2E profile.

.DESCRIPTION
  Wraps `node tools/mock-llm.mjs --port 3091` in a managed background process:
  stdout/stderr go to scratch/logs/mock-llm.{out,err}.log and the PID is kept in
  scratch/logs/mock-llm.pid. Only the process recorded in that PID file (verified
  through WMI by its node.exe command line) is ever stopped.

.PARAMETER Action
  start | stop | status. Default: status.
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'status',
  [int]$Port = 3091,
  [string]$Reply = '收到',
  [string]$LogDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $LogDir) { $LogDir = Join-Path $repoRoot 'scratch\logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$outLog = Join-Path $LogDir 'mock-llm.out.log'
$errLog = Join-Path $LogDir 'mock-llm.err.log'
$pidFile = Join-Path $LogDir 'mock-llm.pid'
$mockScript = Join-Path $repoRoot 'tools\mock-llm.mjs'

function Get-MockProc {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $targetPid = 0
  if (-not [int]::TryParse($raw, [ref]$targetPid)) { return $null }
  $info = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
  if ($null -eq $info) { return $null }
  if ($info.Name -ne 'node.exe' -or ([string]$info.CommandLine) -notmatch 'mock-llm\.mjs') { return $null }
  return $info
}

switch ($Action) {
  'status' {
    $proc = Get-MockProc
    $health = $null
    try {
      $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3).Content
    } catch { $health = $null }
    [ordered]@{
      running = ($null -ne $proc)
      pid = if ($null -ne $proc) { $proc.ProcessId } else { $null }
      health = $health
    } | ConvertTo-Json -Depth 4
  }
  'start' {
    $existing = Get-MockProc
    if ($null -ne $existing) { throw "mock LLM already running as PID $($existing.ProcessId)" }
    $node = (Get-Command node -ErrorAction Stop).Source
    Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath $node -PassThru -WindowStyle Hidden `
      -ArgumentList @("`"$mockScript`"", '--port', "$Port", '--reply', "`"$Reply`"") `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding utf8
    $deadline = (Get-Date).AddSeconds(20)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
      } catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $ok) { throw "mock LLM did not become healthy on port $Port. See $errLog" }
    [ordered]@{ ok = $true; pid = $proc.Id; port = $Port; reply = $Reply; stdoutLog = $outLog; pidFile = $pidFile } |
      ConvertTo-Json -Depth 4
  }
  'stop' {
    $proc = Get-MockProc
    if ($null -eq $proc) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      [ordered]@{ ok = $true; action = 'noop'; reason = 'mock LLM not running' } | ConvertTo-Json
      break
    }
    Stop-Process -Id $proc.ProcessId -Force
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    [ordered]@{ ok = $true; action = 'stopped'; pid = $proc.ProcessId } | ConvertTo-Json
  }
}
