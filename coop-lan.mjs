// LAN co-op: the signaling server and the 2P page, served by this app itself, so a room works with no
// internet at all (both players on the same Wi-Fi / router). Same protocol as the online server
// (server/signal.js in the co-op project): each side listens with Server-Sent Events and POSTs messages
// that are relayed to the other side. Plain http on purpose: a browser accepts no certificate for a LAN
// address, and the 2P page needs nothing that requires https (it only receives video and sends key presses).
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs'

const PORTS = [8790, 8791, 8792, 0] // fixed ports first (a firewall rule made once keeps working), then any free one
const FILES = { 'guest2.html': 'text/html; charset=utf-8', 'coop.js': 'text/javascript; charset=utf-8' } // nothing else is served
const ROOM_RE = /^[A-Z0-9]{4,8}$/, ID_RE = /^[a-z0-9-]{8,40}$/, MAX_BODY = 64 * 1024
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }

// This computer's addresses on home / office networks, most likely one first.
export function lanAddresses() {
  const rank = a => /^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : /^169\.254\./.test(a) ? 9 : 5
  const skip = /^(utun|tun|tap|ppp|ipsec|llw|awdl|bridge|docker|veth|vEthernet|VMware|VirtualBox|vboxnet|Tailscale|ZeroTier|WSL)/i
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push({ address: a.address, rank: rank(a.address) + (skip.test(name) ? 3 : 0) })
    }
  }
  return out.filter(a => a.rank < 9).sort((a, b) => a.rank - b.rank).map(a => a.address)
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { ...cors, 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Starts the server for ONE room code. Resolves to { port, close() }.
export function startLanServer(dir, room) {
  const seats = {} // host / guest -> { id, res }
  const streams = new Set()
  const push = (c, event, data) => { if (c && !c.res.writableEnded) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const member = q => (q.get('room') || '').toUpperCase() === room && [seats.host, seats.guest].find(c => c && c.id === (q.get('id') || ''))

  function events(req, res, q) {
    const role = q.get('role'), id = q.get('id') || ''
    if (!ROOM_RE.test((q.get('room') || '').toUpperCase()) || !['host', 'guest'].includes(role) || !ID_RE.test(id)) return send(res, 400, { error: 'bad params' })
    if ((q.get('room') || '').toUpperCase() !== room) return send(res, 404, { error: 'room not found' })
    // The host seat belongs to this computer.
    if (role === 'host' && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '')) return send(res, 403, { error: 'host must be local' })
    if (seats[role] && seats[role].id !== id) return send(res, 409, { error: role + ' already in room' })
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    res.write(': connected\n\n')
    const me = { id, role, res }; seats[role] = me; streams.add(res)
    const other = seats[role === 'host' ? 'guest' : 'host']
    push(me, 'hello', { room, role, peer: other ? other.role : null })
    if (other) push(other, 'peer-joined', { role })
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.on('close', () => {
      clearInterval(beat); streams.delete(res)
      if (seats[role] === me) {
        delete seats[role]
        push(seats[role === 'host' ? 'guest' : 'host'], 'peer-left', { role })
      }
    })
  }

  async function relay(req, res, q) {
    const me = member(q)
    if (!me) return send(res, 403, { error: 'not in room' })
    let msg
    try { msg = JSON.parse(await readBody(req)) } catch { return send(res, 400, { error: 'bad body' }) }
    const peer = seats[me.role === 'host' ? 'guest' : 'host']
    if (!peer) return send(res, 409, { error: 'peer not connected' })
    push(peer, 'message', msg)
    send(res, 200, { ok: true })
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, '')
    const u = new URL(req.url, 'http://x')
    try {
      if (req.method === 'GET' && u.pathname === '/coop/api/events') return events(req, res, u.searchParams)
      if (req.method === 'POST' && u.pathname === '/coop/api/send') return await relay(req, res, u.searchParams)
      if (req.method === 'POST' && u.pathname === '/coop/api/report') { req.resume(); return send(res, 200, { ok: true }) } // nothing is collected on a LAN
      // No STUN or relay on a LAN: the two devices reach each other directly.
      if (req.method === 'GET' && u.pathname === '/coop/api/ice') return send(res, 200, { iceServers: [], lan: true })
      if (req.method === 'GET' && u.pathname === '/coop/api/health') return send(res, 200, { ok: true, lan: true })
      const name = u.pathname.startsWith('/coop/') ? u.pathname.slice(6) : ''
      if (req.method === 'GET' && FILES[name]) {
        return readFile(path.join(dir, name), (err, buf) => err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, buf, FILES[name]))
      }
      send(res, 404, { error: 'not found' })
    } catch {
      send(res, 500, { error: 'server error' })
    }
  })

  const close = () => { for (const r of streams) r.destroy(); server.close(); server.closeAllConnections?.() }
  return new Promise((resolve, reject) => {
    let i = 0
    const tryNext = () => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && ++i < PORTS.length) tryNext(); else reject(e) })
      server.listen(PORTS[i], '0.0.0.0', () => { server.removeAllListeners('error'); server.on('error', () => {}); resolve({ port: server.address().port, close }) })
    }
    tryNext()
  })
}
