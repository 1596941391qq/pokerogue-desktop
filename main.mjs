import { app, BrowserWindow, dialog, Menu, nativeImage, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'
const smoke = process.env.PRS_SMOKE // dev check: render, test saves, write a screenshot, quit

// Saves live in this app's localStorage (file:// origin) inside %APPDATA%\pokemon-rogue-battle
// (~/Library/Application Support/pokemon-rogue-battle on Mac). Every earlier desktop release used
// that folder: never rename it, or players who upgrade will not see their saves.
const DATA_DIR_NAME = 'pokemon-rogue-battle'
app.setName(DATA_DIR_NAME)
// PRS_DATA_DIR only applies to smoke tests, so a test can run against a copy of real saves.
app.setPath('userData', (smoke && process.env.PRS_DATA_DIR) || path.join(app.getPath('appData'), DATA_DIR_NAME))

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

// Windows keeps the old one-click top-level items; macOS needs submenus plus the standard app/edit menus.
const template = isMac
  ? [{ role: 'appMenu' }, { role: 'editMenu' }, { label: '帮助', submenu: helpItems }, { role: 'windowMenu' }]
  : helpItems

function showImage(file, title) {
  const win = new BrowserWindow({ title, width: 900, height: 640, icon, autoHideMenuBar: true })
  win.setMenu(null)
  win.loadFile(path.join(packAssets, 'viewer.html'), { query: { img: file } })
}

function createWindow() {
  if (!smoke) dialog.showMessageBoxSync({ type: 'info', icon, title: '关于本游戏', message: ABOUT, buttons: ['确定'] })

  const win = new BrowserWindow({
    show: false, icon, title: 'PokéRogue', backgroundColor: '#484050',
    fullscreenable: true, maximizable: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
  await new Promise(r => setTimeout(r, 25000))
  // Read-only: report which save slots exist (names only, never contents).
  const result = await win.webContents.executeJavaScript(`(() => ({
    origin: location.origin || location.protocol, canvas: !!document.querySelector('canvas'),
    saveKeys: Object.keys(localStorage).filter(k => /^(data|sessionData)/.test(k)).sort(),
  }))()`)
  result.userData = app.getPath('userData')
  writeFileSync(smoke, (await win.webContents.capturePage()).toPNG())
  console.log('SMOKE ' + JSON.stringify(result))
  app.quit()
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  createWindow()
})

app.on('window-all-closed', () => { if (!isMac) app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
