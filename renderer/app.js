const { ipcRenderer, clipboard } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

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
  storeLayout: 'list',
  logs: []
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
    install: 'scoop install {name}',
    uninstall: 'scoop uninstall {name}',
    parse: 'scoop'
  },
  {
    id: 'winget',
    label: 'Winget',
    search: 'winget search --name "{query}" --accept-source-agreements {category}',
    list: 'winget list --accept-source-agreements',
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
    install: 'choco install {name} -y',
    uninstall: 'choco uninstall {name} -y',
    parse: 'choco'
  }
]

const DEFAULT_CONFIG = {
  buckets: DEFAULT_BUCKETS,
  advanced: null,
  managers: [],
  store: {
    manager: 'scoop',
    managers: ['scoop'],
    categories: [],
    layout: 'list'
  }
}

const DATA_DIR = path.join(os.homedir(), '.scoopdesk')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const LOG_PATH = path.join(DATA_DIR, 'scoopdesk.log')

const taskQueue = []
let queueRunning = false

const elements = {
  statusText: document.getElementById('status-text'),
  statusDot: document.getElementById('status-dot'),
  refreshStatus: document.getElementById('refresh-status'),
  autoInstall: document.getElementById('auto-install'),
  manualButtons: document.querySelectorAll('.step-action'),
  copyCommands: document.getElementById('copy-commands'),
  bucketCount: document.getElementById('bucket-count'),
  installedCount: document.getElementById('installed-count'),
  installedSub: document.getElementById('installed-sub'),
  globalStatus: document.getElementById('global-status'),
  busyIndicator: document.getElementById('busy-indicator'),
  busyText: document.getElementById('busy-text'),
  storeNotice: document.getElementById('store-notice'),
  setupSection: document.getElementById('section-setup'),
  navSetup: document.getElementById('nav-setup'),
  navStore: document.getElementById('nav-store'),
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
  layoutList: document.getElementById('layout-list'),
  layoutGrid: document.getElementById('layout-grid'),
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
  exportEnv: document.getElementById('export-env'),
  importEnv: document.getElementById('import-env'),
  applyRegistry: document.getElementById('apply-registry'),
  restoreSummary: document.getElementById('restore-summary'),
  restoreList: document.getElementById('restore-list'),
  runRestore: document.getElementById('run-restore'),
  clearRestore: document.getElementById('clear-restore'),
  logOutput: document.getElementById('log-output'),
  clearLog: document.getElementById('clear-log'),
  loadAdvanced: document.getElementById('load-advanced'),
  useTemplate: document.getElementById('use-template'),
  advancedInput: document.getElementById('advanced-input'),
  parseAdvanced: document.getElementById('parse-advanced'),
  advancedTitle: document.getElementById('advanced-title'),
  advancedSteps: document.getElementById('advanced-steps'),
  runAdvanced: document.getElementById('run-advanced')
}

