<# : batch portion
@echo off
rem Photo Organizer - free AI setup. Windows runs these lines first, then hands the rest of this file to PowerShell.
title Photo Organizer - free AI setup
set "PO_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:PO_SELF))"
echo.
pause
exit /b
#>

# Photo Organizer: free AI setup. Developed by Chip.
# Double-click this file. It does everything by itself, nothing to type:
#   1. lets the Photo Organizer page use the AI program (OLLAMA_ORIGINS, for your Windows account only)
#   2. installs Ollama, the free AI program (no admin needed), or keeps the one you have
#   3. starts Ollama again so it uses that setting
#   4. downloads the AI (Gemma 4, about 5 GB). Run it again any time: it skips what is done
#      and a stopped download continues where it stopped.
# Your photos never go to the internet: the AI runs on this PC.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$AppOrigin = 'https://mateiuc.github.io'
$Model = 'huggingface.co/ggml-org/gemma-4-E4B-it-GGUF:Q4_0'
$SetupUrls = @('https://ollama.com/download/OllamaSetup.exe', 'https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe')
$Api = 'http://127.0.0.1:11434'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step([int]$n, [string]$text) { Write-Host ''; Write-Host "Step $n of 4: $text" -ForegroundColor Cyan }

# Where ollama.exe is, or $null when Ollama isn't installed.
function Find-Ollama {
  $c = Get-Command 'ollama.exe' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

# Downloads a file, with a progress bar when curl.exe is there (Windows 10 and 11 have it).
function Get-File([string]$url, [string]$to) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path -LiteralPath $curl) {
    & $curl -L --fail --retry 3 -# -o $to $url
    return ($LASTEXITCODE -eq 0)
  }
  try { Invoke-WebRequest -Uri $url -OutFile $to -UseBasicParsing; return $true } catch { return $false }
}

# What Ollama answers to a page from $origin: 200 = allowed, 403 = refused, 0 = Ollama not running.
function Test-Api([string]$origin) {
  try {
    $headers = @{}
    if ($origin) { $headers['Origin'] = $origin }
    $r = Invoke-WebRequest -Uri "$Api/api/version" -Headers $headers -UseBasicParsing -TimeoutSec 3
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
}

function Wait-Api([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if ((Test-Api '') -eq 200) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Stops Ollama and starts it again, so it reads the setting from step 1.
function Restart-Ollama([string]$exe) {
  $dir = Split-Path -Parent $exe
  Get-Process -Name 'ollama app', 'ollama', 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $app = Join-Path $dir 'ollama app.exe'
  if (Test-Path -LiteralPath $app) { Start-Process -FilePath $app | Out-Null }
  if (Wait-Api 40) { return $true }
  # The tray app didn't start the AI server: start the server by itself, hidden.
  Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
  return (Wait-Api 30)
}

# The graphics card(s) and their memory, to show at the end (the app also shows whether the AI uses the card).
function Get-Cards {
  $list = @()
  try {
    $keys = Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue
    foreach ($k in $keys) {
      $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
      if (-not $p -or -not $p.DriverDesc) { continue }
      $mem = $p.'HardwareInformation.qwMemorySize'
      if (-not $mem) { $mem = $p.'HardwareInformation.MemorySize' }
      if ($mem -is [byte[]]) { $mem = [BitConverter]::ToUInt32($mem, 0) }
      $gbText = ''
      if ($mem) { $gbText = ', ' + [math]::Round([double]$mem / 1GB, 1) + ' GB' }
      $list += ($p.DriverDesc + $gbText)
    }
  } catch {}
  return $list
}

function Main {
  Say ''
  Say 'Photo Organizer: free AI setup' 'White'
  Say 'Developed by Chip' 'DarkGray'
  Say 'This installs a free AI on this PC. Nothing to type: just wait until it says it is done.'

  Step 1 'let the Photo Organizer page use the AI'
  $old = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
  $list = @()
  if ($old) { $list = @($old.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  if ($list -contains $AppOrigin) {
    Say 'Already allowed.' 'Green'
  } else {
    $list += $AppOrigin
    [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', ($list -join ','), 'User')
    Say 'Done (a setting for your Windows account only).' 'Green'
  }
  # Ollama started from here (or by its installer) gets the setting right away.
  $env:OLLAMA_ORIGINS = ($list -join ',')

  Step 2 'the free AI program (Ollama)'
  $exe = Find-Ollama
  if ($exe) {
    Say "Already installed: $exe" 'Green'
  } else {
    $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
    $got = $false
    foreach ($u in $SetupUrls) {
      Say "Downloading Ollama from $u (about 1 GB)..."
      if (Get-File $u $setup) { $got = $true; break }
    }
    if (-not $got) { throw 'Ollama could not be downloaded. Check the internet connection, then double-click this file again.' }
    Say 'Installing Ollama (no admin needed, takes a minute or two)...'
    # Waits for the installer only: its last step starts Ollama, which keeps running (so no -Wait, which would wait for that too).
    $p = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-' -PassThru
    $null = $p.Handle
    $p.WaitForExit()
    Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
    $exe = Find-Ollama
    if (-not $exe) { throw "The Ollama installer stopped (code $($p.ExitCode)). Double-click this file again; if it happens again, send Chip a photo of this window." }
    Say "Installed: $exe" 'Green'
  }

  Step 3 'start Ollama with the new setting'
  if ((Test-Api $AppOrigin) -eq 200) {
    Say 'Ollama is running and lets the page in.' 'Green'
  } else {
    if (-not (Restart-Ollama $exe)) { throw 'Ollama did not start. Restart the PC, then double-click this file again.' }
    $code = Test-Api $AppOrigin
    if ($code -eq 200) { Say 'Ollama is running and lets the page in.' 'Green' }
    else { Say "Ollama is running, but it answered $code to the page. Restart the PC, then double-click this file again." 'Yellow' }
  }

  Step 4 'download the AI (Gemma 4, about 5 GB; it can take a while)'
  & $exe pull $Model
  if ($LASTEXITCODE -ne 0) { throw 'The AI download stopped. Double-click this file again: it continues where it stopped.' }
  Say 'The AI is ready.' 'Green'

  $cards = Get-Cards
  if ($cards.Count) { Say ''; Say ('Graphics card: ' + ($cards -join ' | ')) }
  Say ''
  Say 'All done.' 'Green'
  Say 'Go back to Photo Organizer in Chrome and open "Try the AI": it finds the AI by itself.'
  Say 'If Chrome asks whether the site may connect to apps on this PC, click Allow.'
}

try { Main } catch {
  Say ''
  Say ('Stopped: ' + $_.Exception.Message) 'Red'
}
