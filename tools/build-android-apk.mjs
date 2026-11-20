#!/usr/bin/env node
// 打一个安卓 APK（自带 v2 签名，装上就能用）。
//
// 和 iOS 那套一个思路：上游已经编好的安卓壳（app/src/main/assets/web 就是游戏 web 包，
// 由壳里的 NanoHTTPD 用 http://localhost:6868 伺服），我们把 assets/web 换成自己的
// （游戏 + 合作脚本 + 本地 mod），再重签一次。壳不碰游戏逻辑，所以换掉 assets/web 就是换游戏。
//
//   node tools/build-android-apk.mjs [--shell <上游.apk>] [--out <输出.apk>] [--proxy <代理>]
//
// 本机没有 JDK/apksigner，所以 v2 签名是 tools/apk.mjs 手写的（证书用系统 openssl 生成）。
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ApkWriter, readCentralDirectory, readEntryRaw, computeContentDigest, buildV2Block,
  buildSigningBlock, ensureSigningKey, loadKeyMaterial, verifyV2, deflate, store,
} from './apk.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }

const SHELL_URL = arg('shell-url', 'https://github.com/1596941391qq/pokerogue-ios-android/releases/download/pokerogue20261118/prs261118-android.apk')
const SHELL_SIZE = Number(arg('shell-size', '561452091'))
const WORK = path.resolve(arg('work', '/tmp/prs-android-build'))
const SHELL = path.resolve(arg('shell', path.join(WORK, 'shell.apk')))
const OUT = path.resolve(arg('out', path.join(ROOT, 'release', 'prs1.12.2.8-android.apk')))
const KEY_DIR = path.resolve(arg('key-dir', path.join(process.env.HOME || '/tmp', '.pokerogue-mod-signing')))
const PROXY = arg('proxy', process.env.HTTPS_PROXY || '')

const WEB_PREFIX = 'assets/web/'
const log = m => console.log('[apk] ' + m)

// 已经压过的格式，再 deflate 也压不动，直接 store 更快
const INCOMPRESSIBLE = /\.(png|jpe?g|gif|webp|ico|mp3|m4a|ogg|wav|mp4|webm|woff2?|ttf|otf|pak|bin|dat|zip)$/i
// v1(JAR) 签名的文件：内容变了必须去掉，不然系统会拿旧的 v1 签名去校验
const V1_SIG = /^META-INF\/(MANIFEST\.MF|.*\.(SF|RSA|DSA|EC))$/i

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31)
  const dt = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
  return { time, date: dt }
}

// ---- 1. 上游安卓壳（没有就分 8 段并行下一份）----
async function fetchShell() {
  if (fs.existsSync(SHELL) && fs.statSync(SHELL).size === SHELL_SIZE) {
    log('上游 apk 已在本地：' + SHELL)
    return SHELL
  }
  fs.mkdirSync(WORK, { recursive: true })
  log('下载上游安卓壳（' + SHELL_URL + '）')
  const proxy = PROXY ? ['-x', PROXY] : []
  const n = 8
  const chunk = Math.ceil(SHELL_SIZE / n)
  const parts = []
  for (let i = 0; i < n; i++) {
    const start = i * chunk
    const end = Math.min(start + chunk - 1, SHELL_SIZE - 1)
    parts.push({ part: path.join(WORK, `part.${String(i).padStart(2, '0')}`), start, end })
  }
  await Promise.all(parts.map(({ part, start, end }) => new Promise((resolve, reject) => {
    const child = spawn('curl', ['-sL', '--retry', '8', '--retry-delay', '2', '--retry-all-errors',
      ...proxy, '-r', `${start}-${end}`, '-o', part, SHELL_URL], { stdio: 'ignore' })
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('curl 退出码 ' + code)))
    child.on('error', reject)
  })))
  log('分段下载完成，合并')
  const out = fs.openSync(SHELL, 'w')
  for (const { part } of parts) {
    fs.writeSync(out, fs.readFileSync(part))
    fs.unlinkSync(part)
  }
  fs.closeSync(out)
  return SHELL
}

// ---- 2. 准备 web 包（注入我们的脚本）----
function stageWeb() {
  const src = path.join(ROOT, 'dist')
  if (!fs.existsSync(path.join(src, 'index.html'))) throw new Error('dist/ 里没有 index.html')
  const dst = path.join(WORK, 'web')
  fs.rmSync(dst, { recursive: true, force: true })
  fs.mkdirSync(dst, { recursive: true })
  execFileSync('rsync', ['-a', '--delete', src + '/', dst + '/'])

  // 引擎扩展 + 本地 mod 包：这两个只有本仓库有，要单独塞进去
  const coopDst = path.join(dst, 'coop')
  fs.mkdirSync(coopDst, { recursive: true })
  for (const f of ['ext-trainer-growth.js', 'mods-local.js']) {
    const p = path.join(ROOT, 'coop', f)
    if (!fs.existsSync(p)) throw new Error('缺少 ' + p + '（先跑 npm run build:mods）')
    fs.copyFileSync(p, path.join(coopDst, f))
  }

  const htmlPath = path.join(dst, 'index.html')
  let html = fs.readFileSync(htmlPath, 'utf8')
  const anchor = '<script defer src="./coop/host-mods.js"></script>'
  if (!html.includes(anchor)) throw new Error('index.html 里找不到 host-mods.js 那行，注入点变了')
  if (!html.includes('ext-trainer-growth.js')) {
    html = html.replace(anchor, anchor +
      '<script defer src="./coop/ext-trainer-growth.js"></script>' +
      '<script defer src="./coop/mods-local.js"></script>')
    fs.writeFileSync(htmlPath, html)
  }
  log('web 包就绪（含 ext-trainer-growth.js + mods-local.js）')
  return dst
}

