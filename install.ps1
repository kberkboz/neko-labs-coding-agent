# Neko Labs Coding Agent installer (Windows / PowerShell).
# Run from the cloned repo:  ./install.ps1
$ErrorActionPreference = "Stop"

Write-Host "Installing Neko Labs Coding Agent..."

# 1. Ensure Bun.
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Bun not found. Installing Bun from bun.sh..."
  powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw "Could not find Bun after install. Install it from https://bun.sh and re-run."
}

# 2. Repo = the directory this script lives in.
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Repo
$Pkg = "$Repo\packages\opencode"

# 3. Dependencies (builds native modules; needs VS Build Tools + Python on Windows).
Write-Host "Installing dependencies (this can take a few minutes)..."
bun install

# 4. Install the 'neko' launcher into a bin dir on PATH.
$Bin = "$env:USERPROFILE\.neko\bin"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

@"
@echo off
set "NEKO_PKG=$Pkg"
if "%~1"=="" (
  bun run --cwd "%NEKO_PKG%" --conditions=browser src/index.ts "%CD%"
) else (
  bun run --cwd "%NEKO_PKG%" --conditions=browser src/index.ts %*
)
"@ | Set-Content -Encoding ASCII "$Bin\neko.cmd"

@"
`$NekoPkg = "$Pkg"
if (`$args.Count -eq 0) {
  & bun run --cwd `$NekoPkg --conditions=browser src/index.ts (Get-Location).Path
} else {
  & bun run --cwd `$NekoPkg --conditions=browser src/index.ts @args
}
"@ | Set-Content -Encoding UTF8 "$Bin\neko.ps1"

# 5. Add the bin dir to the user PATH if it isn't already there.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$Bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$Bin", "User")
  Write-Host "Added $Bin to your PATH."
}

Write-Host ""
Write-Host "Installed. Open a new terminal and run 'neko' in any project."
