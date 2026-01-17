const { ipcRenderer, clipboard } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const sqlite3 = require('sqlite3').verbose()

const state = {
  scoopInstalled: false,
  buckets: [],
  searchResults: [],
  installedApps: [],
  advancedConfig: null,
  advancedStatus: [],
  restorePlan: null,
  busy: false,
  busyMessage: '空闲',
  bucketPage: 1,
  bucketPageSize: 8,
  searchPage: 1,
  searchPageSize: 8,
  storeMode: 'installed',
  activeManagers: ['scoop'],
  selectedCategories: [],
  packageManagers: [],
  scoopPath: '',
  gitInstalled: false,
  appLayout: 'classic',
  logs: [],
  managerStats: {},
  appDetailIndex: {},
  storageStats: null,
  storageStatsAt: 0,
  storageStatsLoading: false,
  appUpdateInfo: null
}

function pushBusy(label) {
  const normalized = label || '处理中'
  busyStack.push(normalized)
  setBusy(true, normalized)
}

function popBusy(label) {
  const target = label || '处理中'
  const index = busyStack.lastIndexOf(target)
  if (index !== -1) {
    busyStack.splice(index, 1)
  }
  if (busyStack.length === 0) {
    setBusy(false, '空闲')
  } else {
    setBusyMessage(busyStack[busyStack.length - 1])
  }
}

const DEFAULT_BUCKETS = [
  { name: 'main' },
  { name: 'extras' },
  { name: 'versions' },
  { name: 'java' },
  { name: 'games' },
  { name: 'nirsoft' },
  { name: 'nonportable' }
]

const DEFAULT_MANAGERS = [
  {
    id: 'scoop',
    label: 'Scoop',
    requiresScoop: true,
    search: 'scoop search {query}',
    list: 'scoop list',
    check: 'scoop status | findstr /I /B "{name} "',
    install: 'scoop install {name}',
    uninstall: 'scoop uninstall {name}',
    parse: 'scoop'
  },
  {
    id: 'winget',
    label: 'Winget',
    search: 'winget search --name "{query}" --accept-source-agreements {category}',
    list: 'winget list --accept-source-agreements',
    check: 'winget upgrade --id "{id}" --accept-source-agreements',
    install: 'winget install --id "{id}" --accept-source-agreements',
    uninstall: 'winget uninstall --id "{id}"',
    categoryFlag: '--tag "{category}"',
    parse: 'winget'
  },
  {
    id: 'choco',
    label: 'Chocolatey',
    search: 'choco search {query} --limit-output',
    list: 'choco list --local-only --limit-output',
    check: 'choco outdated {name} --limit-output',
    install: 'choco install {name} -y',
    uninstall: 'choco uninstall {name} -y',
    parse: 'choco'
  }
]

const DEFAULT_CONFIG = {
  buckets: DEFAULT_BUCKETS,
  advanced: null,
  managers: [],
  layout: 'classic',
  scoopPath: '',
  store: {
    manager: 'scoop',
    managers: ['scoop'],
    categories: []
  }
}

const DATA_DIR = path.join(os.homedir(), '.scoopdesk')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const LOG_PATH = path.join(DATA_DIR, 'scoopdesk.log')
const DB_PATH = path.join(DATA_DIR, 'apps.db')

const taskQueue = []
let queueRunning = false
const busyStack = []

