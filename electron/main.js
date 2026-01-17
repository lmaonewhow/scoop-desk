 const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const os = require('os')

let mainWindow = null
const UPDATE_REPO = { owner: 'lmaonewhow', repo: 'scoop-desk' }
let cachedRelease = null

function compareVersions(current, latest) {
  const toParts = (value) => String(value || '').split('.').map((part) => parseInt(part, 10) || 0)
  const a = toParts(current)
  const b = toParts(latest)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ScoopDesk' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Request failed: ${res.statusCode}`))
        res.resume()
        return
      }
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
  })
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    const request = https.get(url, { headers: { 'User-Agent': 'ScoopDesk' } }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`))
        response.resume()
        return
      }
      response.pipe(file)
    })
    file.on('finish', () => file.close(() => resolve(destPath)))
    request.on('error', (error) => {
      fs.unlink(destPath, () => reject(error))
    })
    file.on('error', (error) => {
      fs.unlink(destPath, () => reject(error))
    })
  })
}

function scheduleUpdateInstall(sourcePath, targetPath) {
  const scriptPath = path.join(os.tmpdir(), `scoopdesk-update-${Date.now()}.ps1`)
  const script = `
$ErrorActionPreference = 'Stop'
$source = ${JSON.stringify(sourcePath)}
$target = ${JSON.stringify(targetPath)}
for ($i = 0; $i -lt 30; $i++) {
  try {
    Move-Item -Path $source -Destination $target -Force
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
Start-Process -FilePath $target
`
  fs.writeFileSync(scriptPath, script, 'utf8')
  const child = require('child_process').spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1118',
    title: 'ScoopDesk',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

ipcMain.handle('select-save-path', async (event, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '选择保存位置',
    defaultPath: suggestedName || 'scoopdesk-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled) {
    return null
  }
  return result.filePath
})

ipcMain.handle('select-open-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择导入文件',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('select-directory', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择安装目录',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('open-external', async (event, url) => {
  if (!url) return false
  await shell.openExternal(url)
  return true
})

ipcMain.handle('app-update-check', async () => {
  const currentVersion = app.getVersion()
  const apiUrl = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`
  const release = await requestJson(apiUrl)
  cachedRelease = release
  const latestVersion = String(release.tag_name || '').replace(/^v/i, '')
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find((item) => item && item.name && item.name.endsWith('.exe')) || null
  if (!latestVersion || !asset) {
    return { hasUpdate: false, currentVersion, latestVersion, notes: release.body || '' }
  }
  const hasUpdate = compareVersions(currentVersion, latestVersion) < 0
  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    notes: release.body || '',
    asset: {
      name: asset.name,
      url: asset.browser_download_url
    }
  }
})

ipcMain.handle('app-update-download', async (event, payload = {}) => {
  const assetUrl = payload.url || cachedRelease?.assets?.find((item) => item?.browser_download_url)?.browser_download_url
  const assetName = payload.name || cachedRelease?.assets?.find((item) => item?.name)?.name || `ScoopDesk-${Date.now()}.exe`
  if (!assetUrl) {
    return { ok: false, message: 'No release asset available.' }
  }
  const tempPath = path.join(os.tmpdir(), assetName)
  await downloadFile(assetUrl, tempPath)
  return { ok: true, path: tempPath, name: assetName }
})

ipcMain.handle('app-update-install', async (event, payload = {}) => {
  const sourcePath = payload.path
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, message: 'Update file not found.' }
  }
  const targetPath = app.getPath('exe')
  scheduleUpdateInstall(sourcePath, targetPath)
  setTimeout(() => {
    app.quit()
  }, 500)
  return { ok: true }
})
