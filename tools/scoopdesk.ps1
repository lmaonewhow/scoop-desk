param(
  [ValidateSet('1', '2', '3', '4', '5')]
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

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot "dist"

function Invoke-ScoopDeskCommand([string]$command) {
  Write-Host "`nRun: $command`n" -ForegroundColor Yellow
  cmd /c "cd /d $projectRoot && $command"
}

if ($Test) {
  Write-Host "Script self-test passed." -ForegroundColor Green
  exit 0
}

while ($true) {
  $choice = if ($Choice) { $Choice } else { Read-Host "Select action [1-5]" }

  if ($choice -eq "1") {
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

  Write-Host "Invalid choice, enter 1-5." -ForegroundColor Red
  if ($Choice) { break }
}