let db = null
function getDb() {
  if (db) return db
  ensureDataDir()
  db = new sqlite3.Database(DB_PATH)
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS app_details (
      app_key TEXT PRIMARY KEY,
      manager TEXT,
      name TEXT,
      detail TEXT,
      updated_at INTEGER
    )`)
  })
  return db
}

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (error) {
      if (error) reject(error)
      else resolve(this)
    })
  })
}

function queueCheckUpdate(item) {
  const manager = getManagerForItem(item)
  if (!manager) {
    log('未选择包管理器。', 'error')
    return
  }
  if (manager.requiresScoop && !requireScoop('检测更新')) return
  const command = buildManagerCommand(manager, 'check', item)
  const name = getDisplayName(item)
  if (!command) {
    log('当前包管理器未配置检测命令。', 'error')
    return
  }
  enqueueTask(`[${manager.label || manager.id}] 检测更新: ${name}`, async () => {
    log(`检测更新(${manager.label || manager.id}): ${name}`)
    const result = await runPowerShell(command, { logOutput: false, utf8: manager.parse === 'choco' })
    const stderr = String(result.stderr || '').trim()
    const stdout = String(result.stdout || '').trim()
    if (result.code !== 0) {
      if (stderr) log(stderr, 'error')
      log(`${name} 检测更新失败。`, 'error')
      return
    }
    if (!stdout) {
      log(`${name} 未发现可更新版本。`)
      return
    }
    stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      log(line)
    })
  })
}

function getDbRow(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (error, row) => {
      if (error) reject(error)
      else resolve(row || null)
    })
  })
}

function buildAppKey(manager, name) {
  return `${String(manager || 'unknown').toLowerCase()}:${String(name || '').toLowerCase()}`
}

async function getAppDetailFromDb(manager, name) {
  const key = buildAppKey(manager, name)
  const row = await getDbRow('SELECT detail FROM app_details WHERE app_key = ?', [key])
  if (!row?.detail) return null
  try {
    return JSON.parse(row.detail)
  } catch (error) {
    return null
  }
}

async function hasAppDetailInDb(manager, name) {
  const key = buildAppKey(manager, name)
  if (state.appDetailIndex[key]) return true
  const row = await getDbRow('SELECT 1 FROM app_details WHERE app_key = ?', [key])
  if (row) {
    state.appDetailIndex[key] = true
  }
  return !!row
}

async function saveAppDetailToDb(manager, name, detail) {
  const key = buildAppKey(manager, name)
  const payload = JSON.stringify({ ...detail, manager, name })
  await runDb(
    'INSERT OR REPLACE INTO app_details (app_key, manager, name, detail, updated_at) VALUES (?, ?, ?, ?, ?)',
    [key, manager, name, payload, Date.now()]
  )
  state.appDetailIndex[key] = true
}

async function primeAppDetailIndex(items) {
  const tasks = (items || []).map((item) => {
    const name = getDisplayName(item)
    const manager = item?.manager || 'scoop'
    const key = buildAppKey(manager, name)
    if (state.appDetailIndex[key]) return null
    return hasAppDetailInDb(manager, name).catch(() => null)
  }).filter(Boolean)
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

const elements = {
  statusText: document.getElementById('status-text'),
  statusDot: document.getElementById('status-dot'),
  refreshStatus: document.getElementById('refresh-status'),
  autoInstall: document.getElementById('auto-install'),
  manualButtons: document.querySelectorAll('.step-action'),
  copyCommands: document.getElementById('copy-commands'),
  scoopPathInput: document.getElementById('scoop-path'),
  selectScoopPath: document.getElementById('select-scoop-path'),
  restartHint: document.getElementById('restart-hint'),
  restartDetect: document.getElementById('restart-detect'),
  migrateScoopPath: document.getElementById('migrate-scoop-path'),
  appDetailModal: document.getElementById('app-detail-modal'),
  appDetailTitle: document.getElementById('app-detail-title'),
  appDetailMeta: document.getElementById('app-detail-meta'),
  appDetailNotes: document.getElementById('app-detail-notes'),
  appDetailCommands: document.getElementById('app-detail-commands'),
  appDetailClose: document.getElementById('app-detail-close'),
  bucketCount: document.getElementById('bucket-count'),
  installedCount: document.getElementById('installed-count'),
  installedSub: document.getElementById('installed-sub'),
  globalStatus: document.getElementById('global-status'),
  busyIndicator: document.getElementById('busy-indicator'),
  busyText: document.getElementById('busy-text'),
  storeNotice: document.getElementById('store-notice'),
  setupSection: document.getElementById('section-setup'),
  storeSection: document.getElementById('section-store'),
  migrationSection: document.getElementById('section-migration'),
  homeSection: document.getElementById('section-home'),
  navSetup: document.getElementById('nav-setup'),
  navHome: document.getElementById('nav-home'),
  navMigration: document.getElementById('nav-migration'),
  navStore: document.getElementById('nav-store'),
  bucketModal: document.getElementById('bucket-modal'),
  bucketModalClose: document.getElementById('bucket-modal-close'),
  openBucketModal: document.getElementById('open-bucket-modal'),
  bucketName: document.getElementById('bucket-name'),
  bucketUrl: document.getElementById('bucket-url'),
  addBucket: document.getElementById('add-bucket'),
  addDefaultBuckets: document.getElementById('add-default-buckets'),
  reloadBuckets: document.getElementById('reload-buckets'),
  refreshInstalled: document.getElementById('refresh-installed'),
  bucketList: document.getElementById('bucket-list'),
  bucketPrev: document.getElementById('bucket-prev'),
  bucketNext: document.getElementById('bucket-next'),
  bucketPage: document.getElementById('bucket-page'),
  searchQuery: document.getElementById('search-query'),
  searchBtn: document.getElementById('search-btn'),
  layoutClassic: document.getElementById('layout-classic'),
  layoutTop: document.getElementById('layout-top'),
  layoutSplit: document.getElementById('layout-split'),
  managerTags: document.getElementById('manager-tags'),
  categoryInput: document.getElementById('category-input'),
  categoryAdd: document.getElementById('category-add'),
  categoryTags: document.getElementById('category-tags'),
  searchResults: document.getElementById('search-results'),
  searchPrev: document.getElementById('search-prev'),
  searchNext: document.getElementById('search-next'),
  searchPage: document.getElementById('search-page'),
  storeListTitle: document.getElementById('store-list-title'),
  managerChart: document.getElementById('manager-chart'),
  logSummary: document.getElementById('log-summary'),
  activityList: document.getElementById('activity-list'),
  analysisInstalled: document.getElementById('analysis-installed'),
  analysisBuckets: document.getElementById('analysis-buckets'),
  analysisManagers: document.getElementById('analysis-managers'),
  analysisErrors: document.getElementById('analysis-errors'),
  storageSummary: document.getElementById('storage-summary'),
  storageChart: document.getElementById('storage-chart'),
  exportEnv: document.getElementById('export-env'),
  importEnv: document.getElementById('import-env'),
  applyRegistry: document.getElementById('apply-registry'),
  restoreSummary: document.getElementById('restore-summary'),
  restoreList: document.getElementById('restore-list'),
  runRestore: document.getElementById('run-restore'),
  clearRestore: document.getElementById('clear-restore'),
  logOutput: document.getElementById('log-output'),
  clearLog: document.getElementById('clear-log'),
  appVersion: document.getElementById('app-version'),
  appUpdateStatus: document.getElementById('app-update-status'),
  appUpdateNotes: document.getElementById('app-update-notes'),
  appUpdateCheck: document.getElementById('app-update-check'),
  appUpdateInstall: document.getElementById('app-update-install'),
  loadAdvanced: document.getElementById('load-advanced'),
  useTemplate: document.getElementById('use-template'),
  advancedInput: document.getElementById('advanced-input'),
  parseAdvanced: document.getElementById('parse-advanced'),
  advancedTitle: document.getElementById('advanced-title'),
  advancedSteps: document.getElementById('advanced-steps'),
  runAdvanced: document.getElementById('run-advanced'),
  scoopPathMigrate: document.getElementById('scoop-path-migrate'),
  selectScoopPathMigrate: document.getElementById('select-scoop-path-migrate')
}

function ensureDataDir() {
  if (fs.existsSync(DATA_DIR)) {
    const stat = fs.statSync(DATA_DIR)
    if (stat.isDirectory()) return
    const backup = `${DATA_DIR}.bak-${Date.now()}`
    fs.renameSync(DATA_DIR, backup)
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function appendLogFile(line) {
  try {
    ensureDataDir()
    fs.appendFileSync(LOG_PATH, `${line}${os.EOL}`)
  } catch (error) {
    console.warn('日志写入失败：', error)
  }
}

function appendLogLine(entry) {
  if (!elements.logOutput) return
  const line = document.createElement('div')
  line.className = `log-line${entry.type === 'error' ? ' error' : ''}`
  line.innerHTML = `<span class="log-time">${entry.time}</span><span class="log-message">${entry.message}</span>`
  elements.logOutput.appendChild(line)
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight
}

function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString()
  const line = `[${time}] ${message}`
  const entry = { time, message, type }
  state.logs = [...state.logs, entry].slice(-200)
  appendLogLine(entry)
  appendLogFile(line)
  updateAnalytics()
  if (type === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function setUpdateStatus(message, type = 'info') {
  if (elements.appUpdateStatus) {
    elements.appUpdateStatus.textContent = message
    elements.appUpdateStatus.dataset.status = type
  }
}

async function checkAppUpdate({ silent = false } = {}) {
  if (!silent) {
    setUpdateStatus('检查中...', 'pending')
  }
  try {
    const result = await ipcRenderer.invoke('app-update-check')
    state.appUpdateInfo = result
    if (elements.appVersion) {
      elements.appVersion.textContent = result.currentVersion || '-'
    }
    if (result.hasUpdate) {
      setUpdateStatus(`发现新版本 ${result.latestVersion}`, 'warn')
      if (elements.appUpdateNotes) {
        elements.appUpdateNotes.textContent = result.notes ? `更新说明: ${result.notes}` : '已检测到新版本，可立即更新。'
      }
      if (elements.appUpdateInstall) {
        elements.appUpdateInstall.disabled = false
      }
    } else {
      if (!silent) {
        setUpdateStatus('已是最新版本', 'ok')
      }
      if (elements.appUpdateNotes) {
        elements.appUpdateNotes.textContent = '暂无可用更新。'
      }
      if (elements.appUpdateInstall) {
        elements.appUpdateInstall.disabled = true
      }
    }
    return result
  } catch (error) {
    if (!silent) {
      setUpdateStatus('检查失败', 'error')
    }
    if (elements.appUpdateNotes) {
      elements.appUpdateNotes.textContent = '无法获取更新信息，请检查网络或仓库设置。'
    }
    return null
  }
}

async function downloadAndInstallUpdate() {
  if (!state.appUpdateInfo?.hasUpdate || !state.appUpdateInfo?.asset) {
    log('暂无可更新版本。')
    return
  }
  setUpdateStatus('下载中...', 'pending')
  try {
    const download = await ipcRenderer.invoke('app-update-download', state.appUpdateInfo.asset)
    if (!download?.ok) {
      setUpdateStatus('下载失败', 'error')
      log(download?.message || '下载更新失败。', 'error')
      return
    }
    setUpdateStatus('正在安装更新...', 'pending')
    const installResult = await ipcRenderer.invoke('app-update-install', download)
    if (!installResult?.ok) {
      setUpdateStatus('安装失败', 'error')
      log(installResult?.message || '安装更新失败。', 'error')
      return
    }
    setUpdateStatus('正在重启...', 'pending')
  } catch (error) {
    setUpdateStatus('更新失败', 'error')
    log('更新失败，请查看日志。', 'error')
  }
}

function enqueueTask(label, task) {
  taskQueue.push({ label, task })
  log(`加入队列: ${label}`)
  if (!queueRunning) {
    processQueue()
  }
}

async function processQueue() {
  if (queueRunning) return
  queueRunning = true
  pushBusy('队列处理中')
  while (taskQueue.length) {
    const current = taskQueue.shift()
    setBusyMessage(`队列执行: ${current.label} (剩余 ${taskQueue.length} 项)`)
    try {
      await current.task()
    } catch (error) {
      log(error?.message || '队列任务执行失败。', 'error')
    }
  }
  queueRunning = false
  popBusy('队列处理中')
}

function updateStats() {
  if (elements.bucketCount) {
    elements.bucketCount.textContent = state.buckets.length
  }
  if (elements.installedCount) {
    elements.installedCount.textContent = state.installedApps.length
  }
  updateInstalledSubtitle()
  updateAnalytics()
}

function updateInstalledSubtitle() {
  if (!elements.installedSub) return
  const counts = Object.keys(state.managerStats || {}).length
    ? state.managerStats
    : state.installedApps.reduce((acc, app) => {
        const id = app?.manager || 'unknown'
        acc[id] = (acc[id] || 0) + 1
        return acc
      }, {})
  const managers = state.packageManagers.filter((manager) => (counts[manager.id] || 0) > 0)
  if (!managers.length) {
    elements.installedSub.textContent = '暂无已安装来源'
    return
  }
  const labels = managers.map((manager) => `${manager.label || manager.id} ${counts[manager.id] || 0}`).join(' / ')
  elements.installedSub.textContent = `来源: ${labels}`
}

function updateAnalytics() {
  if (elements.analysisInstalled) {
    elements.analysisInstalled.textContent = state.installedApps.length
  }
  if (elements.analysisBuckets) {
    elements.analysisBuckets.textContent = state.buckets.length
  }
  const counts = Object.keys(state.managerStats || {}).length
    ? state.managerStats
    : state.installedApps.reduce((acc, app) => {
        const id = app?.manager || 'unknown'
        acc[id] = (acc[id] || 0) + 1
        return acc
      }, {})
  if (elements.analysisManagers) {
    const managerTotal = state.packageManagers.filter((manager) => (counts[manager.id] || 0) > 0).length
    elements.analysisManagers.textContent = managerTotal
  }
  const errorCount = state.logs.filter((entry) => entry.type === 'error').length
  if (elements.analysisErrors) {
    elements.analysisErrors.textContent = errorCount
  }
  if (elements.logSummary) {
    elements.logSummary.textContent = `最近 ${state.logs.length} 条日志，错误 ${errorCount} 条`
  }
  if (elements.activityList) {
    elements.activityList.innerHTML = ''
    state.logs.slice(-5).reverse().forEach((entry) => {
      const li = document.createElement('li')
      li.textContent = `[${entry.time}] ${entry.message}`
      elements.activityList.appendChild(li)
    })
  }
  if (elements.managerChart) {
    elements.managerChart.innerHTML = ''
    const fallbackCounts = state.installedApps.reduce((acc, app) => {
      const id = app?.manager || 'unknown'
      acc[id] = (acc[id] || 0) + 1
      return acc
    }, {})
    const counts = Object.keys(state.managerStats || {}).length ? state.managerStats : fallbackCounts
    const total = Math.max(1, Object.values(counts).reduce((sum, value) => sum + value, 0))
    state.packageManagers.forEach((manager) => {
      const value = counts[manager.id] || 0
      const row = document.createElement('div')
      row.className = 'chart-row'
      row.innerHTML = `
        <span class="chart-label">${manager.label || manager.id}</span>
        <div class="chart-bar"><div class="chart-fill" style="width: ${(value / total) * 100}%"></div></div>
        <span class="chart-value">${value}</span>
      `
      elements.managerChart.appendChild(row)
    })
  }
  refreshStorageStats()
}

function formatBytes(value) {
  if (!value || Number.isNaN(value)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const size = value / Math.pow(1024, index)
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`
}

async function measurePathSize(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return 0
  const command = `((Get-ChildItem -LiteralPath ${psQuote(targetPath)} -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum)`
  const result = await runPowerShell(command, { logOutput: false })
  const output = String(result.stdout || '').trim()
  const size = Number.parseInt(output, 10)
  return Number.isFinite(size) ? size : 0
}

function renderStorageStats() {
  if (!elements.storageSummary || !elements.storageChart) return
  const stats = state.storageStats
  elements.storageChart.innerHTML = ''
  if (!stats || !stats.entries?.length) {
    elements.storageSummary.textContent = '暂无可统计的存储信息。'
    return
  }
  elements.storageSummary.textContent = `总占用 ${formatBytes(stats.total)}`
  const total = Math.max(stats.total, 1)
  stats.entries.forEach((entry) => {
    const row = document.createElement('div')
    row.className = 'chart-row'
    row.innerHTML = `
      <span class="chart-label">${entry.label}</span>
      <div class="chart-bar"><div class="chart-fill" style="width: ${(entry.size / total) * 100}%"></div></div>
      <span class="chart-value">${formatBytes(entry.size)}</span>
    `
    elements.storageChart.appendChild(row)
  })
}

