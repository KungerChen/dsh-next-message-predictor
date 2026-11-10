<#
.SYNOPSIS
  Launch an isolated DSH web server for the predictor-scratch profile as a managed
  background process (direct Electron-as-Node process, no cmd.exe wrapper so the
  PID file points at the real server).

.DESCRIPTION
  Starts:
    "<HarnessRoot>\DeepSeek Harness.exe" --expose-internals <cli.js> `
        --profile <Profile> web --no-open --host <BindHost> --port <Port>

  with stdout/stderr redirected to scratch/logs/web-<Port>.out.log / .err.log,
  plus web-<Port>.pid and web-<Port>.url.txt. The advertised URL (which may carry
  an auth token) is parsed from the stdout log after ANSI stripping, then an HTTP
  200 check is performed before the script reports success.

  The process environment for the server is the current one plus
  ELECTRON_RUN_AS_NODE=1 (the same thing dsh.cmd does). DSH_PROFILE and
  DSH_PROFILE_DIR are deliberately overridden so the child never inherits the
  caller's desktop profile values.

.PARAMETER Profile
  DSH profile to boot. Default: predictor-scratch.

.PARAMETER Port
  Listen port. Default: 3090. Never reuse 3080 (user's web profile) or 59158
  (user's desktop app).

.PARAMETER HarnessRoot
  DeepSeek Harness install directory (the folder holding "DeepSeek Harness.exe").
  Default: $env:DSH_INSTALL_DIR, then "harnessRoot" in tools\local.config.json.

.PARAMETER ForceRestart
  Stop an instance previously started by this script on the same port first.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'predictor-scratch',
  [string]$BindHost = '127.0.0.1',
  [int]$Port = 3090,
  [string]$HarnessRoot,
  [string]$LogDir,
  [int]$BootTimeoutSec = 180,
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# Where DeepSeek Harness is installed differs per machine: -HarnessRoot, then
# $env:DSH_INSTALL_DIR, then "harnessRoot" in tools\local.config.json (a file
# git does not track; see tools\local.config.example.json).
if (-not $HarnessRoot) { $HarnessRoot = $env:DSH_INSTALL_DIR }
if (-not $HarnessRoot) {
  $localConfig = Join-Path $PSScriptRoot 'local.config.json'
  if (Test-Path -LiteralPath $localConfig) {
    $HarnessRoot = (Get-Content -LiteralPath $localConfig -Raw -Encoding UTF8 | ConvertFrom-Json).harnessRoot
  }
}
if (-not $HarnessRoot) {
  throw 'The DeepSeek Harness install directory is not set. Pass -HarnessRoot, set DSH_INSTALL_DIR, or put "harnessRoot" in tools\local.config.json (see tools\local.config.example.json).'
}
# DSH keeps profiles under its home directory; default to the standard place.
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }
if (-not $LogDir) { $LogDir = Join-Path $repoRoot 'scratch\logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$outLog  = Join-Path $LogDir "web-$Port.out.log"
$errLog  = Join-Path $LogDir "web-$Port.err.log"
$pidFile = Join-Path $LogDir "web-$Port.pid"
$urlFile = Join-Path $LogDir "web-$Port.url.txt"

$exe = Join-Path $HarnessRoot 'DeepSeek Harness.exe'
$cli = Join-Path $HarnessRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
# NOTE: cli.js lives inside app.asar, which only Electron can see; Test-Path would
# report it missing even though the Electron-as-Node runtime can load it fine.
if (-not (Test-Path -LiteralPath $exe)) { throw "Missing DSH executable: $exe" }
if ($Port -in 3080, 59158) { throw "Refusing reserved port $Port (3080 = user web profile, 59158 = user desktop app)." }

# Refuse to double-start on the same port.
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  if ($ForceRestart) {
    & (Join-Path $PSScriptRoot 'stop-scratch-web.ps1') -Port $Port -Profile $Profile | Out-Null
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  }
  if ($listener) {
    throw "Port $Port is already in use by PID $($listener.OwningProcess). Refusing to touch it."
  }
}

Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue

# The profile decides which app boots (dsh-web-app bundle); remaining flags are the
# web app's own flags. Do NOT pass a literal "web" token here: with --profile it
# would be treated as an app argument and rejected ("too many arguments").
$args = '--expose-internals "{0}" --profile "{1}" --no-open --host "{2}" --port {3}' -f `
  $cli, $Profile, $BindHost, $Port

