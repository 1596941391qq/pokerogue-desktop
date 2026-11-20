// APK 读写 + 签名工具（纯 Node，不依赖 JDK / Android SDK）。
//
// 为什么自己写：
//   本机没装 JDK，也没有 apksigner / zipalign（brew 也没有），而打安卓包必须重签名
//   （换掉 assets/web 以后上游的签名就失效了）。所以这里按 APK Signature Scheme v2
//   的规范手写签名块：证书用系统自带的 openssl 生成，RSA 签名用 Node crypto。
//
// 规范细节全部对着上游官方签过的 APK 反推 + 用 AOSP apksig 源码核对过：
//   - APK Signing Block 夹在「ZIP 条目」和「中央目录」之间，尾部是 magic "APK Sig Block 42"
//   - 内容摘要：每段按 1MiB 切块，块摘要 = SHA256(0xa5 || 块长LE32 || 块内容)，
//     最终摘要 = SHA256(0x5a || 块数LE32 || 拼接所有块摘要)
//   - 参与摘要的三段：签名块之前的 ZIP 条目、中央目录、EOCD
//     （EOCD 里的「中央目录偏移」要改写成签名块偏移再算摘要）
//   - 签名内容 = signed data 本身（不含 magic、不含长度前缀）
//   - 结构：signed data = 摘要序列 + 证书序列 + 附加属性 + 空占位；signer = 签名数据 + 签名序列 + 公钥
//   - 签名算法 id 0x0103 = RSASSA-PKCS1-v1_5 + SHA2-256

import { createHash, createSign, generateKeyPairSync, createPublicKey, createPrivateKey, verify as cryptoVerify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import zlib from 'node:zlib'

export const SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'ascii')
export const APK_SIG_BLOCK_V2_ID = 0x7109871a

const SIG_ALG_RSA_PKCS1_SHA256 = 0x0103

const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

// ---------------------------------------------------------------- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// ------------------------------------------------------------- 读取 ZIP ----
export function readCentralDirectory(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const fileSize = fs.fstatSync(fd).size
    const tailLen = Math.min(fileSize, 65557 + 20)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen)

    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('没找到 EOCD（不是合法的 zip/apk）')

    let total = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    const commentLen = tail.readUInt16LE(eocd + 20)
    const eocdOffset = fileSize - tailLen + eocd
    const eocdBytes = tail.slice(eocd, eocd + 22 + commentLen)

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locOff = eocd - 20
      if (locOff < 0 || tail.readUInt32LE(locOff) !== ZIP64_EOCD_LOCATOR_SIG) {
        throw new Error('需要 zip64，但没找到 Zip64 EOCD locator')
      }
      const z64Off = Number(tail.readBigUInt64LE(locOff + 8))
      const z64 = Buffer.alloc(56)
      fs.readSync(fd, z64, 0, 56, z64Off)
      if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error('Zip64 EOCD 签名不对')
      total = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }

    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOffset)

    const entries = []
    let p = 0
    for (let i = 0; i < total; i++) {
      if (cd.readUInt32LE(p) !== CD_SIG) throw new Error('中央目录项签名不对 @' + p)
      const versionMadeBy = cd.readUInt16LE(p + 4)
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const modTime = cd.readUInt16LE(p + 12)
      const modDate = cd.readUInt16LE(p + 14)
      let crc = cd.readUInt32LE(p + 16)
      let csize = cd.readUInt32LE(p + 20)
      let size = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen2 = cd.readUInt16LE(p + 32)
      const externalAttrs = cd.readUInt32LE(p + 38)
      let localOffset = cd.readUInt32LE(p + 42)
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8')

      let ep = p + 46 + nameLen
      const extraEnd = ep + extraLen
      while (ep + 4 <= extraEnd) {
        const hid = cd.readUInt16LE(ep)
        const hsz = cd.readUInt16LE(ep + 2)
        if (hid === 0x0001) {
          let q = ep + 4
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8 }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8 }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8 }
        }
        ep += 4 + hsz
      }

      entries.push({ name, method, flags, modTime, modDate, crc, csize, size, localOffset, externalAttrs, versionMadeBy })
      p += 46 + nameLen + extraLen + commentLen2
    }
    return { entries, cdOffset, cdSize, eocdOffset, eocdBytes, fileSize }
  } finally {
    fs.closeSync(fd)
  }
}

// 读一个条目的原始（已压缩）数据和它在文件里的真实起点
export function readEntryRaw(filePath, entry) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const lfh = Buffer.alloc(30)
    fs.readSync(fd, lfh, 0, 30, entry.localOffset)
    if (lfh.readUInt32LE(0) !== LFH_SIG) throw new Error('本地文件头签名不对：' + entry.name)
    const nameLen = lfh.readUInt16LE(26)
    const extraLen = lfh.readUInt16LE(28)
    const dataStart = entry.localOffset + 30 + nameLen + extraLen
    const raw = Buffer.alloc(entry.csize)
    fs.readSync(fd, raw, 0, entry.csize, dataStart)
    return { raw, dataStart }
  } finally {
    fs.closeSync(fd)
  }
}