async function refreshStorageStats(force = false) {
  if (!elements.storageSummary || !elements.storageChart) return
  const now = Date.now()
  if (!force && state.storageStatsAt && now - state.storageStatsAt < 60000) {
    renderStorageStats()
    return
  }
  if (state.storageStatsLoading) return
  state.storageStatsLoading = true
  elements.storageSummary.textContent = '正在统计存储占用...'

  const entries = []
  const scoopPath = getScoopPath()
  if (fs.existsSync(scoopPath)) {
    const size = await measurePathSize(scoopPath)
    entries.push({ label: 'Scoop', size })
  }
  const chocoRoot = process.env.ChocolateyInstall || path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'chocolatey')
  if (chocoRoot && fs.existsSync(chocoRoot)) {
    const size = await measurePathSize(chocoRoot)
    entries.push({ label: 'Chocolatey', size })
  }
  const wingetRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : ''
  if (wingetRoot && fs.existsSync(wingetRoot)) {
    const size = await measurePathSize(wingetRoot)
    entries.push({ label: 'Winget', size })
  }

  const total = entries.reduce((sum, item) => sum + item.size, 0)
  state.storageStats = { total, entries }
  state.storageStatsAt = now
  state.storageStatsLoading = false
  renderStorageStats()
}

function updateLayoutButtons() {
  elements.layoutClassic?.classList.toggle('active', state.appLayout === 'classic')
  elements.layoutTop?.classList.toggle('active', state.appLayout === 'top')
  elements.layoutSplit?.classList.toggle('active', state.appLayout === 'split')
}

function setAppLayout(layout, { persist = true } = {}) {
  const legacyMap = {
    list: 'classic',
    grid: 'top'
  }
  const candidate = legacyMap[layout] || layout
  const normalized = ['classic', 'top', 'split'].includes(candidate) ? candidate : 'classic'
  state.appLayout = normalized
  elements.searchResults?.classList.toggle('grid-layout', state.appLayout === 'top' || state.appLayout === 'split')
  if (elements.storeSection) {
    elements.storeSection.dataset.layout = state.appLayout
  }
  document.body.dataset.appLayout = state.appLayout
  updateLayoutButtons()
  if (persist) {
    const config = readConfig()
    config.layout = state.appLayout
    saveConfig(config)
  }
}

function isValidBucketName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return false
  if (trimmed.toLowerCase() === 'name') return false
  if (/^-+$/.test(trimmed)) return false
  return true
}

function getPagedItems(items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize
  return {
    page: safePage,
    totalPages,
    items: items.slice(start, start + pageSize)
  }
}

function updateBucketPagination(totalPages) {
  if (elements.bucketPage) {
    elements.bucketPage.textContent = `${state.bucketPage} / ${totalPages}`
  }
  if (elements.bucketPrev) {
    elements.bucketPrev.disabled = state.bucketPage <= 1
  }
  if (elements.bucketNext) {
    elements.bucketNext.disabled = state.bucketPage >= totalPages
  }
}

function updateSearchPagination(totalPages) {
  if (elements.searchPage) {
    elements.searchPage.textContent = `${state.searchPage} / ${totalPages}`
  }
  if (elements.searchPrev) {
    elements.searchPrev.disabled = state.searchPage <= 1
  }
  if (elements.searchNext) {
    elements.searchNext.disabled = state.searchPage >= totalPages
  }
}

function mergeManagers(customManagers = []) {
  const merged = DEFAULT_MANAGERS.map((manager) => ({ ...manager }))
  if (!Array.isArray(customManagers)) return merged
  customManagers.forEach((manager) => {
    if (!manager || !manager.id) return
    const id = String(manager.id).toLowerCase()
    const normalized = { ...manager, id }
    const existingIndex = merged.findIndex((item) => item.id === id)
    if (existingIndex >= 0) {
      merged[existingIndex] = { ...merged[existingIndex], ...normalized }
    } else {
      merged.push(normalized)
    }
  })
  return merged
}

function getManagerById(id) {
  if (!id) return null
  return state.packageManagers.find((manager) => manager.id === id) || null
}

function getActiveManagers() {
  const fallback = state.packageManagers[0]?.id
  const ids = state.activeManagers?.length ? state.activeManagers : (fallback ? [fallback] : [])
  return ids.map((id) => getManagerById(id)).filter(Boolean)
}

function getPrimaryManager() {
  return getActiveManagers()[0] || null
}

function getManagerForItem(item) {
  const managerId = typeof item === 'object' ? item?.manager : null
  return getManagerById(managerId) || getPrimaryManager()
}

function setActiveManagers(ids, { persist = true } = {}) {
  const normalized = Array.from(new Set((ids || []).map((id) => String(id).toLowerCase())))
    .filter((id) => getManagerById(id))
  if (normalized.length === 0 && state.packageManagers[0]?.id) {
    normalized.push(state.packageManagers[0].id)
  }
  state.activeManagers = normalized
  if (persist) {
    const config = readConfig()
    config.store = { ...(config.store || {}), managers: normalized }
    saveConfig(config)
  }
  renderManagerTags()
  updateStoreNotice()
}

function renderManagerTags() {
  if (!elements.managerTags) return
  elements.managerTags.innerHTML = ''
  state.packageManagers.forEach((manager) => {
    const button = document.createElement('button')
    const isActive = state.activeManagers.includes(manager.id)
    button.type = 'button'
    button.className = `tag-button${isActive ? ' active' : ''}`
    button.textContent = manager.label || manager.id
    button.addEventListener('click', () => {
      const next = isActive
        ? state.activeManagers.filter((id) => id !== manager.id)
        : [...state.activeManagers, manager.id]
      setActiveManagers(next)
      refreshStoreFilters()
    })
    elements.managerTags.appendChild(button)
  })
}

function renderCategoryTags() {
  if (!elements.categoryTags) return
  elements.categoryTags.innerHTML = ''
  state.selectedCategories.forEach((category) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tag-button active'
    button.innerHTML = `${category}<span class="tag-remove">×</span>`
    button.addEventListener('click', () => removeCategoryTag(category))
    elements.categoryTags.appendChild(button)
  })
}

function addCategoryTag(value, { persist = true } = {}) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return
  if (state.selectedCategories.includes(trimmed)) return
  state.selectedCategories = [...state.selectedCategories, trimmed]
  if (persist) {
    const config = readConfig()
    config.store = { ...(config.store || {}), categories: state.selectedCategories }
    saveConfig(config)
  }
  renderCategoryTags()
  refreshStoreFilters()
}

function removeCategoryTag(value, { persist = true } = {}) {
  state.selectedCategories = state.selectedCategories.filter((item) => item !== value)
  if (persist) {
    const config = readConfig()
    config.store = { ...(config.store || {}), categories: state.selectedCategories }
    saveConfig(config)
  }
  renderCategoryTags()
  refreshStoreFilters()
}

function refreshStoreFilters() {
  state.searchPage = 1
  const query = elements.searchQuery?.value?.trim() || ''
  if (query) {
    searchApps(query)
  } else {
    state.storeMode = 'installed'
    state.searchResults = []
    refreshInstalled()
  }
}

function formatCommand(template, values) {
  if (!template) return null
  let output = template
  Object.entries(values).forEach(([key, value]) => {
    const safeValue = value == null ? '' : String(value)
    output = output.replace(new RegExp(`{${key}}`, 'g'), safeValue)
  })
  return output.replace(/\s{2,}/g, ' ').trim()
}

function buildManagerCommand(manager, type, item, extra = {}) {
  if (!manager || !manager[type]) return null
  const name = typeof item === 'string' ? item : item?.name
  const id = typeof item === 'string' ? item : item?.id || item?.name
  return formatCommand(manager[type], { name, id, ...extra })
}

function parseDelimitedLines(lines, delimiter = /\s{2,}/) {
  return lines.map((line) => line.split(delimiter).map((part) => part.trim()).filter(Boolean)).filter((parts) => parts.length)
}

function parseScoopResults(lines) {
  const apps = []
  for (const line of lines) {
    if (/^installed(\b|\()/i.test(line)) continue
    if (line.startsWith('Results') || line.startsWith('----') || line.startsWith('Name')) continue
    const parts = line.split(/\s+/).filter(Boolean)
    if (parts[0]) {
      apps.push({ name: parts[0] })
    }
  }
  return apps
}

function parseWingetResults(lines) {
  const apps = []
  const parsedLines = parseDelimitedLines(lines)
  parsedLines.forEach((parts) => {
    if (parts.length < 2) return
    if (parts[0] === 'Name' || parts[0].startsWith('---') || parts[0] === '-') return
    if (parts[0] === 'Installed' || parts[0] === '已安装' || /^installed(\b|\()/i.test(parts[0])) return
    const joined = parts.join(' ').toLowerCase()
    if (joined.includes('terms of transaction') || joined.includes('source requires') || joined.includes('aka.ms/microsoft-store-terms-of-transaction') || joined.includes('地理区域')) {
      return
    }
    const name = parts[0]
    const id = parts[1]
    if (name) {
      apps.push({ name, id })
    }
  })
  return apps
}

function parseChocoResults(lines) {
  const apps = []
  lines.forEach((line) => {
    if (!line || !line.includes('|')) return
    const [name] = line.split('|').map((part) => part.trim())
    if (!name) return
    if (name.toLowerCase().includes('chocolatey')) return
    apps.push({ name })
  })
  return apps
}

function parseManagerOutput(manager, stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!manager) return []
  if (manager.parse === 'winget') return parseWingetResults(lines)
  if (manager.parse === 'choco') return parseChocoResults(lines)
  return parseScoopResults(lines)
}

function isAppInstalled(item) {
  const name = typeof item === 'string' ? item : item?.name
  const id = typeof item === 'string' ? item : item?.id
  const itemManager = typeof item === 'object' ? item?.manager : null
  return state.installedApps.some((app) => {
    if (typeof app === 'string') {
      return app === name || (id && app === id)
    }
    const appManager = app?.manager
    if (itemManager && appManager && itemManager !== appManager) {
      return false
    }
    if (name && app.name === name) return true
    if (id && app.id === id) return true
    return false
  })
}

function getDisplayName(item) {
  if (typeof item === 'string') return item
  return item?.name || item?.id || '未命名应用'
}

function parseScoopInfoOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/)
  const notes = []
  const commands = []
  let inNotes = false
  lines.forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) {
      if (inNotes) {
        inNotes = false
      }
      return
    }
    const noteMatch = trimmed.match(/^(notes?|备注)[:：]?\s*(.*)$/i)
    if (noteMatch) {
      inNotes = true
      if (noteMatch[2]) {
        notes.push(noteMatch[2].trim())
      }
    } else if (/^(version|license|homepage|website|description|installed|updated|manifest)\b/i.test(trimmed)) {
      inNotes = false
    } else if (inNotes) {
      notes.push(trimmed)
    }

    const commandMatch = trimmed.match(/(reg\s+(?:import|add)\s+.+)$/i)
    if (commandMatch) {
      commands.push(commandMatch[1].trim())
    }
  })
  const uniqueNotes = [...new Set(notes)].filter(Boolean)
  const uniqueCommands = [...new Set(commands)].filter(Boolean)
  return { notes: uniqueNotes, commands: uniqueCommands }
}

