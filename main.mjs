import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, protocol, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'

// Electron is pinned to 44 (Chromium 152) on purpose: Electron 45 (Chromium 156) draws the lines of
// PokéRogue's multi-line menus on top of each other (title menu unreadable). Re-check before upgrading.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'
const smoke = process.env.PRS_SMOKE // dev check: render, test saves, write a screenshot, quit

// Saves live in this app's localStorage (file:// origin) inside %APPDATA%\pokemon-rogue-battle
// (~/Library/Application Support/pokemon-rogue-battle on Mac). Every earlier desktop release used
// that folder: never rename it, or players who upgrade will not see their saves.
const DATA_DIR_NAME = 'pokemon-rogue-battle'
app.setName(DATA_DIR_NAME)
// PRS_DATA_DIR only applies to smoke tests and to dev runs (npx electron .), so a test can run against a
// copy of real saves or an empty profile. Dev runs also accept --remote-debugging-port (Electron's own
// switch) and the two test switches below; the packaged game ignores them.
const dev = !app.isPackaged
app.setPath('userData', ((smoke || dev) && process.env.PRS_DATA_DIR) || path.join(app.getPath('appData'), DATA_DIR_NAME))
const coopAuto = dev && process.env.PRS_COOP_AUTO // dev: open this co-op room right after the game loads
const skipAbout = smoke || coopAuto || (dev && process.env.PRS_SKIP_ABOUT)

const packAssets = app.isPackaged ? path.join(process.resourcesPath, 'pack-assets') : path.join(__dirname, 'pack-assets')
const icon = nativeImage.createFromPath(path.join(packAssets, isMac ? 'icon.png' : 'icon.ico'))
const gameVersion = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, 'game-version.json'), 'utf8')).pokerogueVersion } catch { return '' }
})()

const GUIDE = '快速上手：\n\nwasd / 方向键 - 选择\nz / 空格 - 继续\nx - 后退\nm / Esc - 菜单\nc - 查看战斗属性\nv - 查看敌人信息\n\n' +
  '游戏教程可参考up主四零：https://space.bilibili.com/1897229\n\n中文wiki：https://wiki.pokerogue.net/zh:start\n\n宝可梦wiki：https://wiki.52poke.com\n\n' +
  '本离线版由B站up主 黑咖啡和冰月亮 打包制作，觉得玩着不错的玩家可以给up主一键三连，关注！'

const GROUPS = '本游戏完全免费，任何从其他地方要求推广获得，甚至要求付费的，都是倒狗！谨防受骗，认准黑咖啡和冰月亮的群！以下为官方Q群链接，看哪个群没满就加哪个\n\n' +
  [['大大群', '129989017'], ['二群', '829752081'], ['三群', '290314213'], ['四群', '399912280'], ['五群', '961215124'],
    ['六群', '577325272'], ['七群', '971263521'], ['八群', '908017150'], ['九群', '219766648'], ['十群', '768689941'],
    ['十一群', '835098084'], ['十二群', '970469985'], ['十三群', '975324408'], ['十四群', '281786680']]
    .map(([n, q]) => `宝可梦肉鸽离线版交流群${n}\n${q}`).join('\n')

const ABOUT = '本游戏打包由B站 黑咖啡和冰月亮 原创。项目全程没有收费环节，小心受骗。复用开源代码请尊重原作者，留存出处信息\n\n' +
  `游戏版本：PokéRogue ${gameVersion}（Pagefault Games 开发，AGPL-3.0 开源）\n\n` +
  '更多游戏说明请参考顶部菜单\n\n适当游戏益脑，沉迷游戏伤身。祝游戏愉快！'

const helpItems = [
  { label: '游戏说明', click: () => dialog.showMessageBox({ title: '游戏说明', icon, message: GUIDE }) },
  { label: '官方群号', click: () => dialog.showMessageBox({ title: '官方群号', icon, message: GROUPS }) },
  { label: '地图图鉴', click: () => showImage('map.png', '地图图鉴') },
  { label: '克制表', click: () => showImage('type.png', '克制表') },
  { label: '性格表', click: () => showImage('nature.png', '性格表') },
]