$started = Get-Date
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_PROFILE = $Profile
$env:DSH_PROFILE_DIR = Join-Path (Join-Path $env:DSH_HOME 'profiles') $Profile
$env:DSH_WEB_URL = ''
# Keep the predictor's ledger and events.jsonl out of the user's real ~/.dsh data:
# the scratch host writes them under scratch\data-home instead.
if (-not $env:NMP_DATA_HOME) { $env:NMP_DATA_HOME = Join-Path $repoRoot 'scratch\data-home' }
New-Item -ItemType Directory -Force -Path $env:NMP_DATA_HOME | Out-Null
# Placeholder credential for the local mock provider route (`llm-pi-ai` provider
# `mock` in the predictor-scratch patch). tools/mock-llm.mjs ignores it; it only
# satisfies pi-ai's OpenAI-compatible requirement that an Authorization key exist.
$env:MOCK_API_KEY = 'mock-local-e2e-key'
# Do not inherit the caller profile's runtime context facts.
Remove-Item Env:DSH_SESSION_ID -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $exe -ArgumentList $args -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding utf8

function Read-LogText([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  $raw = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { return '' }
  # Strip ANSI/VT100 escape sequences so URL parsing is stable.
  return ($raw -replace "\x1b\[[0-9;?]*[ -/]*[@-~]", '')
}

$url = $null
$httpStatus = $null
$deadline = (Get-Date).AddSeconds($BootTimeoutSec)
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    $tail = (Read-LogText $outLog) + "`n" + (Read-LogText $errLog)
    throw "predictor-scratch web server exited during boot (exit code $($proc.ExitCode)). Logs:`n$tail"
  }
  $text = Read-LogText $outLog
  $m = [regex]::Match($text, "https?://[^\s'`"]+")
  if ($m.Success) {
    $candidate = $m.Value.TrimEnd('.', ',', ')', ']', '}')
    if (-not $candidate.Contains(":$Port")) {
      # Prefer the advertised line that mentions our port; fall back to the first URL.
      $all = [regex]::Matches($text, "https?://[^\s'`"]+") | ForEach-Object { $_.Value }
      $preferred = $all | Where-Object { $_ -like "*:$Port*" } | Select-Object -First 1
      if ($preferred) { $candidate = $preferred.TrimEnd('.', ',', ')', ']', '}') }
    }
    try {
      $resp = Invoke-WebRequest -Uri $candidate -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
      $url = $candidate
      $httpStatus = [int]$resp.StatusCode
      break
    } catch {
      # URL printed before the listener accepted requests; keep polling.
    }
  }
  Start-Sleep -Milliseconds 500
  $proc.Refresh()
}

if (-not $url) {
  $tail = ((Read-LogText $outLog) + "`n" + (Read-LogText $errLog))
  if ($tail.Length -gt 4000) { $tail = $tail.Substring($tail.Length - 4000) }
  & (Join-Path $PSScriptRoot 'stop-scratch-web.ps1') -Port $Port -Profile $Profile -Quiet | Out-Null
  throw "Timed out after ${BootTimeoutSec}s waiting for a healthy URL on port $Port. Log tail:`n$tail"
}

Set-Content -LiteralPath $urlFile -Value $url -Encoding utf8

$result = [ordered]@{
  ok           = $true
  profile      = $Profile
  pid          = $proc.Id
  host         = $BindHost
  port         = $Port
  url          = $url
  httpStatus   = $httpStatus
  startedAt    = $started.ToString('o')
  bootSeconds  = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  stdoutLog    = $outLog
  stderrLog    = $errLog
  pidFile      = $pidFile
  urlFile      = $urlFile
}
$result | ConvertTo-Json -Depth 4