async function fetchScoopAppDetail(name) {
  const result = await runPowerShell(`scoop info ${name}`)
  const rawInfo = result.stdout || ''
  const parsed = parseScoopInfoOutput(rawInfo)
  const detail = {
    manager: 'scoop',
    name,
    rawInfo,
    notes: parsed.notes,
    commands: parsed.commands,
    updatedAt: Date.now()
  }
  await saveAppDetailToDb('scoop', name, detail)
  return detail
}

function renderAppDetailNotes(notes = []) {
  if (!elements.appDetailNotes) return
  elements.appDetailNotes.innerHTML = ''
  if (!notes.length) {
    const li = document.createElement('li')
    li.textContent = '暂无说明'
    elements.appDetailNotes.appendChild(li)
    return
  }
  notes.forEach((note) => {
    const li = document.createElement('li')
    li.textContent = note
    elements.appDetailNotes.appendChild(li)
  })
}

function renderAppDetailCommands(commands = []) {
  if (!elements.appDetailCommands) return
  elements.appDetailCommands.innerHTML = ''
  if (!commands.length) {
    const empty = document.createElement('div')
    empty.className = 'helper'
    empty.textContent = '未识别到可执行命令。'
    elements.appDetailCommands.appendChild(empty)
    return
  }
  commands.forEach((command) => {
    const row = document.createElement('div')
    row.className = 'command-item'
    const code = document.createElement('code')
    code.textContent = command
    const button = document.createElement('button')
    button.className = 'ghost-btn'
    button.textContent = '执行'
    button.addEventListener('click', () => runRegistryCommand(command))
    row.appendChild(code)
    row.appendChild(button)
    elements.appDetailCommands.appendChild(row)
  })
}

function showAppDetailModal() {
  if (!elements.appDetailModal) return
  elements.appDetailModal.classList.remove('hidden')
}

function closeAppDetailModal() {
  if (!elements.appDetailModal) return
  elements.appDetailModal.classList.add('hidden')
}

function showBucketModal() {
  if (!elements.bucketModal) return
  elements.bucketModal.classList.remove('hidden')
}

function closeBucketModal() {
  if (!elements.bucketModal) return
  elements.bucketModal.classList.add('hidden')
}

async function runRegistryCommand(command) {
  if (!/reg\s+(import|add)\b/i.test(command)) {
    log('仅支持执行 reg import/reg add 命令。', 'error')
    return
  }
  await runTask('执行注册表命令', async () => {
    log(`执行注册表命令: ${command}`)
    await runPowerShell(command)
  })
}

async function openAppDetail(item) {
  if (!elements.appDetailModal) return
  const name = getDisplayName(item)
  const managerId = item?.manager || 'scoop'
  const manager = getManagerById(managerId)
  let detail = await getAppDetailFromDb(managerId, name)

  if (!detail && managerId === 'scoop') {
    try {
      detail = await fetchScoopAppDetail(name)
    } catch (error) {
      log('读取应用详情失败，请查看日志。', 'error')
    }
  }

  if (!detail) {
    detail = {
      manager: managerId,
      name,
      notes: managerId === 'scoop' ? [] : ['当前仅支持 Scoop 应用的详情解析。'],
      commands: []
    }
  }

  if (elements.appDetailTitle) {
    elements.appDetailTitle.textContent = name
  }
  if (elements.appDetailMeta) {
    elements.appDetailMeta.textContent = manager?.label || managerId
  }
  renderAppDetailNotes(detail.notes || [])
  renderAppDetailCommands(detail.commands || [])
  showAppDetailModal()
}

function queueInstallApp(item) {
  const manager = getManagerForItem(item)
  if (!manager) {
    log('未选择包管理器。', 'error')
    return
  }
  const name = getDisplayName(item)
  if (isAppInstalled(item)) {
    log(`${name} 已安装，无需重复安装。`)
    return
  }
  if (manager.requiresScoop && !requireScoop('安装应用')) return
  const command = buildManagerCommand(manager, 'install', item)
  if (!command) {
    log('未配置安装命令。', 'error')
    return
  }
  enqueueTask(`[${manager.label || manager.id}] 安装应用: ${name}`, async () => {
    log(`安装应用(${manager.label || manager.id}): ${name}`)
    await runPowerShell(command)
    await refreshInstalled()
    if (manager.id === 'scoop') {
      try {
        await fetchScoopAppDetail(name)
      } catch (error) {
        log('应用详情解析失败，请查看日志。', 'error')
      }
    }
  })
}

function queueUninstallApp(item) {
  const manager = getManagerForItem(item)
  if (!manager) {
    log('未选择包管理器。', 'error')
    return
  }
  if (manager.requiresScoop && !requireScoop('卸载应用')) return
  const command = buildManagerCommand(manager, 'uninstall', item)
  const name = getDisplayName(item)
  if (!command) {
    log('未配置卸载命令。', 'error')
    return
  }
  enqueueTask(`[${manager.label || manager.id}] 卸载应用: ${name}`, async () => {
    log(`卸载应用(${manager.label || manager.id}): ${name}`)
    await runPowerShell(command)
    await refreshInstalled()
  })
}

function updateStoreNotice() {
  if (!elements.storeNotice) return
  const managers = getActiveManagers()
  const requiresScoop = managers.some((manager) => manager.requiresScoop)
  elements.storeNotice.style.display = requiresScoop && !state.scoopInstalled ? 'flex' : 'none'
}

function setBusy(isBusy, message) {
  state.busy = isBusy
  if (message) {
    state.busyMessage = message
  }
  if (elements.busyIndicator) {
    elements.busyIndicator.classList.toggle('active', isBusy)
  }
  if (elements.busyText) {
    elements.busyText.textContent = state.busyMessage
  }
  if (elements.globalStatus) {
    elements.globalStatus.textContent = state.busyMessage
  }
  if (!isBusy && elements.busyText) {
    elements.busyText.textContent = '空闲'
  }
  if (!isBusy && elements.globalStatus) {
    elements.globalStatus.textContent = '空闲'
  }
  updateActionState()
}

function setBusyMessage(message) {
  state.busyMessage = message
  if (elements.busyText) {
    elements.busyText.textContent = message
  }
  if (elements.globalStatus) {
    elements.globalStatus.textContent = message
  }
}

function updateActionState() {
  updateStoreNotice()
  const buttons = document.querySelectorAll('button')
  buttons.forEach((button) => {
    if (button.dataset.keepActive === 'true') {
      button.disabled = false
      return
    }
    if (state.busy) {
      button.disabled = true
      return
    }
    if (button.dataset.disableWhenScoop === 'true' && state.scoopInstalled) {
      button.disabled = true
      return
    }
    const requiresScoop = button.dataset.requiresScoop === 'true'
    const requiresPlan = button.dataset.requiresPlan === 'restore'
    const requiresAdvanced = button.dataset.requiresAdvanced === 'true'

    if (requiresScoop && !state.scoopInstalled) {
      button.disabled = true
      return
    }
    if (requiresPlan && !state.restorePlan) {
      button.disabled = true
      return
    }
    if (requiresAdvanced && !state.advancedConfig) {
      button.disabled = true
      return
    }
    button.disabled = false
  })
}

function requireScoop(action = '此操作') {
  if (!state.scoopInstalled) {
    log(`未检测到 Scoop，无法执行${action}。`, 'error')
    return false
  }
  return true
}

function normalizeScoopPath(value) {
  return String(value || '').trim()
}

function setScoopPath(value, { persist = true } = {}) {
  const normalized = normalizeScoopPath(value)
  state.scoopPath = normalized
  if (elements.scoopPathInput) {
    elements.scoopPathInput.value = normalized
  }
  if (elements.scoopPathMigrate) {
    elements.scoopPathMigrate.value = normalized
  }
  if (persist) {
    const config = readConfig()
    config.scoopPath = normalized
    saveConfig(config)
  }
}

function getScoopPath() {
  return state.scoopPath || path.join(os.homedir(), 'scoop')
}

function resolveCurrentScoopPath() {
  const candidates = [
    normalizeScoopPath(process.env.SCOOP),
    normalizeScoopPath(state.scoopPath),
    path.join(os.homedir(), 'scoop')
  ].filter(Boolean)
  const unique = [...new Set(candidates.map((value) => path.resolve(value)))]
  const existing = unique.find((value) => hasScoopAtPath(value))
  return existing || candidates[0] || path.join(os.homedir(), 'scoop')
}

function getScoopShimsPath() {
  return path.join(getScoopPath(), 'shims')
}

