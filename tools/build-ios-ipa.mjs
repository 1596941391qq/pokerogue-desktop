#!/usr/bin/env node
// 打一个 iOS 的 ipa（未签名，给 AltStore / Sideloadly / TrollStore 自己签）。
//
// 为什么不是 xcodebuild：本机没装 Xcode（只有 Command Line Tools），iOS 的壳编不出来。
// 所以这里用上游已经编好的那个壳（ios/PokeRogue.xcodeproj 的产物，官方 Release 里的 ipa），
// 把里面的 web/ 换成我们这份（游戏 1.12.2.8 + 合作脚本 + 本地 mod），再重签一次。
// 壳本身是 Swift 写的 WKWebView 包装器：只负责把 web/ 目录用 pokerogue://localhost/ 协议喂给
// WebView（见上游 ios/PokeRogue/BundleSchemeHandler.swift），不碰游戏逻辑，所以换掉 web/ 就是换游戏。
//
//   node tools/build-ios-ipa.mjs --shell <上游.ipa> [--out <输出.ipa>]
//
// 需要联网下上游那个 ipa（500MB 左右）；有 Clash 的话加 --proxy http://127.0.0.1:7897 会快很多。
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { Readable } from 'node:stream'
import { ProxyAgent } from 'undici'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }
const has = name => argv.includes(name)

// 上游那个手机版仓库的 Release：壳（Swift 二进制 + Info.plist + 图标）和我们的 web 包来自同一个 commit
const SHELL_URL = arg('shell-url', 'https://github.com/1596941391qq/pokerogue-ios-android/releases/download/pokerogue20261118/prs261118-ios.ipa')
const OUT = path.resolve(arg('out', path.join(ROOT, 'release', 'prs1.12.2.8-ios.ipa')))
// 已下好的上游 ipa 直接用，省得再下一遍 500MB

const WORK = path.resolve(arg('work', '/tmp/prs-ios-build'))
const PROXY = arg('proxy', '')

const APP = 'Payload/PokeRogue.app'
// 壳里除了 web/ 就是这些：Swift 可执行文件、Info.plist、图标、Assets.car、签名文件
const SHELL_KEEP = ['PokeRogue', 'Info.plist', 'PkgInfo', 'Assets.car', 'AppIcon60x60@2x.png', 'AppIcon76x76@2x~ipad.png']

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const log = m => console.log('[ios] ' + m)

// ---- 1. 上游的 ipa：只有壳要留，web/ 用我们自己的 ----
async function fetchShell() {
  const ipa = arg('shell', path.join(WORK, 'shell.ipa'))
  mkdirSync(WORK, { recursive: true })
  if (existsSync(ipa) && statSync(ipa).size > 50 * 1024 * 1024) { log('上游 ipa 已在本地：' + ipa); return ipa }
  log('下载上游 ipa（壳）：' + SHELL_URL)
  const res = await fetch(SHELL_URL, {
    redirect: 'follow',
    dispatcher: PROXY ? new ProxyAgent(PROXY) : undefined,
  })
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ipa))
  log('下好了：' + ipa)
  return ipa
}

// ---- 2. 解出壳，扔掉里面的 web/ ----
function extractShell(ipa) {
  const stage = path.join(WORK, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  log('解出壳')
  run('unzip', ['-q', '-o', ipa, '-d', stage,
    ...SHELL_KEEP.map(f => APP + '/' + f),
    APP + '/_CodeSignature/CodeResources'])
  return stage
}

// ---- 3. 把我们的 web 包放进壳里 ----
function putWeb(stage) {
  const webSrc = path.join(ROOT, 'dist')
  if (!existsSync(path.join(webSrc, 'index.html'))) throw new Error('dist/ 里没有 index.html，先跑 scripts/fetch-game.sh')
  const webDst = path.join(stage, APP, 'web')
  rmSync(webDst, { recursive: true, force: true })
  mkdirSync(webDst, { recursive: true })
  log('拷入 web 包（游戏 ' + readVersion() + '）')
  cpSync(webSrc, webDst, { recursive: true })

  // 合作脚本：游戏包 dist/coop/ 里已经有一套（引擎 host-mods.js + 上游的 mod 包 mods-bundle.js），
  // 手机版的 mobile.js 会按需再加载它们。
  // 我们的引擎扩展和本地 mod 包只在这个仓库里有，要单独放进去。
  const coopDst = path.join(webDst, 'coop')
  mkdirSync(coopDst, { recursive: true })
  for (const f of ['ext-trainer-growth.js', 'mods-local.js']) {
    const src = path.join(ROOT, 'coop', f)
    if (!existsSync(src)) throw new Error('缺少 ' + src + '（先跑 npm run build:mods）')
    cpSync(src, path.join(coopDst, f))
  }
  log('放入 ext-trainer-growth.js + mods-local.js')

  // index.html：把这两个文件按顺序接在 host-mods.js 后面（引擎要先起来，扩展和 mod 包随后）。
  // defer 的 script 按出现顺序执行，所以接在后面就行。
  // 手机版原本不直接加载引擎（靠 mobile.js 的 openMods() 按需加载），我们这份 index.html 已经
  // 改成直接加载引擎和上游 mod 包（接口 v3，单人模式也能跑 mod），正好省一次按需加载。
  const htmlPath = path.join(webDst, 'index.html')
  let html = readFileSync(htmlPath, 'utf8')
  const anchor = '<script defer src="./coop/host-mods.js"></script>'
  if (!html.includes(anchor)) throw new Error('index.html 里找不到 host-mods.js 那行，注入点变了')
  if (html.includes('ext-trainer-growth.js')) { log('index.html 里已经有我们的脚本了，跳过注入'); return }
  html = html.replace(anchor, anchor +
    '<script defer src="./coop/ext-trainer-growth.js"></script>' +
    '<script defer src="./coop/mods-local.js"></script>')
  writeFileSync(htmlPath, html)
  log('index.html：已注入扩展和本地 mod')
}

function readVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'game-version.json'), 'utf8')).pokerogueVersion } catch { return '?' }
}

// ---- 4. 重签并打成 ipa ----
function signAndPack(stage) {
  const app = path.join(stage, APP)
  // 换了 web/ 之后原来的签名就失效了，重新签一次（ad-hoc，和上游 build-ipa.sh 一样）。
  // Sideloadly / AltStore 会用自己的证书再签一遍；TrollStore 直接用这个也行。
  log('重签（ad-hoc）')
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', app])

  const ipa = path.join(WORK, 'out.ipa')
  rmSync(ipa, { force: true })
  log('打包 ipa')
  run('zip', ['-qry', ipa, 'Payload'], { cwd: stage })
  mkdirSync(path.dirname(OUT), { recursive: true })
  rmSync(OUT, { force: true })
  cpSync(ipa, OUT)
  const mb = (statSync(OUT).size / 1048576).toFixed(1)
  log('好了：' + OUT + '（' + mb + 'MB）')
}

const ipa = await fetchShell()
const stage = extractShell(ipa)
putWeb(stage)
signAndPack(stage)
log('装法：Sideloadly / AltStore 拖进去用自己的 Apple ID 签；TrollStore 直接装')
