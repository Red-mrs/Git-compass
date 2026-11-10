# Build the .vsix and install it into VS Code (Windows).
#   .\install.ps1               build + install
#   .\install.ps1 -NoInstall    only build the .vsix
#   .\install.ps1 -Test         run the tests first
# If PowerShell refuses to run scripts:  powershell -ExecutionPolicy Bypass -File .\install.ps1
param([switch]$NoInstall, [switch]$Test)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Find a JavaScript runtime: real Node.js if installed, otherwise the one bundled inside VS Code.
$runtime = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$useElectron = $false
if (-not $runtime) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
    "$env:ProgramFiles\Microsoft VS Code\Code.exe",
    "${env:ProgramFiles(x86)}\Microsoft VS Code\Code.exe"
  )
  $runtime = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $useElectron = $true
}
if (-not $runtime) { throw 'Could not find Node.js or VS Code (Code.exe).' }

function Invoke-Js([string[]]$arguments) {
  if ($useElectron) { $env:ELECTRON_RUN_AS_NODE = '1' }
  try {
    & $runtime @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $arguments" }
  } finally {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
}

if ($Test) {
  Invoke-Js @('test/unit.test.js')
  Invoke-Js @('test/manifest.test.js')
  Invoke-Js @('test/host.test.js')
}

Invoke-Js @('scripts/package.js')
$vsix = Get-ChildItem -Filter 'git-compass-*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $NoInstall) {
  code --install-extension $vsix.FullName --force
  Write-Host "Installed $($vsix.Name) - run 'Developer: Reload Window' in VS Code to load the new version."
}