function ensureDataDir() {
  if (fs.existsSync(DATA_DIR)) {
    const stat = fs.statSync(DATA_DIR)
    if (stat.isDirectory()) {
      return
    }
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
  setBusy(true, `队列处理中 (${taskQueue.length} 项)`)
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
  setBusy(false, '空闲')
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
  const managers = getActiveManagers()
  if (!managers.length) {
    elements.installedSub.textContent = '未选择来源'
    return
  }
  if (managers.length === 1 && managers[0].id === 'scoop') {
    elements.installedSub.textContent = '当前 Scoop 环境'
    return
  }
  const labels = managers.map((manager) => manager.label || manager.id).join(' / ')
  elements.installedSub.textContent = `当前来源: ${labels}`
}

function updateAnalytics() {
  if (elements.analysisInstalled) {
    elements.analysisInstalled.textContent = state.installedApps.length
  }
  if (elements.analysisBuckets) {
    elements.analysisBuckets.textContent = state.buckets.length
  }
  if (elements.analysisManagers) {
    elements.analysisManagers.textContent = getActiveManagers().length
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
    const counts = state.installedApps.reduce((acc, app) => {
      const id = app?.manager || 'unknown'
      acc[id] = (acc[id] || 0) + 1
      return acc
    }, {})
    const total = state.installedApps.length || 1
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
}

function updateLayoutButtons() {
  elements.layoutList?.classList.toggle('active', state.storeLayout === 'list')
  elements.layoutGrid?.classList.toggle('active', state.storeLayout === 'grid')
}

function setStoreLayout(layout, { persist = true } = {}) {
  state.storeLayout = layout === 'grid' ? 'grid' : 'list'
  elements.searchResults?.classList.toggle('grid-layout', state.storeLayout === 'grid')
  updateLayoutButtons()
  if (persist) {
    const config = readConfig()
    config.store = { ...(config.store || {}), layout: state.storeLayout }
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
    if (parts[0] === 'Installed' || parts[0] === '已安装') return
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
    if (!line) return
    const [name] = line.split('|')
    if (name) {
      apps.push({ name })
    }
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
  if (installed && elements.navSetup?.classList.contains('active')) {
    document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.remove('active'))
    if (elements.navStore) {
      elements.navStore.classList.add('active')
    }
    document.querySelectorAll('.section').forEach((section) => {
      section.classList.toggle('active', section.id === 'section-store')
    })
  }
  updateStoreNotice()
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
  const wasBusy = state.busy
  const previousMessage = state.busyMessage
  if (!wasBusy) {
    setBusy(true, label)
  } else {
    setBusyMessage(label)
  }
  try {
    await task()
  } catch (error) {
    log(error?.message || '执行失败，请查看日志。', 'error')
  } finally {
    if (!wasBusy) {
      setBusy(false, '空闲')
    } else {
      setBusyMessage(previousMessage)
    }
  }
}

function runPowerShell(command, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      ...options
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
      const text = data.toString().trim()
      if (text) log(text)
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
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
  if (fs.existsSync(homeScoop)) {
    setStatus(true)
    await refreshBuckets()
    await refreshInstalled()
    return true
  }
  const result = await runPowerShell('Get-Command scoop -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source')
  const installed = result.stdout.trim().length > 0
  setStatus(installed)
  if (installed) {
    await refreshBuckets()
    await refreshInstalled()
  }
  return installed
}

async function autoInstallScoop() {
  await runTask('安装 Scoop', async () => {
    log('开始自动安装 Scoop...')
    const command = 'Set-ExecutionPolicy -Scope Process Bypass -Force; iwr -useb get.scoop.sh | iex'
    const result = await runPowerShell(command)
    if (result.code === 0) {
      log('Scoop 安装完成。')
      await detectScoop()
    } else {
      log('Scoop 安装失败，请查看日志。', 'error')
    }
  }, { allowWhileBusy: true })
}

async function runManualStep(step) {
  await runTask('执行手动步骤', async () => {
    const commands = {
      policy: 'Set-ExecutionPolicy -Scope Process Bypass -Force',
      install: 'iwr -useb get.scoop.sh | iex',
      path: "[Environment]::SetEnvironmentVariable('Path', $env:Path + ';' + $env:USERPROFILE + '\\scoop\\shims', 'User')"
    }
    const command = commands[step]
    if (!command) return
    log(`执行步骤：${step}`)
    await runPowerShell(command)
    if (step !== 'path') {
      await detectScoop()
    }
  })
}

function copyManualCommands() {
  const commands = [
    'Set-ExecutionPolicy -Scope Process Bypass -Force',
    'iwr -useb get.scoop.sh | iex',
    "[Environment]::SetEnvironmentVariable('Path', $env:Path + ';' + $env:USERPROFILE + '\\scoop\\shims', 'User')"
  ].join('\n')
  clipboard.writeText(commands)
  log('已复制全部手动安装命令。')
}

async function addBucket(name, url) {
  if (!name) return
  if (!requireScoop('添加 bucket')) return
  await runTask(`添加 bucket: ${name}`, async () => {
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
    const result = await runPowerShell('scoop bucket list')
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
        const result = await runPowerShell(command)
        const apps = parseManagerOutput(manager, result.stdout)
        apps.forEach((app) => {
          const key = `${manager.id}:${app.id || app.name}`
          if (seen.has(key)) return
          seen.add(key)
          results.push({ ...app, manager: manager.id })
        })
      }
    }
    state.searchResults = results
    state.searchPage = 1
    state.storeMode = 'search'
    renderSearchResults()
  })
}