function hasScoopAtPath(scoopPath) {
  if (!scoopPath) return false
  const shimsPath = path.join(scoopPath, 'shims')
  const appsPath = path.join(scoopPath, 'apps')
  return fs.existsSync(shimsPath) || fs.existsSync(appsPath)
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function joinCommands(commands) {
  return commands.filter(Boolean).join('; ')
}

function buildScoopEnvPrefix() {
  if (!state.scoopPath) return ''
  const scoopPath = psQuote(state.scoopPath)
  return `$env:SCOOP=${scoopPath}; [Environment]::SetEnvironmentVariable('SCOOP', ${scoopPath}, 'User')`
}

function buildScoopInstallCommand() {
  const commands = []
  if (state.scoopPath) {
    commands.push(`New-Item -ItemType Directory -Force -Path ${psQuote(state.scoopPath)} | Out-Null`)
  }
  commands.push(buildScoopEnvPrefix())
  commands.push('iwr -useb get.scoop.sh | iex')
  return joinCommands(commands)
}

function buildScoopPathCommand() {
  const shimsPath = psQuote(getScoopShimsPath())
  return `[Environment]::SetEnvironmentVariable('Path', $env:Path + ';' + ${shimsPath}, 'User')`
}

function toggleRestartHint(show) {
  if (!elements.restartHint) return
  elements.restartHint.classList.toggle('hidden', !show)
}

function setManualStepStatus(step, status) {
  const statusElement = document.querySelector(`.step-status[data-step="${step}"]`)
  if (!statusElement) return
  const labels = {
    pending: '待执行',
    running: '执行中',
    done: '完成',
    error: '失败'
  }
  statusElement.classList.remove('status-pending', 'status-running', 'status-done', 'status-error')
  statusElement.classList.add(`status-${status}`)
  statusElement.textContent = labels[status] || status
}

function resetManualStepStatuses() {
  document.querySelectorAll('.step-status').forEach((element) => {
    const step = element.dataset.step
    if (step) {
      setManualStepStatus(step, 'pending')
    }
  })
}

async function checkGitInstalled(force = false) {
  if (state.gitInstalled && !force) return true
  const result = await runPowerShell('Get-Command git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source', { logOutput: false })
  const installed = result.stdout.trim().length > 0
  state.gitInstalled = installed
  return installed
}

async function ensureGitInstalled() {
  const installed = await checkGitInstalled()
  if (installed) return true
  log('未检测到 Git，准备自动安装 Git...')
  const result = await runPowerShell('scoop install git')
  if (result.code !== 0) {
    log('Git 安装失败，请查看日志。', 'error')
    return false
  }
  const verified = await checkGitInstalled(true)
  if (!verified) {
    log('Git 安装完成但仍未检测到，请重试。', 'error')
  }
  return verified
}

async function migrateScoopInstallPath(targetPath) {
  const normalized = normalizeScoopPath(targetPath)
  if (!normalized) {
    log('请选择有效的目标路径。', 'error')
    return
  }
  if (fs.existsSync(normalized)) {
    const stat = fs.statSync(normalized)
    if (!stat.isDirectory()) {
      log('目标路径不是文件夹，请重新选择。', 'error')
      return
    }
  } else {
    try {
      fs.mkdirSync(normalized, { recursive: true })
      log('目标目录不存在，已自动创建。')
    } catch (error) {
      log('创建目标目录失败，请检查权限。', 'error')
      return
    }
  }
  const currentPath = resolveCurrentScoopPath()
  if (!hasScoopAtPath(currentPath)) {
    log('未检测到有效的 Scoop 安装目录，请先校准当前路径。', 'error')
    return
  }
  if (path.resolve(currentPath) === path.resolve(normalized)) {
    log('目标路径与当前路径一致，无需迁移。')
    return
  }
  await runTask('迁移 Scoop 安装目录', async () => {
    log('导出当前 Scoop 环境清单...')
    await refreshBuckets()
    await refreshInstalled()
    const migrationPlan = {
      exportedAt: new Date().toISOString(),
      buckets: [...state.buckets],
      apps: state.installedApps.map((app) => getDisplayName(app))
    }
    const tempPlanPath = path.join(os.tmpdir(), `scoopdesk-migrate-${Date.now()}.json`)
    fs.writeFileSync(tempPlanPath, JSON.stringify(migrationPlan, null, 2))
    log(`已导出迁移清单到 ${tempPlanPath}`)

    if (migrationPlan.apps.length) {
      log(`开始卸载应用 (${migrationPlan.apps.length} 项)...`)
      for (const app of migrationPlan.apps) {
        await runPowerShell(`scoop uninstall ${app}`)
      }
      log('应用卸载完成。')
    }
    log(`准备迁移 Scoop: ${currentPath} -> ${normalized}`)
    await runPowerShell('scoop cleanup *', { logOutput: false })
    const commands = [
      `if (-not (Test-Path -Path ${psQuote(normalized)})) { New-Item -ItemType Directory -Force -Path ${psQuote(normalized)} | Out-Null }`,
      `Stop-Process -Name "scoop" -ErrorAction SilentlyContinue`,
      `$scoopRoot = ${psQuote(currentPath)}; Get-Process | Where-Object { $_.Path -and $_.Path -like ($scoopRoot + '\\*') } | Stop-Process -Force -ErrorAction SilentlyContinue`,
      `try { Move-Item -Path (Join-Path -Path ${psQuote(currentPath)} -ChildPath '*') -Destination ${psQuote(normalized)} -Force -ErrorAction Stop } catch { Write-Error $_; exit 1 }`,
      `$env:SCOOP=${psQuote(normalized)}`,
      `[Environment]::SetEnvironmentVariable('SCOOP', ${psQuote(normalized)}, 'User')`
    ]
    const result = await runPowerShell(commands.join('; '))
    if (result.code !== 0) {
      log('迁移失败，请查看日志。', 'error')
      return
    }
    setScoopPath(normalized)
    log('Scoop 安装目录迁移完成。')

    if (migrationPlan.buckets.length) {
      log(`恢复 buckets (${migrationPlan.buckets.length} 个)...`)
      for (const bucket of migrationPlan.buckets) {
        if (bucket?.name) {
          await addBucket(bucket.name, bucket.url)
        }
      }
    }
    if (migrationPlan.apps.length) {
      log(`恢复应用安装 (${migrationPlan.apps.length} 项)...`)
      for (const app of migrationPlan.apps) {
        await runPowerShell(`scoop install ${app}`)
      }
    }
    await handleInstallDetection()
    log('迁移与恢复完成。')
  })
}

function setStatus(installed) {
  state.scoopInstalled = installed
  elements.statusText.textContent = installed ? '已检测到 Scoop 环境' : '未检测到 Scoop'
  elements.statusDot.classList.toggle('ok', installed)
  elements.statusDot.classList.toggle('warn', !installed)
  if (elements.autoInstall) {
    elements.autoInstall.disabled = installed
  }
  elements.manualButtons.forEach((button) => {
    button.disabled = installed
  })
  if (elements.setupSection) {
    elements.setupSection.classList.toggle('hidden', installed)
  }
  if (elements.navSetup) {
    elements.navSetup.classList.toggle('hidden', installed)
  }
  if (elements.navMigration) {
    elements.navMigration.classList.toggle('hidden', !installed)
  }
  if (elements.migrationSection) {
    elements.migrationSection.classList.toggle('hidden', !installed)
  }
  if (!installed && elements.navMigration?.classList.contains('active')) {
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'))
    elements.navSetup?.classList.add('active')
    document.querySelectorAll('.section').forEach((section) => {
      section.classList.toggle('active', section.id === 'section-setup')
    })
  }
  if (installed && elements.navSetup?.classList.contains('active')) {
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'))
    if (elements.navHome) {
      elements.navHome.classList.add('active')
    }
    document.querySelectorAll('.section').forEach((section) => {
      section.classList.toggle('active', section.id === 'section-home')
    })
  }
  updateActionState()
}

function setStatusChecking() {
  state.scoopInstalled = false
  elements.statusText.textContent = '正在检测 Scoop...'
  elements.statusDot.classList.remove('ok', 'warn')
  updateStoreNotice()
  updateActionState()
}

async function runTask(label, task, options = {}) {
  const { allowWhileBusy = false } = options
  if (state.busy && !allowWhileBusy && !queueRunning) {
    log('当前有任务正在执行，请稍候。', 'error')
    return
  }
  const taskLabel = label || '处理中'
  pushBusy(taskLabel)
  try {
    await task()
  } catch (error) {
    log(error?.message || '执行失败，请查看日志。', 'error')
  } finally {
    popBusy(taskLabel)
  }
}

function runPowerShell(command, options = {}) {
  return new Promise((resolve) => {
    const { logOutput = true, utf8 = false, ...spawnOptions } = options
    const prefix = utf8
      ? '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; chcp 65001 | Out-Null; '
      : ''
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${prefix}${command}`], {
      ...spawnOptions
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
      if (!logOutput) return
      const text = data.toString().trim()
      if (text) log(text)
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
      if (!logOutput) return
      const text = data.toString().trim()
      if (text) log(text, 'error')
    })

    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    layout: config.layout || config.store?.layout || DEFAULT_CONFIG.layout,
    scoopPath: typeof config.scoopPath === 'string' ? config.scoopPath : DEFAULT_CONFIG.scoopPath,
    buckets: Array.isArray(config.buckets) ? config.buckets : DEFAULT_CONFIG.buckets,
    managers: Array.isArray(config.managers) ? config.managers : [],
    store: {
      ...DEFAULT_CONFIG.store,
      ...(config.store || {})
    },
    advanced: config.advanced || null
  }
}

function safeWriteConfigFile(config) {
  const payload = JSON.stringify(config, null, 2)
  try {
    ensureDataDir()
    fs.writeFileSync(CONFIG_PATH, payload)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST') {
      ensureDataDir()
      fs.writeFileSync(CONFIG_PATH, payload)
    } else {
      throw error
    }
  }
}

function readConfig() {
  ensureDataDir()
  if (!fs.existsSync(CONFIG_PATH)) {
    const initial = normalizeConfig()
    safeWriteConfigFile(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    const normalized = normalizeConfig(parsed || {})
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      safeWriteConfigFile(normalized)
    }
    return normalized
  } catch (error) {
    log('配置文件读取失败，已恢复为默认配置。', 'error')
    const fallback = normalizeConfig()
    safeWriteConfigFile(fallback)
    return fallback
  }
}

function saveConfig(config) {
  ensureDataDir()
  const normalized = normalizeConfig(config || {})
  safeWriteConfigFile(normalized)
}

function buildPackageSourceCommands(step) {
  const manager = String(step.manager || '').toLowerCase()
  const action = String(step.action || 'add').toLowerCase()
  if (manager === 'winget') {
    if (action === 'reset') {
      return ['winget source reset --force']
    }
    if (action === 'remove') {
      if (!step.name) return null
      return [`winget source remove -n "${step.name}"`]
    }
    if (action === 'add' || action === 'replace') {
      if (!step.name || !(step.arg || step.url)) return null
      const arg = step.arg || step.url
      const sourceType = step.sourceType ? ` -t "${step.sourceType}"` : ''
      const addCommand = `winget source add -n "${step.name}" -a "${arg}"${sourceType} --accept-source-agreements`
      if (action === 'replace') {
        return [`winget source remove -n "${step.name}"`, addCommand]
      }
      return [addCommand]
    }
  }
  if (manager === 'choco' || manager === 'chocolatey') {
    if (action === 'remove') {
      if (!step.name) return null
      return [`choco source remove -n="${step.name}"`]
    }
    if (action === 'add' || action === 'replace') {
      if (!step.name || !step.url) return null
      const priority = step.priority ? ` --priority=${step.priority}` : ''
      const addCommand = `choco source add -n="${step.name}" -s="${step.url}"${priority}`
      if (action === 'replace') {
        return [`choco source remove -n="${step.name}"`, addCommand]
      }
      return [addCommand]
    }
  }
  return null
}

async function detectScoop() {
  setStatusChecking()
  const homeScoop = path.join(os.homedir(), 'scoop')
  const customScoop = normalizeScoopPath(state.scoopPath)
  const candidatePaths = [customScoop, homeScoop].filter(Boolean)
  const uniquePaths = [...new Set(candidatePaths.map((value) => path.resolve(value)))]
  if (uniquePaths.some((scoopPath) => hasScoopAtPath(scoopPath))) {
    setStatus(true)
    await refreshBuckets()
    await refreshInstalled()
    return true
  }
  const result = await runPowerShell('Get-Command scoop -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source', { logOutput: false })
  const installed = result.stdout.trim().length > 0
  setStatus(installed)
  if (installed) {
    await refreshBuckets()
    await refreshInstalled()
  }
  return installed
}

async function handleInstallDetection() {
  const installed = await detectScoop()
  toggleRestartHint(!installed)
  return installed
}

async function autoInstallScoop() {
  await runTask('安装 Scoop', async () => {
    log('开始自动安装 Scoop...')
    resetManualStepStatuses()
    toggleRestartHint(false)
    setManualStepStatus('policy', 'running')
    const policyResult = await runPowerShell('Set-ExecutionPolicy -Scope Process Bypass -Force')
    if (policyResult.code !== 0) {
      setManualStepStatus('policy', 'error')
      log('步骤 1 执行失败，请查看日志。', 'error')
      return
    }
    setManualStepStatus('policy', 'done')

    setManualStepStatus('install', 'running')
    const installResult = await runPowerShell(buildScoopInstallCommand())
    if (installResult.code !== 0) {
      setManualStepStatus('install', 'error')
      log('步骤 2 执行失败，请查看日志。', 'error')
      return
    }
    setManualStepStatus('install', 'done')

    setManualStepStatus('path', 'running')
    const pathResult = await runPowerShell(buildScoopPathCommand())
    if (pathResult.code !== 0) {
      setManualStepStatus('path', 'error')
      log('步骤 3 执行失败，请查看日志。', 'error')
      return
    }
    setManualStepStatus('path', 'done')

    log('Scoop 安装步骤已完成。')
    await handleInstallDetection()
  }, { allowWhileBusy: true })
}

async function runManualStep(step) {
  await runTask('执行手动步骤', async () => {
    const commands = {
      policy: 'Set-ExecutionPolicy -Scope Process Bypass -Force',
      install: buildScoopInstallCommand(),
      path: buildScoopPathCommand()
    }
    const command = commands[step]
    if (!command) return
    log(`执行步骤：${step}`)
    setManualStepStatus(step, 'running')
    const result = await runPowerShell(command)
    if (result.code !== 0) {
      setManualStepStatus(step, 'error')
      log('步骤执行失败，请查看日志。', 'error')
      return
    }
    setManualStepStatus(step, 'done')
    if (step !== 'policy') {
      await handleInstallDetection()
    }
  })
}

function copyManualCommands() {
  const commands = [
    'Set-ExecutionPolicy -Scope Process Bypass -Force',
    buildScoopInstallCommand(),
    buildScoopPathCommand()
  ].join('\n')
  clipboard.writeText(commands)
  log('已复制全部手动安装命令。')
}

async function addBucket(name, url) {
  if (!name) return
  if (!requireScoop('添加 bucket')) return
  await runTask(`添加 bucket: ${name}`, async () => {
    if (!(await ensureGitInstalled())) return
    const command = url ? `scoop bucket add ${name} ${url}` : `scoop bucket add ${name}`
    log(`添加 bucket: ${name}`)
    await runPowerShell(command)
    const config = readConfig()
    const updated = [...(config.buckets || [])]
    const existingIndex = updated.findIndex((bucket) => bucket.name === name)
    const payload = url ? { name, url } : { name }
    if (existingIndex >= 0) {
      updated[existingIndex] = payload
    } else {
      updated.push(payload)
    }
    config.buckets = updated
    saveConfig(config)
    await refreshBuckets()
  }, { allowWhileBusy: true })
}

async function refreshBuckets() {
  if (!state.scoopInstalled) {
    const config = readConfig()
    state.buckets = config.buckets || []
    renderBuckets()
    return
  }
  await runTask('同步 bucket 列表', async () => {
    const result = await runPowerShell('scoop bucket list', { logOutput: false })
    const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    const buckets = []
    for (const line of lines) {
      if (!isValidBucketName(line)) continue
      const parts = line.split(/\s+/)
      if (!isValidBucketName(parts[0])) continue
      buckets.push({ name: parts[0] })
    }
    const config = readConfig()
    const merged = buckets.map((bucket) => {
      const existing = (config.buckets || []).find((item) => item.name === bucket.name)
      return existing || bucket
    })
    config.buckets = merged
    saveConfig(config)
    state.buckets = merged
    state.bucketPage = 1
    renderBuckets()
  }, { allowWhileBusy: true })
}

function renderBuckets() {
  elements.bucketList.innerHTML = ''
  const cleanBuckets = state.buckets.filter((bucket) => isValidBucketName(bucket?.name))
  if (cleanBuckets.length === 0) {
    const li = document.createElement('li')
    li.textContent = '暂无 bucket'
    elements.bucketList.appendChild(li)
    updateBucketPagination(1)
    updateStats()
    return
  }
  const { items, totalPages, page } = getPagedItems(cleanBuckets, state.bucketPage, state.bucketPageSize)
  state.bucketPage = page
  updateBucketPagination(totalPages)
  items.forEach((bucket) => {
    const li = document.createElement('li')
    li.innerHTML = `
      <span>${bucket.name}</span>
      <button class="ghost-btn" data-action="remove">移除</button>
    `
    li.querySelector('button').addEventListener('click', async () => {
      if (!requireScoop('移除 bucket')) return
      await runTask(`移除 bucket: ${bucket.name}`, async () => {
        log(`移除 bucket: ${bucket.name}`)
        await runPowerShell(`scoop bucket rm ${bucket.name}`)
        const config = readConfig()
        config.buckets = (config.buckets || []).filter((item) => item.name !== bucket.name)
        saveConfig(config)
        await refreshBuckets()
      })
    })
    elements.bucketList.appendChild(li)
  })
  updateStats()
}

async function addDefaultBuckets() {
  if (!requireScoop('添加默认 bucket')) return
  await runTask('添加默认 bucket 组合', async () => {
    if (!(await ensureGitInstalled())) return
    for (const bucket of DEFAULT_BUCKETS) {
      await addBucket(bucket.name, bucket.url)
    }
  })
}

async function searchApps(query) {
  const managers = getActiveManagers()
  if (!managers.length) {
    log('未选择包管理器。', 'error')
    return
  }
  if (!query) {
    state.storeMode = 'installed'
    state.searchResults = []
    state.searchPage = 1
    renderSearchResults()
    return
  }
  const requiresScoop = managers.some((manager) => manager.requiresScoop)
  if (requiresScoop && !requireScoop('搜索应用')) return
  const categories = state.selectedCategories.length ? state.selectedCategories : ['']
  await runTask(`搜索应用: ${query}`, async () => {
    log(`搜索应用: ${query}`)
    const results = []
    const seen = new Set()
    for (const manager of managers) {
      const commands = categories.map((category) => {
        const categoryFlag = category && manager.categoryFlag ? formatCommand(manager.categoryFlag, { category }) : ''
        return formatCommand(manager.search, { query, category: categoryFlag })
      }).filter(Boolean)
      for (const command of commands) {
        const result = await runPowerShell(command, { utf8: manager.parse === 'choco' })
        const apps = parseManagerOutput(manager, result.stdout)
        apps.forEach((app) => {
          const key = `${manager.id}:${app.id || app.name}`
          if (seen.has(key)) return
          seen.add(key)
          results.push({ ...app, manager: manager.id })
        })
      }
    }
    await primeAppDetailIndex(results)
    state.searchResults = results
    state.searchPage = 1
    state.storeMode = 'search'
    renderSearchResults()
  })
}

function renderSearchResults() {
  elements.searchResults.innerHTML = ''
  const baseItems = state.storeMode === 'search' ? state.searchResults : state.installedApps
  const activeManagerIds = getActiveManagers().map((manager) => manager.id)
  const items = state.storeMode === 'search' || !activeManagerIds.length
    ? baseItems
    : baseItems.filter((item) => activeManagerIds.includes(item?.manager))
  const emptyText = state.storeMode === 'search' ? '无搜索结果' : '暂无已安装应用'
  if (elements.storeListTitle) {
    elements.storeListTitle.textContent = state.storeMode === 'search' ? '搜索结果' : '已安装'
  }
  elements.searchResults.classList.toggle('grid-layout', state.appLayout === 'top' || state.appLayout === 'split')
  if (items.length === 0) {
    const li = document.createElement('li')
    li.textContent = emptyText
    elements.searchResults.appendChild(li)
    updateSearchPagination(1)
    updateStats()
    return
  }
  const pageSize = state.appLayout === 'split' ? 9 : state.searchPageSize
  const paged = getPagedItems(items, state.searchPage, pageSize)
  state.searchPage = paged.page
  const totalPages = paged.totalPages
  updateSearchPagination(totalPages)
  paged.items.forEach((item) => {
    const li = document.createElement('li')
    const installed = isAppInstalled(item)
    const displayName = getDisplayName(item)
    const manager = getManagerById(item?.manager)
    const sourceLabel = manager?.label || item?.manager || '未知来源'
    const iconLetter = (displayName || '?').slice(0, 1).toUpperCase()
    const detailKey = buildAppKey(item?.manager || 'scoop', displayName)
    const detailAvailable = !!state.appDetailIndex[detailKey]
    li.classList.add('app-item')
    const info = document.createElement('div')
    info.className = 'app-info'
    const icon = document.createElement('div')
    icon.className = 'app-icon'
    icon.textContent = iconLetter
    const text = document.createElement('div')
    text.className = 'app-text'
    const nameSpan = document.createElement('span')
    nameSpan.className = 'app-name'
    nameSpan.textContent = displayName
    nameSpan.title = displayName
    const tag = document.createElement('span')
    tag.className = 'source-tag'
    tag.textContent = sourceLabel
    text.appendChild(nameSpan)
    text.appendChild(tag)
    info.appendChild(icon)
    info.appendChild(text)

    const actions = document.createElement('div')
    actions.className = 'app-actions'
    if (detailAvailable) {
      const detailButton = document.createElement('button')
      detailButton.className = 'ghost-btn'
      detailButton.dataset.action = 'detail'
      detailButton.textContent = '详情'
      detailButton.addEventListener('click', async () => {
        await openAppDetail(item)
      })
      actions.appendChild(detailButton)
    }
    if (installed) {
      const checkButton = document.createElement('button')
      checkButton.className = 'ghost-btn'
      checkButton.dataset.action = 'check'
      checkButton.textContent = '检测'
      checkButton.addEventListener('click', () => {
        queueCheckUpdate(item)
      })
      actions.appendChild(checkButton)
    }
    const actionButton = document.createElement('button')
    actionButton.className = installed ? 'ghost-btn' : 'primary-btn'
    actionButton.dataset.action = installed ? 'uninstall' : 'install'
    actionButton.textContent = installed ? '卸载' : '安装'
    actionButton.addEventListener('click', () => {
      if (installed) {
        queueUninstallApp(item)
      } else {
        queueInstallApp(item)
      }
    })
    actions.appendChild(actionButton)
    li.appendChild(info)
    li.appendChild(actions)
    elements.searchResults.appendChild(li)
  })
  updateStats()
}

async function refreshInstalled() {
  const runnableManagers = state.packageManagers.filter((manager) => !(manager.requiresScoop && !state.scoopInstalled))
  if (!runnableManagers.length) {
    log('未配置可用的包管理器。', 'error')
    state.installedApps = []
    renderSearchResults()
    updateAnalytics()
    return
  }
  await runTask('同步已安装列表', async () => {
    log('开始同步已安装列表...')
    const results = []
    const seen = new Set()
    const stats = {}
    const tasks = runnableManagers.map(async (manager) => {
      const command = buildManagerCommand(manager, 'list')
      if (!command) {
        stats[manager.id] = 0
        return
      }
      stats[manager.id] = 0
      const result = await runPowerShell(command, { logOutput: false, utf8: manager.parse === 'choco' })
      const apps = parseManagerOutput(manager, result.stdout)
      apps.forEach((app) => {
        const key = `${manager.id}:${app.id || app.name}`
        if (seen.has(key)) return
        seen.add(key)
        results.push({ ...app, manager: manager.id })
        stats[manager.id] += 1
      })
    })
    await Promise.all(tasks)
    await primeAppDetailIndex(results)
    state.installedApps = runnableManagers.length ? results : []
    state.managerStats = stats
    state.searchPage = 1
    renderSearchResults()
    updateAnalytics()
    log(`已同步已安装列表，共 ${state.installedApps.length} 项。`)
  }, { allowWhileBusy: true })
}

async function exportEnvironment() {
  if (!requireScoop('导出环境')) return
  await runTask('导出环境', async () => {
    const config = readConfig()
    await refreshInstalled()
    const data = {
      exportedAt: new Date().toISOString(),
      buckets: state.buckets.length ? state.buckets : config.buckets,
      apps: state.installedApps.map((app) => getDisplayName(app))
    }
    const savePath = await ipcRenderer.invoke('select-save-path', 'scoopdesk-backup.json')
    if (!savePath) return
    fs.writeFileSync(savePath, JSON.stringify(data, null, 2))
    log(`已导出环境到 ${savePath}`)
  })
}

async function importEnvironment() {
  const filePath = await ipcRenderer.invoke('select-open-path')
  if (!filePath) return
  const content = fs.readFileSync(filePath, 'utf-8')
  let data = null
  try {
    data = JSON.parse(content)
  } catch (error) {
    log('备份文件解析失败。', 'error')
    return
  }
  if (!data || !Array.isArray(data.apps)) {
    log('备份文件格式不正确。', 'error')
    return
  }
  state.restorePlan = {
    filePath,
    buckets: Array.isArray(data.buckets) ? data.buckets : [],
    apps: data.apps
  }
  updateRestorePreview()
  log('恢复计划已加载，请确认后执行。')
}

async function runRestorePlan() {
  if (!state.restorePlan) return
  enqueueTask('环境恢复准备', async () => {
    if (!state.scoopInstalled) {
      log('检测到未安装 Scoop，将先自动安装。')
      await autoInstallScoop()
    }
  })
  state.restorePlan.buckets.forEach((bucket) => {
    if (bucket.name) {
      enqueueTask(`恢复 bucket: ${bucket.name}`, async () => {
        await addBucket(bucket.name, bucket.url)
      })
    }
  })
  state.restorePlan.apps.forEach((app) => {
    enqueueTask(`恢复应用: ${app}`, async () => {
      log(`恢复安装: ${app}`)
      await runPowerShell(`scoop install ${app}`)
    })
  })
  enqueueTask('刷新已安装列表', async () => {
    await refreshInstalled()
    log('环境恢复完成。')
  })
}

function clearRestorePlan() {
  state.restorePlan = null
  updateRestorePreview()
  log('已清空恢复计划。')
}

async function applyRegistryPath() {
  await runTask('写入注册表路径', async () => {
    log('写入 Scoop shims 路径到注册表。')
    await runPowerShell("[Environment]::SetEnvironmentVariable('Path', $env:Path + ';' + $env:USERPROFILE + '\\scoop\\shims', 'User')")
    log('注册表写入完成，请重新打开终端生效。')
  })
}

function updateAdvancedUI() {
  elements.advancedSteps.innerHTML = ''
  if (!state.advancedConfig) {
    elements.advancedTitle.textContent = '尚未加载配置'
    return
  }
  elements.advancedTitle.textContent = state.advancedConfig.title || '自定义安装流程'
  state.advancedConfig.steps.forEach((step, index) => {
    const status = state.advancedStatus[index] || 'pending'
    const statusLabel = {
      pending: '待执行',
      running: '执行中',
      done: '完成',
      error: '失败'
    }[status]
    const li = document.createElement('li')
    li.innerHTML = `
      <div>
        <strong>${step.name || `步骤 ${index + 1}`}</strong>
        <p>${step.description || '未提供描述'}</p>
      </div>
      <div class="row-actions">
        <span class="status-pill status-${status}">${statusLabel}</span>
        <button class="outline-btn" data-action="run">执行</button>
      </div>
    `
    li.querySelector('button').addEventListener('click', async () => {
      await runAdvancedStep(step, index)
    })
    elements.advancedSteps.appendChild(li)
  })
  updateActionState()
}

async function runAdvancedStep(step, index) {
  await runTask(`执行高级步骤 ${index + 1}`, async () => {
    log(`执行高级步骤 ${index + 1}: ${step.name || step.type}`)
    state.advancedStatus[index] = 'running'
    updateAdvancedUI()
    try {
      if (step.type === 'scoop-bucket') {
        await addBucket(step.name, step.url)
      } else if (step.type === 'scoop-install') {
        if (!requireScoop('安装应用')) throw new Error('未检测到 Scoop')
        await runPowerShell(`scoop install ${step.name}`)
      } else if (step.type === 'package-source') {
        const commands = buildPackageSourceCommands(step)
        if (!commands || commands.length === 0) {
          throw new Error('包源配置参数不完整。')
        }
        for (const cmd of commands) {
          await runPowerShell(cmd)
        }
      } else if (step.type === 'command') {
        if (Array.isArray(step.commands)) {
          for (const cmd of step.commands) {
            await runPowerShell(cmd)
          }
        } else if (step.command) {
          await runPowerShell(step.command)
        }
      } else {
        throw new Error(`未知步骤类型: ${step.type}`)
      }
      state.advancedStatus[index] = 'done'
    } catch (error) {
      state.advancedStatus[index] = 'error'
      log(error?.message || '高级步骤执行失败。', 'error')
    }
    updateAdvancedUI()
  })
}

async function runAllAdvanced() {
  if (!state.advancedConfig) {
    log('未加载高级配置。', 'error')
    return
  }
  for (let i = 0; i < state.advancedConfig.steps.length; i += 1) {
    await runAdvancedStep(state.advancedConfig.steps[i], i)
  }
  log('高级流程执行完成。')
}

function loadAdvancedTemplate() {
  const template = {
    title: '新机器环境配置',
    steps: [
      {
        type: 'scoop-bucket',
        name: 'extras',
        description: '添加常用 bucket (extras)'
      },
      {
        type: 'package-source',
        manager: 'winget',
        action: 'replace',
        name: 'winget',
        arg: 'https://cdn.winget.microsoft.com/cache',
        description: '替换 winget 源为国内镜像'
      },
      {
        type: 'scoop-install',
        name: 'git',
        description: '安装 Git'
      },
      {
        type: 'command',
        name: '安装 Node.js (fnm)',
        description: '示例：运行其他命令行安装流程',
        command: 'winget install Schniz.fnm'
      }
    ]
  }
  elements.advancedInput.value = JSON.stringify(template, null, 2)
}

function parseAdvancedConfig() {
  let config = null
  try {
    config = JSON.parse(elements.advancedInput.value)
  } catch (error) {
    log('高级配置解析失败，请检查 JSON。', 'error')
    return
  }
  if (!config || !Array.isArray(config.steps)) {
    log('高级配置格式错误。', 'error')
    return
  }
  state.advancedConfig = config
  state.advancedStatus = config.steps.map(() => 'pending')
  const saved = readConfig()
  saved.advanced = config
  saveConfig(saved)
  updateAdvancedUI()
  log('高级配置加载成功。')
}

function updateRestorePreview() {
  if (!elements.restoreSummary || !elements.restoreList) return
  elements.restoreList.innerHTML = ''
  if (!state.restorePlan) {
    elements.restoreSummary.textContent = '尚未加载恢复计划。'
    updateActionState()
    return
  }
  const bucketCount = state.restorePlan.buckets.length
  const appCount = state.restorePlan.apps.length
  elements.restoreSummary.textContent = `共包含 ${bucketCount} 个 bucket，${appCount} 个应用。`
  if (bucketCount === 0 && appCount === 0) {
    const li = document.createElement('li')
    li.textContent = '恢复计划为空'
    elements.restoreList.appendChild(li)
  }
  if (bucketCount) {
    const header = document.createElement('li')
    header.className = 'list-heading'
    header.textContent = 'Buckets'
    elements.restoreList.appendChild(header)
    state.restorePlan.buckets.forEach((bucket) => {
      const li = document.createElement('li')
      li.textContent = bucket.name || '未命名 bucket'
      elements.restoreList.appendChild(li)
    })
  }
  if (appCount) {
    const header = document.createElement('li')
    header.className = 'list-heading'
    header.textContent = 'Apps'
    elements.restoreList.appendChild(header)
    state.restorePlan.apps.forEach((app) => {
      const li = document.createElement('li')
      li.textContent = app
      elements.restoreList.appendChild(li)
    })
  }
  updateActionState()
}

async function loadAdvancedFromFile() {
  const filePath = await ipcRenderer.invoke('select-open-path')
  if (!filePath) return
  elements.advancedInput.value = fs.readFileSync(filePath, 'utf-8')
}

function setupNavigation() {
  const buttons = document.querySelectorAll('.nav-btn')
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      buttons.forEach((btn) => btn.classList.remove('active'))
      button.classList.add('active')
      const target = button.dataset.target
      document.querySelectorAll('.section').forEach((section) => {
        section.classList.toggle('active', section.id === `section-${target}`)
      })
    })
  })
}

function init() {
  setupNavigation()
  const config = readConfig()
  state.buckets = config.buckets || []
  state.packageManagers = mergeManagers(config.managers)
  setScoopPath(config.scoopPath || '', { persist: false })
  state.appLayout = config.layout || config.store?.layout || 'classic'
  const storedManagers = Array.isArray(config.store?.managers) && config.store.managers.length
    ? config.store.managers
    : (config.store?.manager ? [config.store.manager] : [])
  setActiveManagers(storedManagers, { persist: false })
  state.selectedCategories = Array.isArray(config.store?.categories) ? config.store.categories : []
  renderCategoryTags()
  setAppLayout(state.appLayout, { persist: false })
  if (config.advanced) {
    state.advancedConfig = config.advanced
    state.advancedStatus = config.advanced.steps?.map(() => 'pending') || []
    elements.advancedInput.value = JSON.stringify(config.advanced, null, 2)
  }

  detectScoop()
  renderBuckets()
  refreshInstalled()
  updateRestorePreview()
  updateAdvancedUI()
  updateStats()
  updateActionState()

  if (elements.appVersion) {
    elements.appVersion.textContent = process.env.npm_package_version || '-'
  }
  setUpdateStatus('未检查')
  elements.appUpdateCheck?.addEventListener('click', () => {
    checkAppUpdate()
  })
  elements.appUpdateInstall?.addEventListener('click', () => {
    downloadAndInstallUpdate()
  })
  checkAppUpdate({ silent: true })

  elements.refreshStatus.addEventListener('click', detectScoop)
  elements.autoInstall.addEventListener('click', autoInstallScoop)
  elements.manualButtons.forEach((button) => {
    button.addEventListener('click', () => runManualStep(button.dataset.step))
  })
  elements.copyCommands.addEventListener('click', copyManualCommands)
  elements.appDetailClose?.addEventListener('click', closeAppDetailModal)
  elements.appDetailModal?.addEventListener('click', (event) => {
    if (event.target === elements.appDetailModal) {
      closeAppDetailModal()
    }
  })
  elements.openBucketModal?.addEventListener('click', async () => {
    if (!requireScoop('打开 Bucket 管理')) return
    showBucketModal()
    await refreshBuckets()
  })
  elements.bucketModalClose?.addEventListener('click', closeBucketModal)
  elements.bucketModal?.addEventListener('click', (event) => {
    if (event.target === elements.bucketModal) {
      closeBucketModal()
    }
  })
  elements.restartDetect?.addEventListener('click', handleInstallDetection)
  elements.migrateScoopPath?.addEventListener('click', async () => {
    let targetPath = elements.scoopPathMigrate?.value?.trim()
    if (!targetPath) {
      targetPath = await ipcRenderer.invoke('select-directory', state.scoopPath || os.homedir())
    }
    if (!targetPath) return
    await migrateScoopInstallPath(targetPath)
  })
  elements.selectScoopPathMigrate?.addEventListener('click', async () => {
    const selectedPath = await ipcRenderer.invoke('select-directory', state.scoopPath || os.homedir())
    if (selectedPath && elements.scoopPathMigrate) {
      elements.scoopPathMigrate.value = selectedPath
    }
  })
  elements.selectScoopPath?.addEventListener('click', async () => {
    const selectedPath = await ipcRenderer.invoke('select-directory', state.scoopPath || os.homedir())
    if (selectedPath) {
      setScoopPath(selectedPath)
    }
  })
  elements.scoopPathInput?.addEventListener('change', () => {
    setScoopPath(elements.scoopPathInput.value)
  })
  elements.scoopPathInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      setScoopPath(elements.scoopPathInput.value)
    }
  })
  elements.clearLog.addEventListener('click', () => {
    state.logs = []
    elements.logOutput.innerHTML = ''
    updateAnalytics()
  })

  elements.addBucket.addEventListener('click', () => {
    const name = elements.bucketName.value.trim()
    const url = elements.bucketUrl.value.trim()
    if (!name) {
      log('请输入 bucket 名称。', 'error')
      return
    }
    addBucket(name, url)
    elements.bucketName.value = ''
    elements.bucketUrl.value = ''
  })
  elements.addDefaultBuckets.addEventListener('click', addDefaultBuckets)
  elements.reloadBuckets.addEventListener('click', refreshBuckets)
  elements.refreshInstalled.addEventListener('click', refreshInstalled)

  elements.searchBtn.addEventListener('click', () => searchApps(elements.searchQuery.value.trim()))
  elements.searchQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      searchApps(elements.searchQuery.value.trim())
    }
  })
  elements.layoutClassic?.addEventListener('click', () => setAppLayout('classic'))
  elements.layoutTop?.addEventListener('click', () => setAppLayout('top'))
  elements.layoutSplit?.addEventListener('click', () => setAppLayout('split'))
  elements.categoryAdd?.addEventListener('click', () => {
    addCategoryTag(elements.categoryInput?.value)
    if (elements.categoryInput) {
      elements.categoryInput.value = ''
    }
  })
  elements.categoryInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addCategoryTag(elements.categoryInput.value)
      elements.categoryInput.value = ''
    }
  })

  elements.bucketPrev.addEventListener('click', () => {
    state.bucketPage = Math.max(1, state.bucketPage - 1)
    renderBuckets()
  })
  elements.bucketNext.addEventListener('click', () => {
    state.bucketPage += 1
    renderBuckets()
  })
  elements.searchPrev.addEventListener('click', () => {
    state.searchPage = Math.max(1, state.searchPage - 1)
    renderSearchResults()
  })
  elements.searchNext.addEventListener('click', () => {
    state.searchPage += 1
    renderSearchResults()
  })

  elements.exportEnv.addEventListener('click', exportEnvironment)
  elements.importEnv.addEventListener('click', importEnvironment)
  elements.applyRegistry.addEventListener('click', applyRegistryPath)
  elements.runRestore.addEventListener('click', runRestorePlan)
  elements.clearRestore.addEventListener('click', clearRestorePlan)
  elements.loadAdvanced.addEventListener('click', loadAdvancedFromFile)
  elements.useTemplate.addEventListener('click', loadAdvancedTemplate)
  elements.parseAdvanced.addEventListener('click', parseAdvancedConfig)
  elements.runAdvanced.addEventListener('click', runAllAdvanced)
}

window.addEventListener('DOMContentLoaded', init)