// Co-op mode (2 players): this app is 1P and hosts the game; 2P joins from a phone browser, sees the game
// as a video stream and sends button presses. The scripts in coop/ (copied by scripts/sync-coop.sh) are
// injected into the game page when a room is opened; dist/ carries three small hooks for them
// (scripts/patch-coop.mjs) that do nothing while no room is open.
const COOP_ORIGIN = 'https://192.220.36.155:8790' // signaling server + phone page; its certificate is a normal trusted one
const COOP_SCRIPTS = ['coop.js', 'host.js', 'host-team.js', 'host-game.js', 'host-overlay.js'] // order matters
const COOP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I: the code is read aloud and typed on a phone
let gameWin = null
let gamePageReady = false // the game page finished loading, scripts can be injected
let coop = null // { room, link, win (info window, may be closed), status: [text, kind] } while a room is open

const coopItems = [
  { label: '开房间（我当 1P）', click: () => openCoopRoom() },
  { label: '关闭房间', click: () => closeCoopRoom() },
]

// Windows keeps the old one-click top-level items; macOS needs submenus plus the standard app/edit menus.
const template = isMac
  ? [{ role: 'appMenu' }, { role: 'editMenu' }, { label: '合作模式', submenu: coopItems }, { label: '帮助', submenu: helpItems }, { role: 'windowMenu' }]
  : [...helpItems, { label: '合作模式', submenu: coopItems }]

async function injectCoop() {
  const wc = gameWin.webContents
  await wc.executeJavaScript(`window.PRS_COOP_ROOM=${JSON.stringify(coop.room)};0`)
  for (const f of COOP_SCRIPTS) await wc.executeJavaScript(readFileSync(path.join(__dirname, 'coop', f), 'utf8') + '\n;0')
}

function setCoopStatus(text, kind = '') {
  if (!coop) return
  coop.status = [text, kind]
  if (coop.win && !coop.win.isDestroyed()) coop.win.webContents.executeJavaScript(`window.setStatus&&setStatus(${JSON.stringify(text)},${JSON.stringify(kind)});0`).catch(() => {})
}

// The co-op scripts report through console lines that start with "COOP" (see coop/host.js).
function onCoopLog(msg) {
  if (!coop) return
  if (/^COOP room open/.test(msg)) setCoopStatus(/here: true/.test(msg) ? '队友已进房间，正在连接…' : '等队友加入')
  else if (/^COOP guest joined/.test(msg)) setCoopStatus('队友已进房间，正在连接…')
  else if (/^COOP state connected/.test(msg)) setCoopStatus('队友已连接', 'ok')
  else if (/^COOP (guest left|state (disconnected|failed|closed))/.test(msg)) setCoopStatus('队友掉线，等队友重新加入', 'bad')
  else if (/^COOP FAIL/.test(msg)) setCoopStatus('开房间失败，请检查网络后关闭房间重开', 'bad')
}

function showCoopWindow() {
  if (coop.win && !coop.win.isDestroyed()) { coop.win.show(); return }
  const win = coop.win = new BrowserWindow({
    parent: gameWin, width: 440, height: 272, useContentSize: true, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, icon, title: `合作房间 ${coop.room}`, autoHideMenuBar: true, backgroundColor: '#2b2633',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.setMenu(null)
  win.on('page-title-updated', e => e.preventDefault()) // keep the room code in the title bar
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', e => {
    if (e.message === 'COOPROOM copy' && coop) clipboard.writeText(coop.link)
  })
  win.webContents.once('did-finish-load', () => { if (coop) setCoopStatus(...coop.status) })
  win.loadFile(path.join(packAssets, 'coop-room.html'), { query: { room: coop.room, link: coop.link } })
}

