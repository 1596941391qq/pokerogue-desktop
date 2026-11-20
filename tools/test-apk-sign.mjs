#!/usr/bin/env node
// 验证 tools/apk.mjs 里手写的 APK v2 签名实现是对的。
//
//   node tools/test-apk-sign.mjs [--shell <上游.apk>]
//
// 两个检查：
//   1) 拿上游官方签过的 APK 反向验证我们的校验器 —— 能验过，说明我们的摘要算法、
//      分块方案、EOCD 改写、结构解析全都和 AOSP apksig 一致；
//   2) 自己造一个小 APK 签一遍再验一遍，确认签名→校验这条链路是通的。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ApkWriter, buildV2Block, buildSigningBlock, computeContentDigest, ensureSigningKey,
  loadKeyMaterial, store, verifyV2,
} from './apk.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SHELL = arg('shell', '/tmp/prs-android-build/shell.apk')
const KEY_DIR = arg('key-dir', path.join(os.homedir(), '.pokerogue-mod-signing'))

let failed = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed++
}

// ---- 1. 反向验证上游官方签名 ----
console.log('[1] 上游官方 APK')
if (fs.existsSync(SHELL)) {
  const v = verifyV2(SHELL)
  check('上游 APK 的 v2 签名能被我们的校验器验证', v.ok, v.reason)
} else {
  console.log('  - 跳过（本地没有上游 APK：' + SHELL + '）')
}

// ---- 2. 自己签一个再验 ----
console.log('[2] 自己签一个小 APK')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sign-test-'))
const bodyPath = path.join(dir, 'body.tmp')
const writer = new ApkWriter(bodyPath, { align: 4 })
writer.addEntry({ name: 'hello.txt', method: 0, modTime: 0, modDate: 0x21, externalAttrs: 0o644 << 16, versionMadeBy: 0x031e },
  store(Buffer.from('hello apk\n')))
writer.addEntry({ name: 'dir/a.bin', method: 0, modTime: 0, modDate: 0x21, externalAttrs: 0o644 << 16, versionMadeBy: 0x031e },
  store(Buffer.from('binary\x00stuff')))
const { cdBytes, eocdBytes, cdOffset } = writer.finish()

const { pemPath, certPath } = ensureSigningKey(KEY_DIR)
const { privateKey, spkiDer, certDer } = loadKeyMaterial(pemPath, certPath)
const section1 = fs.readFileSync(bodyPath).subarray(0, cdOffset)

// 先探一次签名块长度（摘要要写进 EOCD 改写后的偏移）
const probe = buildSigningBlock(buildV2Block({ digest: Buffer.alloc(32), privateKey, certDer, spkiDer }))
const eocdForDigest = Buffer.from(eocdBytes)
eocdForDigest.writeUInt32LE(cdOffset, 16)
const digest = computeContentDigest([section1, cdBytes, eocdForDigest])
const block = buildSigningBlock(buildV2Block({ digest, privateKey, certDer, spkiDer }))
check('签名块长度稳定', block.length === probe.length, block.length + ' 字节')

const out = path.join(dir, 'test.apk')
const eocd = Buffer.from(eocdBytes)
eocd.writeUInt32LE(cdOffset + block.length, 16)
fs.writeFileSync(out, Buffer.concat([section1, block, cdBytes, eocd]))

const v = verifyV2(out)
check('自己签的 APK 能通过自己的校验器', v.ok, v.reason)

// 内容被改一个字节，签名必须失效
const bytes = fs.readFileSync(out)
bytes[10] = bytes[10] ^ 0xff
const tampered = path.join(dir, 'tampered.apk')
fs.writeFileSync(tampered, bytes)
const v2 = verifyV2(tampered)
check('改一个字节后签名失效', !v2.ok, v2.reason)

fs.rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n有 ${failed} 项没过` : '\n全部通过')
process.exitCode = failed ? 1 : 0