export function readRange(filePath, start, len) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return buf
  } finally { fs.closeSync(fd) }
}

// ----------------------------------------------------------- 写 ZIP（APK）----
export class ApkWriter {
  constructor(outPath, { align = 4 } = {}) {
    this.outPath = outPath
    this.align = align
    this.fd = fs.openSync(outPath, 'w')
    this.offset = 0
    this.entries = []
  }

  _write(buf) {
    fs.writeSync(this.fd, buf)
    this.offset += buf.length
  }

  // data: { raw, crc, csize, size }；method 0 = 原样保留上游的压缩字节
  addEntry(meta, data, align) {
    const { name, method, modTime, modDate, externalAttrs, versionMadeBy } = meta
    const nameBuf = Buffer.from(name, 'utf8')
    const localOffset = this.offset

    // 未压缩的条目按需给本地文件头补填充，保证数据落在对齐边界上
    let extraLen = 0
    const a = align ?? this.align
    if (method === 0 && a > 1) {
      const dataStart = this.offset + 30 + nameBuf.length
      extraLen = (a - (dataStart % a)) % a
    }
    const extra = Buffer.alloc(extraLen)

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(LFH_SIG, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(modTime, 10)
    lfh.writeUInt16LE(modDate, 12)
    lfh.writeUInt32LE(data.crc, 14)
    lfh.writeUInt32LE(data.csize, 18)
    lfh.writeUInt32LE(data.size, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(extra.length, 28)

    this._write(lfh)
    this._write(nameBuf)
    if (extra.length) this._write(extra)
    this._write(data.raw)

    this.entries.push({ name, method, modTime, modDate, crc: data.crc, csize: data.csize, size: data.size, externalAttrs, versionMadeBy, localOffset })
  }

  // 写中央目录 + EOCD，返回 { cdBytes, eocdBytes, cdOffset }
  finish() {
    const cdOffset = this.offset
    const cdParts = []
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(CD_SIG, 0)
      cd.writeUInt16LE(e.versionMadeBy ?? 0x031e, 4)
      cd.writeUInt16LE(20, 6)
      cd.writeUInt16LE(0, 8)
      cd.writeUInt16LE(e.method, 10)
      cd.writeUInt16LE(e.modTime, 12)
      cd.writeUInt16LE(e.modDate, 14)
      cd.writeUInt32LE(e.crc, 16)
      cd.writeUInt32LE(e.csize, 20)
      cd.writeUInt32LE(e.size, 24)
      cd.writeUInt16LE(nameBuf.length, 28)
      cd.writeUInt16LE(0, 30)
      cd.writeUInt16LE(0, 32)
      cd.writeUInt16LE(0, 34)
      cd.writeUInt16LE(0, 36)
      cd.writeUInt32LE(e.externalAttrs >>> 0, 38)
      cd.writeUInt32LE(e.localOffset >>> 0, 42)
      cdParts.push(cd, nameBuf)
    }
    const cdBytes = Buffer.concat(cdParts)

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIG, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(cdBytes.length, 12)
    eocd.writeUInt32LE(cdOffset, 16)
    eocd.writeUInt16LE(0, 20)

    this._write(cdBytes)
    this._write(eocd)
    fs.closeSync(this.fd)
    return { cdBytes, eocdBytes: eocd, cdOffset, entriesLength: this.entries.length }
  }
}

// ------------------------------------------------------------ 摘要 / 签名 ----
// 内容摘要（AOSP 的 1MiB 分块方案）：
//   1. 每一段各自按 1MiB 切块；
//   2. 块摘要 = SHA256(0xa5 || 块长度LE32 || 块内容)；
//   3. 最终摘要 = SHA256(0x5a || 块总数LE32 || 拼接所有块摘要)
export function computeContentDigest(sections) {
  const CHUNK = 1024 * 1024
  const chunkDigests = []
  for (const section of sections) {
    let pos = 0
    while (pos < section.length) {
      const size = Math.min(CHUNK, section.length - pos)
      const prefix = Buffer.alloc(5)
      prefix[0] = 0xa5
      prefix.writeUInt32LE(size, 1)
      const h = createHash('sha256')
      h.update(prefix)
      h.update(section.slice(pos, pos + size))
      chunkDigests.push(h.digest())
      pos += size
    }
  }
  const prefix = Buffer.alloc(5)
  prefix[0] = 0x5a
  prefix.writeUInt32LE(chunkDigests.length, 1)
  const top = createHash('sha256')
  top.update(prefix)
  for (const d of chunkDigests) top.update(d)
  return top.digest()
}

// ---- 长度前缀小工具 ----
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}
function lp(buf) { return Buffer.concat([u32(buf.length), buf]) }
function lpSeq(elements) { return Buffer.concat(elements.map(e => lp(e))) }
// 「int + 长度前缀字节」对（摘要项、签名项）
function lpPairs(pairs) {
  return Buffer.concat(pairs.map(([id, value]) => lp(Buffer.concat([u32(id), lp(value)]))))
}

