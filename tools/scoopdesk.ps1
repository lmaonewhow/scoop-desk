param(
  [string]$Choice,
  [switch]$NonInteractive,
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
Write-Host "7) Publish GitHub Release (build & upload)"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot "dist"
$dataDir = Join-Path $env:USERPROFILE ".scoopdesk"
$configPath = Join-Path $dataDir "config.json"

function Invoke-ScoopDeskCommand([string]$command) {
  Write-Host "`nRun: $command`n" -ForegroundColor Yellow
  cmd /c "cd /d $projectRoot && $command"
}

function Invoke-GhCommand([string[]]$ghArgs) {
  Write-Host "`nRun: gh $($ghArgs -join ' ')`n" -ForegroundColor Yellow
  & gh @ghArgs
}

function Get-ReleaseNotes([string]$tag, [bool]$nonInteractive = $false) {
  if ($nonInteractive) { return "Release $tag" }
  $notesInput = Read-Host "Release notes (blank for default)"
  if ($notesInput) { return $notesInput }
  return "Release $tag"
}

function Get-LocalConfig() {
  if (-not (Test-Path $configPath)) { return $null }
  try {
    $raw = Get-Content -Raw -Path $configPath
    if (-not $raw) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Save-LocalConfig([object]$config) {
  if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }
  $json = $config | ConvertTo-Json -Depth 6
  Set-Content -Path $configPath -Value $json -Encoding UTF8
}

function Get-GhToken() {
  $config = Get-LocalConfig
  $token = $null
  if ($config -and $config.release -and $config.release.ghToken) {
    $token = $config.release.ghToken
  }
  if (-not $token) {
    $token = Read-Host "Enter GitHub Token (will be saved locally)"
    if (-not $token) { return $null }
    if (-not $config) { $config = [ordered]@{} }
    $hasRelease = $false
    if ($config.PSObject -and $config.PSObject.Properties) {
      $hasRelease = $config.PSObject.Properties.Name -contains 'release'
    }
    if (-not $hasRelease -or -not $config.release) {
      $config | Add-Member -NotePropertyName release -NotePropertyValue ([ordered]@{}) -Force
    }
    $config.release.ghToken = $token
    Save-LocalConfig $config
  }
  return $token
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

function Set-ReleaseBuildDefaults() {
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  $env:npm_config_disturl = "https://npmmirror.com/mirrors/electron/"
  $env:npm_config_build_from_source = "true"
}

function Get-PackageVersion() {
  $packagePath = Join-Path $projectRoot "package.json"
  if (-not (Test-Path $packagePath)) { return $null }
  try {
    $raw = Get-Content -Raw -Path $packagePath
    if (-not $raw) { return $null }
    $json = $raw | ConvertFrom-Json
    return $json.version
  } catch {
    return $null
  }
}

function Test-GhCli() {
  return $null -ne (Get-Command gh -ErrorAction SilentlyContinue)
}

function Resolve-GhCli() {
  if (Test-GhCli) { return $true }
  $scoopRoot = if ($env:SCOOP) { $env:SCOOP } else { Join-Path $env:USERPROFILE "scoop" }
  $scoopShims = if ($scoopRoot) { Join-Path $scoopRoot "shims" } else { $null }
  $scoopGhPath = if ($scoopShims) { Join-Path $scoopShims "gh.exe" } else { $null }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\GitHub CLI\bin\gh.exe")
    (Join-Path $env:ProgramFiles "GitHub CLI\bin\gh.exe")
    (Join-Path $env:ProgramFiles "GitHub CLI\gh.exe")
    $scoopGhPath
  )
  foreach ($candidate in ($candidates | Where-Object { $_ })) {
    if (Test-Path $candidate) {
      $binDir = Split-Path -Parent $candidate
      $env:PATH = "$binDir;$env:PATH"
      return (Test-GhCli)
    }
  }
  return $false
}

if ($Test) {
  Write-Host "Script self-test passed." -ForegroundColor Green
  exit 0
}

while ($true) {
  $choice = if ($Choice) { $Choice } else { Read-Host "Select action [1-7]" }

  if ($choice -eq "1") {
    Set-NpmInstallDefaults
    Invoke-ScoopDeskCommand "npm install"
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "7") {
    $token = Get-GhToken
    if (-not $token) {
      Write-Host "GitHub Token is required." -ForegroundColor Red
      if ($Choice) { break }
      continue
    }
    if (-not $NonInteractive) {
      $versionInput = Read-Host "Release version (blank to keep current)"
      if ($versionInput) {
        $versionInput = $versionInput.Trim()
        if ($versionInput.StartsWith('v')) {
          $versionInput = $versionInput.Substring(1)
        }
        if ($versionInput -match '^gh[pous]_' -or $versionInput -match '^[A-Za-z0-9_]{20,}$') {
          Write-Host "Looks like you pasted a token. Skip version update." -ForegroundColor Yellow
          $versionInput = $null
        } elseif ($versionInput -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z\.-]+)?$') {
          Write-Host "Invalid version format. Use semver like 0.2.1." -ForegroundColor Yellow
          $versionInput = $null
        } else {
          Invoke-ScoopDeskCommand "npm version $versionInput --no-git-tag-version"
        }
      }
    }
    $version = Get-PackageVersion
    $artifactName = if ($version) { "ScoopDesk-$version.exe" } else { $null }
    $artifactPath = if ($artifactName) { Join-Path $distPath $artifactName } else { $null }
    $latestExe = Get-ChildItem -Path $distPath -Filter "*.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $artifactPath -or -not (Test-Path $artifactPath)) {
      if ($latestExe) {
        $artifactPath = $latestExe.FullName
        $artifactName = $latestExe.Name
      }
    }
    if ($NonInteractive -and $version -and $artifactName -and $artifactName -ne "ScoopDesk-$version.exe") {
      $artifactPath = $null
      $artifactName = $null
    }
    $uploadOnly = $false
    if ($artifactPath -and (Test-Path $artifactPath)) {
      if ($NonInteractive) {
        $uploadOnly = $true
      } else {
        $choiceUpload = Read-Host "Found build artifact $artifactName. Upload only? [Y/n]"
        if (-not $choiceUpload -or $choiceUpload -match '^(y|yes)$') {
          $uploadOnly = $true
        }
      }
    }
    $env:GH_TOKEN = $token
    $hasGh = Resolve-GhCli
    if ($uploadOnly -and $hasGh) {
      $tag = if ($version) { "v$version" } else { $null }
      if (-not $tag -and $artifactName -and $artifactName -match 'ScoopDesk-([0-9]+\.[0-9]+\.[0-9A-Za-z\.-]+)\.exe') {
        $tag = "v$($Matches[1])"
      }
      if (-not $tag -and -not $NonInteractive) {
        $tag = Read-Host "Release tag (e.g. v0.2.0)"
      }
      if (-not $tag) {
        Write-Host "Release tag is required." -ForegroundColor Red
      } else {
        Invoke-GhCommand @("release", "view", $tag)
        if ($LASTEXITCODE -ne 0) {
          $notes = Get-ReleaseNotes $tag $NonInteractive
          Invoke-GhCommand @("release", "create", $tag, $artifactPath, "--title", $tag, "--notes", $notes)
        } else {
          Invoke-GhCommand @("release", "upload", $tag, $artifactPath, "--clobber")
        }
      }
    } else {
      if (-not $hasGh) {
        Write-Host "gh CLI not found. Install GitHub CLI to upload release assets." -ForegroundColor Yellow
        if ($Choice) { break }
        continue
      }
      if (-not $uploadOnly -and $artifactPath) {
        $fallback = Read-Host "Found existing artifact. Build again? [y/N]"
        if (-not $fallback -or $fallback -notmatch '^(y|yes)$') {
          $tag = if ($version) { "v$version" } else { Read-Host "Release tag (e.g. v0.2.0)" }
          if ($tag) {
            Invoke-GhCommand @("release", "view", $tag)
            if ($LASTEXITCODE -ne 0) {
              $notes = Get-ReleaseNotes $tag
              Invoke-GhCommand @("release", "create", $tag, $artifactPath, "--title", $tag, "--notes", $notes)
            } else {
              Invoke-GhCommand @("release", "upload", $tag, $artifactPath, "--clobber")
            }
          }
          if ($Choice) { break }
          continue
        }
      }
      Set-ReleaseBuildDefaults
      Invoke-ScoopDeskCommand "npm run electron:build"
      Write-Host "Release build output: $distPath" -ForegroundColor Green
      $artifactName = if ($version) { "ScoopDesk-$version.exe" } else { $null }
      $artifactPath = if ($artifactName) { Join-Path $distPath $artifactName } else { $null }
      if (-not $artifactPath -or -not (Test-Path $artifactPath)) {
        $latestExe = Get-ChildItem -Path $distPath -Filter "*.exe" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 1
        if ($latestExe) {
          $artifactPath = $latestExe.FullName
        }
      }
      if ($artifactPath) {
        $tag = if ($version) { "v$version" } else { Read-Host "Release tag (e.g. v0.2.0)" }
        if ($tag) {
          Invoke-GhCommand @("release", "view", $tag)
          if ($LASTEXITCODE -ne 0) {
            $notes = Get-ReleaseNotes $tag
            Invoke-GhCommand @("release", "create", $tag, $artifactPath, "--title", $tag, "--notes", $notes)
          } else {
            Invoke-GhCommand @("release", "upload", $tag, $artifactPath, "--clobber")
          }
        }
      }
    }
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "2") {
    Invoke-ScoopDeskCommand "npm run start"
    if ($Choice) { break }
    continue
  }

  if ($choice -eq "3") {
    Set-ReleaseBuildDefaults
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

  Write-Host "Invalid choice, enter 1-7." -ForegroundColor Red
  if ($Choice) { break }
}