function renderSearchResults() {
  elements.searchResults.innerHTML = ''
  const items = state.storeMode === 'search' ? state.searchResults : state.installedApps
  const emptyText = state.storeMode === 'search' ? '无搜索结果' : '暂无已安装应用'
  if (elements.storeListTitle) {
    elements.storeListTitle.textContent = state.storeMode === 'search' ? '搜索结果' : '已安装'
  }
  elements.searchResults.classList.toggle('grid-layout', state.storeLayout === 'grid')
  if (items.length === 0) {
    const li = document.createElement('li')
    li.textContent = emptyText
    elements.searchResults.appendChild(li)
    updateSearchPagination(1)
    updateStats()
    return
  }
  const paged = getPagedItems(items, state.searchPage, state.searchPageSize)
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
    li.classList.add('app-item')
    li.innerHTML = `
      <div class="app-info">
        <div class="app-icon">${iconLetter}</div>
        <div class="app-text">
          <span class="app-name">${displayName}</span>
          <span class="source-tag">${sourceLabel}</span>
        </div>
      </div>
      <button class="${installed ? 'ghost-btn' : 'primary-btn'}" data-action="${installed ? 'uninstall' : 'install'}">${installed ? '卸载' : '安装'}</button>
    `
    const button = li.querySelector('button')
    button.addEventListener('click', async () => {
      if (installed) {
        queueUninstallApp(item)
      } else {
        queueInstallApp(item)
      }
    })
    elements.searchResults.appendChild(li)
  })
  updateStats()
}

async function refreshInstalled() {
  const managers = getActiveManagers()
  if (!managers.length) {
    log('未选择包管理器。', 'error')
    state.installedApps = []
    renderSearchResults()
    return
  }
  const runnable = managers.filter((manager) => !(manager.requiresScoop && !state.scoopInstalled))
  if (!runnable.length) {
    state.installedApps = []
    renderSearchResults()
    return
  }
  await runTask('同步已安装列表', async () => {
    const results = []
    const seen = new Set()
    for (const manager of runnable) {
      const command = buildManagerCommand(manager, 'list')
      if (!command) continue
      const result = await runPowerShell(command)
      const apps = parseManagerOutput(manager, result.stdout)
      apps.forEach((app) => {
        const key = `${manager.id}:${app.id || app.name}`
        if (seen.has(key)) return
        seen.add(key)
        results.push({ ...app, manager: manager.id })
      })
    }
    state.installedApps = results
    state.searchPage = 1
    renderSearchResults()
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
  state.storeLayout = config.store?.layout || 'list'
  const storedManagers = Array.isArray(config.store?.managers) && config.store.managers.length
    ? config.store.managers
    : (config.store?.manager ? [config.store.manager] : [])
  setActiveManagers(storedManagers, { persist: false })
  state.selectedCategories = Array.isArray(config.store?.categories) ? config.store.categories : []
  renderCategoryTags()
  setStoreLayout(state.storeLayout, { persist: false })
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

  elements.refreshStatus.addEventListener('click', detectScoop)
  elements.autoInstall.addEventListener('click', autoInstallScoop)
  elements.manualButtons.forEach((button) => {
    button.addEventListener('click', () => runManualStep(button.dataset.step))
  })
  elements.copyCommands.addEventListener('click', copyManualCommands)
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
  elements.layoutList?.addEventListener('click', () => setStoreLayout('list'))
  elements.layoutGrid?.addEventListener('click', () => setStoreLayout('grid'))
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