// 构造 v2 签名块内容并签名
export function buildV2Block({ digest, privateKey, certDer, spkiDer }) {
  // signed data = 摘要序列 + 证书序列 + 附加属性 + 空占位
  const digestsSeq = lpPairs([[SIG_ALG_RSA_PKCS1_SHA256, digest]])
  const certsSeq = lpSeq([certDer])
  const signedData = lpSeq([digestsSeq, certsSeq, Buffer.alloc(0), Buffer.alloc(0)])

  // 签名内容就是 signed data 本身
  const signer = createSign('sha256')
  signer.update(signedData)
  const signature = signer.sign(privateKey)
  const sigsSeq = lpPairs([[SIG_ALG_RSA_PKCS1_SHA256, signature]])

  // signer = 签名数据 + 签名序列 + 公钥
  const signerContent = lpSeq([signedData, sigsSeq, spkiDer])
  // v2 块 = 长度前缀的 signer 序列：[序列总长][signer 长度][signer]
  return lp(lpSeq([signerContent]))
}

// 组装整个 APK Signing Block：[size(8)][id-value 对...][size(8)][magic]
export function buildSigningBlock(v2Block) {
  const pairLen = Buffer.alloc(8)
  pairLen.writeBigUInt64LE(BigInt(v2Block.length + 4), 0)
  const id = Buffer.alloc(4)
  id.writeUInt32LE(APK_SIG_BLOCK_V2_ID, 0)
  const body = Buffer.concat([pairLen, id, v2Block])
  const size = Buffer.alloc(8)
  size.writeBigUInt64LE(BigInt(body.length + 8 + 16), 0)
  return Buffer.concat([size, body, size, SIG_BLOCK_MAGIC])
}

// 在 apk 文件里定位签名块（返回 { block, offset }）
export function locateSigningBlock(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const fileSize = fs.fstatSync(fd).size
    const tailLen = Math.min(fileSize, 65557)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen)

    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('没找到 EOCD')
    const eocdOffset = fileSize - tailLen + eocd
    let cdOffset = tail.readUInt32LE(eocd + 16)
    let cdSize = tail.readUInt32LE(eocd + 12)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      const locOff = eocd - 20
      const z64Off = Number(tail.readBigUInt64LE(locOff + 8))
      const z64 = Buffer.alloc(56)
      fs.readSync(fd, z64, 0, 56, z64Off)
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }
    // 签名块紧挨在中央目录前面，尾部是 8 字节 size + 16 字节 magic
    const magicAt = cdOffset - 16
    const magic = Buffer.alloc(16)
    fs.readSync(fd, magic, 0, 16, magicAt)
    if (!magic.equals(SIG_BLOCK_MAGIC)) return { block: null, offset: -1 }
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, magicAt - 8)
    const blockSize = Number(sizeBuf.readBigUInt64LE(0))
    // size 字段的值 = 整块长度 - 8（不含它自己）
    const blockStart = cdOffset - blockSize - 8
    const block = Buffer.alloc(blockSize + 8)
    fs.readSync(fd, block, 0, blockSize + 8, blockStart)
    return { block, offset: blockStart }
  } finally {
    fs.closeSync(fd)
  }
}

// ------------------------------------------------------------ 证书 / 密钥 ----
export function ensureSigningKey(keyDir) {
  fs.mkdirSync(keyDir, { recursive: true })
  const pemPath = keyDir + '/signing-key.pem'
  const certPath = keyDir + '/signing-cert.pem'
  if (fs.existsSync(pemPath) && fs.existsSync(certPath)) {
    return { pemPath, certPath, reused: true }
  }
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  fs.writeFileSync(pemPath, privateKey, { mode: 0o600 })
  execFileSync('openssl', ['req', '-x509', '-new', '-key', pemPath, '-out', certPath,
    '-days', '36500', '-subj', '/CN=PokeRogue Trainer Growth Mod'])
  return { pemPath, certPath, reused: false }
}

export function loadKeyMaterial(pemPath, certPath) {
  const privateKey = createPrivateKey(fs.readFileSync(pemPath))
  const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const certDer = execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'DER'], { maxBuffer: 1 << 24 })
  return { privateKey, spkiDer, certDer }
}