async function openCoopRoom(room) {
  if (!gameWin || gameWin.isDestroyed()) return
  if (coop) { showCoopWindow(); return } // one room at a time: show its info again
  room = (room || Array.from({ length: 6 }, () => COOP_CODE_CHARS[randomInt(COOP_CODE_CHARS.length)]).join('')).toUpperCase()
  coop = { room, link: `${COOP_ORIGIN}/coop/guest2.html?room=${room}&auto=1`, win: null, status: ['正在开房间…', ''] }
  showCoopWindow()
  try {
    if (gamePageReady) await injectCoop() // otherwise did-finish-load injects
  } catch (e) {
    setCoopStatus('开房间失败：' + (e?.message || e), 'bad')
  }
}

function closeCoopRoom() {
  if (!coop) { dialog.showMessageBox(gameWin, { type: 'info', icon, title: '合作模式', message: '现在没有开着的房间。' }); return }
  const choice = dialog.showMessageBoxSync(gameWin, {
    type: 'warning', icon, title: '关闭房间', buttons: ['关闭房间', '取消'], defaultId: 1, cancelId: 1,
    message: `关闭房间 ${coop.room}？`,
    detail: '游戏会回到标题画面，队友会断开。当前这场战斗里还没存档的进度会丢失（每打完一波游戏会自动存档）。',
  })
  if (choice !== 0) return
  const info = coop.win
  coop = null
  if (info && !info.isDestroyed()) info.destroy()
  gameWin.webContents.reload() // a fresh page has none of the injected co-op scripts
}

function showImage(file, title) {
  const win = new BrowserWindow({ title, width: 900, height: 640, icon, autoHideMenuBar: true })
  win.setMenu(null)
  win.loadFile(path.join(packAssets, 'viewer.html'), { query: { img: file } })
}

// Desktop builds from 2024 served the game at http://localhost:8000 and saved under unsuffixed keys
// (data, sessionData, sessionData1…). The current game, offline, reads data_Guest, sessionData_Guest,
// sessionData1_Guest…. Once per install, if this build has no saves yet, copy the 2024 ones over under
// the new names. Nothing is deleted; keys this build already has are never overwritten.
const LEGACY_ORIGIN = 'http://localhost:8000'
let saveCheck = 'not run' // reported by the smoke test
const SAVE_KEY = /^(data|sessionData|runHistoryData)/

function legacyEntries(legacy) {
  const out = []
  for (const [k, v] of Object.entries(legacy)) {
    if (k === 'data_bak') continue
    const slot = /^sessionData(\d*)$/.exec(k)
    out.push([k === 'data' ? 'data_Guest' : slot ? `sessionData${slot[1]}_Guest` : k, v])
  }
  if (!('data' in legacy) && 'data_bak' in legacy) out.push(['data_Guest', legacy.data_bak])
  return out
}

function writeMissing(entries) { // runs in the page
  let n = 0
  for (const [k, v] of entries) if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); n++ }
  return n
}

async function migrateLegacySaves() {
  const flag = path.join(app.getPath('userData'), 'legacy-saves-checked')
  if (existsSync(flag)) { saveCheck = 'already checked'; return }
  const blank = path.join(packAssets, 'blank.html')
  const probe = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  try {
    await probe.loadFile(blank)
    const current = await probe.webContents.executeJavaScript('Object.keys(localStorage)')
    saveCheck = 'this build already has saves'
    if (!current.some(k => SAVE_KEY.test(k))) {
      saveCheck = 'no 2024 saves'
      // Open the old origin without a server: answer every http request with an empty page meanwhile.
      protocol.handle('http', () => new Response('<!doctype html><title>.</title>', { headers: { 'content-type': 'text/html' } }))
      let legacy = {}
      try {
        await probe.loadURL(LEGACY_ORIGIN + '/')
        legacy = await probe.webContents.executeJavaScript('Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))')
      } finally {
        protocol.unhandle('http')
      }
      if (Object.keys(legacy).some(k => SAVE_KEY.test(k))) {
        await probe.loadFile(blank)
        const n = await probe.webContents.executeJavaScript(`(${writeMissing})(${JSON.stringify(legacyEntries(legacy))})`)
        saveCheck = `copied ${n} entries from the 2024 save`
        console.log(`${saveCheck} (${LEGACY_ORIGIN})`)
      }
    }
    writeFileSync(flag, new Date().toISOString())
  } catch (e) {
    saveCheck = 'failed: ' + (e?.message || e)
    console.error('2024 save check failed; will retry next start', e)
    try { writeFileSync(path.join(app.getPath('userData'), 'save-check-error.log'), `${new Date().toISOString()} ${e?.stack || e}\n`) } catch {}
  } finally {
    probe.destroy()
  }
}

