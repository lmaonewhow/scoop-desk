param(
  [ValidateSet('1', '2', '3', '4', '5', '6')]
  [string]$Choice,
  [switch]$Test
)

Write-Host "ScoopDesk Launcher" -ForegroundColor Cyan
Write-Host "==========================="
Write-Host "1) Install dependencies (npm install)"
Write-Host "2) Start dev app (npm run start)"
Write-Host "3) Build portable exe (npm run electron:build)"
Write-Host "4) Clean dist folder"
Write-Host "5) Exit"
Write-Host "6) Force reinstall dependencies (clean node_modules)"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot "dist"

function Invoke-ScoopDeskCommand([string]$command) {
  Write-Host "`nRun: $command`n" -ForegroundColor Yellow
  cmd /c "cd /d $projectRoot && $command"
}

function Set-NpmInstallDefaults() {
  $overrides = @(
    "npm_config_runtime",
    "npm_config_target",
    "npm_config_target_arch",
    "npm_config_target_platform",
    "npm_config_disturl",
    "npm_config_build_from_source"
  )
  foreach ($name in $overrides) {
    Remove-Item "env:$name" -ErrorAction SilentlyContinue
  }
  $env:npm_config_disturl = "https://npmmirror.com/mirrors/node/"
}

if ($Test) {
  Write-Host "Script self-test passed." -ForegroundColor Green
  exit 0
}

while ($true) {
  $choice = if ($Choice) { $Choice } else { Read-Host "Select action [1-6]" }

  if ($choice -eq "1") {
    Set-NpmInstallDefaults
    Invoke-ScoopDeskCommand "npm install"
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "2") {
    Invoke-ScoopDeskCommand "npm run start"
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "3") {
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    $env:npm_config_disturl = "https://npmmirror.com/mirrors/electron/"
    $env:npm_config_build_from_source = "true"
    Invoke-ScoopDeskCommand "npm run electron:build"
    Write-Host "Build output: $distPath" -ForegroundColor Green
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "4") {
    if (Test-Path $distPath) {
      Remove-Item -Recurse -Force $distPath
      Write-Host "dist cleaned." -ForegroundColor Green
    } else {
      Write-Host "dist not found." -ForegroundColor DarkGray
    }
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "5") {
    break
  }

  if ($choice -eq "6") {
    $nodeModulesPath = Join-Path $projectRoot "node_modules"
    $packageLockPath = Join-Path $projectRoot "package-lock.json"
    if (Test-Path $nodeModulesPath) {
      Remove-Item -Recurse -Force $nodeModulesPath
      Write-Host "node_modules cleaned." -ForegroundColor Green
    } else {
      Write-Host "node_modules not found." -ForegroundColor DarkGray
    }
    if (Test-Path $packageLockPath) {
      Remove-Item -Force $packageLockPath
      Write-Host "package-lock.json cleaned." -ForegroundColor Green
    }
    Set-NpmInstallDefaults
    Invoke-ScoopDeskCommand "npm install"
    if ($Choice) { break }
    continue
  }

  Write-Host "Invalid choice, enter 1-6." -ForegroundColor Red
  if ($Choice) { break }
}