// -------------------------------------------------------------- 验证签名 ----
// 重新算内容摘要 + 验 RSA 签名，确认这个 APK 装到手机上能被系统认出来
export function verifyV2(filePath) {
  const { block, offset } = locateSigningBlock(filePath)
  if (!block) return { ok: false, reason: '没有 APK Signing Block（只有 v1 / 未签名）' }
  const v2 = findV2Block(block)
  if (!v2) return { ok: false, reason: '签名块里没有 v2' }

  const { cdOffset, eocdOffset, eocdBytes } = readCentralDirectory(filePath)
  const section1 = readRange(filePath, 0, offset)
  const section2 = readRange(filePath, cdOffset, eocdOffset - cdOffset)
  // EOCD 里的「中央目录偏移」在算摘要时要换成签名块偏移
  const eocd = Buffer.from(eocdBytes)
  eocd.writeUInt32LE(offset, 16)
  const computedDigest = computeContentDigest([section1, section2, eocd])

  const results = []
  for (const signer of parseV2Signers(v2)) {
    const storedDigest = signer.digests.get(SIG_ALG_RSA_PKCS1_SHA256)
    const digestMatch = !!storedDigest && storedDigest.equals(computedDigest)

    const pubKey = createPublicKey({ key: signer.spki, format: 'der', type: 'spki' })
    let sigOk = false
    for (const [alg, sig] of signer.signatures) {
      if (alg === SIG_ALG_RSA_PKCS1_SHA256) {
        sigOk = cryptoVerify('sha256', signer.signedData, pubKey, sig)
      }
    }
    results.push({ digestMatch, sigOk })
  }
  const ok = results.length > 0 && results.every(r => r.digestMatch && r.sigOk)
  return { ok, reason: ok ? 'v2 签名有效' : 'v2 签名校验失败', results }
}

// 解析 v2 块里的 signer
export function parseV2Signers(v2) {
  const out = []
  let p = 4
  const signersLen = v2.readUInt32LE(0)
  const signersEnd = 4 + signersLen
  while (p < signersEnd) {
    const len = v2.readUInt32LE(p); p += 4
    const signer = v2.slice(p, p + len); p += len
    out.push(parseSigner(signer))
  }
  return out
}

function parseSigner(signer) {
  let q = 0
  const sdLen = signer.readUInt32LE(q); q += 4
  const signedData = signer.slice(q, q + sdLen); q += sdLen
  const sigsLen = signer.readUInt32LE(q); q += 4
  const sigsSeq = signer.slice(q, q + sigsLen); q += sigsLen
  const pubLen = signer.readUInt32LE(q); q += 4
  const spki = signer.slice(q, q + pubLen)

  // signed data = 摘要序列 + 证书序列 + 附加属性 + 空占位
  let r = 0
  const digestsLen = signedData.readUInt32LE(r); r += 4
  const digestsSeq = signedData.slice(r, r + digestsLen); r += digestsLen

  const digests = new Map()
  let d = 0
  while (d < digestsSeq.length) {
    const itemLen = digestsSeq.readUInt32LE(d); d += 4
    const item = digestsSeq.slice(d, d + itemLen); d += itemLen
    const alg = item.readUInt32LE(0)
    const digestLen = item.readUInt32LE(4)
    digests.set(alg, item.slice(8, 8 + digestLen))
  }

  const signatures = []
  let s = 0
  while (s < sigsSeq.length) {
    const itemLen = sigsSeq.readUInt32LE(s); s += 4
    const item = sigsSeq.slice(s, s + itemLen); s += itemLen
    const alg = item.readUInt32LE(0)
    const sigLen = item.readUInt32LE(4)
    signatures.push([alg, item.slice(8, 8 + sigLen)])
  }

  return { signedData, digests, signatures, spki }
}

// 从签名块里找出 v2 块
export function findV2Block(signingBlock) {
  let p = 8
  const end = signingBlock.length - 8 - 16
  while (p < end) {
    const pairLen = Number(signingBlock.readBigUInt64LE(p))
    const id = signingBlock.readUInt32LE(p + 8)
    if (id === APK_SIG_BLOCK_V2_ID) return signingBlock.slice(p + 12, p + 8 + pairLen)
    p += 8 + pairLen
  }
  return null
}

// -------------------------------------------------------------- 压缩工具 ----
export function deflate(buf) {
  const raw = zlib.deflateRawSync(buf, { level: 6 })
  return { raw, crc: crc32(buf), csize: raw.length, size: buf.length }
}
export function store(buf) {
  return { raw: buf, crc: crc32(buf), csize: buf.length, size: buf.length }
}