// ---- 3. 重写 apk ----
function rebuild(shell, webDir) {
  const cd = readCentralDirectory(shell)
  log('上游 apk：' + cd.entries.length + ' 个条目')

  // 未压缩的文件要对齐：resources.arsc 要 4 字节（系统会 mmap 它），.so 要 16K（Android 15+）
  const alignOf = name => {
    if (/\.so$/.test(name)) return 16384
    if (name === 'resources.arsc') return 4
    return 1
  }

  const bodyPath = path.join(WORK, 'body.tmp')
  const writer = new ApkWriter(bodyPath, { align: 1 })
  let kept = 0

  // 3.1 原样保留非 web 部分的条目（壳、resources、dex……）
  for (const entry of cd.entries) {
    if (entry.name.startsWith(WEB_PREFIX)) continue
    if (V1_SIG.test(entry.name)) { log('  去掉失效的 v1 签名：' + entry.name); continue }
    const { raw } = readEntryRaw(shell, entry)
    writer.addEntry({
      name: entry.name, method: entry.method, modTime: entry.modTime, modDate: entry.modDate,
      externalAttrs: entry.externalAttrs, versionMadeBy: entry.versionMadeBy,
    }, { raw, crc: entry.crc, csize: entry.csize, size: entry.size }, alignOf(entry.name))
    kept++
  }

  // 3.2 web 部分换成我们自己的
  const walk = dir => {
    const out = []
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const st = fs.lstatSync(p)
      if (st.isDirectory()) out.push(...walk(p))
      else if (st.isFile()) out.push({ path: p, rel: path.relative(webDir, p).split(path.sep).join('/') })
    }
    return out
  }
  const files = walk(webDir)
  log('web 条目 ' + files.length + ' 个，开始写入')
  let done = 0
  for (const f of files) {
    const buf = fs.readFileSync(f.path)
    let method = 8
    let payload = INCOMPRESSIBLE.test(f.rel) ? store(buf) : deflate(buf)
    if (payload.csize >= payload.size) { method = 0; payload = store(buf) }
    const { time, date } = dosDateTime(fs.statSync(f.path).mtime)
    writer.addEntry({
      name: WEB_PREFIX + f.rel, method, modTime: time, modDate: date,
      externalAttrs: (0o100644 << 16) >>> 0, versionMadeBy: 0x031e,
    }, payload, 1)
    done++
    if (done % 10000 === 0) log('  已写 ' + done + '/' + files.length)
  }

  const { cdBytes, eocdBytes, cdOffset } = writer.finish()
  log('条目写完：保留 ' + kept + '，替换 ' + done)
  return { bodyPath, cdBytes, eocdBytes, cdOffset }
}

// ---- 4. 签名并拼成最终 apk ----
function signAndAssemble(body, keyDir) {
  const { bodyPath, cdBytes, eocdBytes, cdOffset } = body
  // 只取 ZIP 条目部分（body 文件里还有中央目录和 EOCD，但它们要单独处理）
  const section1 = (() => {
    const fd = fs.openSync(bodyPath, 'r')
    try {
      const buf = Buffer.alloc(cdOffset)
      fs.readSync(fd, buf, 0, cdOffset, 0)
      return buf
    } finally { fs.closeSync(fd) }
  })()

  // 签名块要塞在条目和中央目录之间：
  //   第 1 段 = ZIP 条目，第 2 段 = 中央目录，第 3 段 = EOCD
  // 算摘要时，EOCD 里的「中央目录偏移」要改写成签名块偏移（系统就是这么验的）
  const { pemPath, certPath, reused } = ensureSigningKey(keyDir)
  log('签名密钥：' + pemPath + (reused ? '（复用）' : '（新建）'))
  const { privateKey, spkiDer, certDer } = loadKeyMaterial(pemPath, certPath)

  // 签名块长度只跟证书/密钥有关，先用空摘要探一次长度
  const probeBlock = buildSigningBlock(buildV2Block({ digest: Buffer.alloc(32), privateKey, certDer, spkiDer }))
  const signingBlockOffset = cdOffset
  const blockLength = probeBlock.length

  // 算摘要用的 EOCD：「中央目录偏移」写成签名块偏移
  const eocdForDigest = Buffer.from(eocdBytes)
  eocdForDigest.writeUInt32LE(signingBlockOffset, 16)
  const digest = computeContentDigest([section1, cdBytes, eocdForDigest])

  const block = buildSigningBlock(buildV2Block({ digest, privateKey, certDer, spkiDer }))
  if (block.length !== blockLength) throw new Error('签名块长度不一致')

  // 写进文件的 EOCD：「中央目录偏移」指向真正的中央目录（在签名块之后）
  const finalEocd = Buffer.from(eocdBytes)
  finalEocd.writeUInt32LE(signingBlockOffset + blockLength, 16)

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.rmSync(OUT, { force: true })
  const out = fs.openSync(OUT, 'w')
  fs.writeSync(out, section1)
  fs.writeSync(out, block)
  fs.writeSync(out, cdBytes)
  fs.writeSync(out, finalEocd)
  fs.closeSync(out)
  fs.rmSync(bodyPath, { force: true })
  return OUT
}

const shell = await fetchShell()
const webDir = stageWeb()
const body = rebuild(shell, webDir)
const out = signAndAssemble(body, KEY_DIR)

// ---- 5. 自检 ----
const v = verifyV2(out)
log('签名自检：' + (v.ok ? '通过' : '失败 ' + v.reason))
if (!v.ok) process.exitCode = 1
const mb = (fs.statSync(out).size / 1048576).toFixed(1)
log('好了：' + out + '（' + mb + 'MB）')