function createWindow() {
  if (!skipAbout) dialog.showMessageBoxSync({ type: 'info', icon, title: '关于本游戏', message: ABOUT, buttons: ['确定'] })

  const win = new BrowserWindow({
    show: false, icon, title: 'PokéRogue', backgroundColor: '#484050',
    fullscreenable: true, maximizable: true,
    // backgroundThrottling off: in a co-op room the game must keep running (and streaming to 2P) while this
    // window is behind another one; it can only be chosen here, when the window is created.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  gameWin = win
  win.on('closed', () => {
    if (coop?.win && !coop.win.isDestroyed()) coop.win.destroy()
    coop = null
    gameWin = null
    gamePageReady = false
  })
  win.webContents.on('console-message', e => {
    const msg = String(e.message)
    if (msg.startsWith('COOP')) { onCoopLog(msg); if (dev) console.log(msg) }
  })
  // The page was loaded again (first load with a room pending, or the game reloading itself): the room stays open.
  win.webContents.on('did-start-navigation', e => { if (e.isMainFrame && !e.isSameDocument) gamePageReady = false })
  win.webContents.on('did-finish-load', () => {
    gamePageReady = true
    if (coop) injectCoop().catch(e => setCoopStatus('开房间失败：' + (e?.message || e), 'bad'))
    else if (coopAuto && !win.coopAutoDone) { win.coopAutoDone = true; openCoopRoom(coopAuto) }
  })
  // Links inside the game (wiki, Discord…) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url) }
  })
  win.maximize()
  win.show()
  win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  if (smoke) runSmoke(win)
}

async function runSmoke(win) {
  await new Promise(r => win.webContents.once('did-finish-load', r))
  if (process.env.PRS_SMOKE_COOP) setTimeout(() => openCoopRoom(process.env.PRS_SMOKE_COOP), 8000) // also check co-op loads
  await new Promise(r => setTimeout(r, Number(process.env.PRS_SMOKE_WAIT) || 25000))
  // Read-only: report which save slots exist (names only, never contents).
  const result = await win.webContents.executeJavaScript(`(() => ({
    origin: location.origin || location.protocol, canvas: !!document.querySelector('canvas'),
    saveKeys: Object.keys(localStorage).filter(k => /^(data|sessionData)/.test(k)).sort(),
    otherKeys: Object.keys(localStorage).filter(k => !/^(data|sessionData)/.test(k)).sort(),
  }))()`)
  result.userData = app.getPath('userData')
  result.saveCheck = saveCheck
  if (coop) result.coop = { room: coop.room, status: coop.status, roomWindow: !!(coop.win && !coop.win.isDestroyed() && /coop-room\.html/.test(coop.win.webContents.getURL())),
    hooks: await win.webContents.executeJavaScript('({game:!!window.CoopGame,teams:!!window.PRS_COOP_TEAMS,scene:!!window.PRS_SCENE})') }
  writeFileSync(smoke, (await win.webContents.capturePage()).toPNG())
  writeFileSync(smoke + '.json', JSON.stringify(result)) // Windows GUI builds have no reliable stdout
  console.log('SMOKE ' + JSON.stringify(result))
  app.quit()
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  await migrateLegacySaves()
  createWindow()
  starting = false
})

let starting = true // the hidden save-check window closes before the game window opens
app.on('window-all-closed', () => { if (!isMac && !starting) app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
