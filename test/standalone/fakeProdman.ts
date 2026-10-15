import * as http from 'http'
import * as WebSocket from 'ws'

/**
 * a minimal prodman: verifyPM2 handshake + agent WebSocket on one port. `log` keeps packets and
 * socket closes in arrival order (to check that `agent:shutdown` precedes the 1000 close).
 */
export class FakeProdman {
  server: http.Server
  wss: any
  handshakes: any[] = []
  upgrades: any[] = []
  packets: any[] = []
  log: any[] = []
  closes: Array<{ code: number, reason: string }> = []
  socket: any = null
  collectLogs = false
  port = 0
  private waiters: Array<{ match: (p: any) => boolean, resolve: (p: any) => void }> = []
  private closeWaiters: Array<(c: any) => void> = []

  start (): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const data = JSON.parse(body || '{}')
        this.handshakes.push({ url: req.url, data })
        res.setHeader('content-type', 'application/json')
        if (data.public_id !== 'pub' || data.private_id !== 'sec') {
          return res.end(JSON.stringify({ active: false, error: true, msg: 'Invalid keys' }))
        }
        res.end(JSON.stringify({
          active: true,
          endpoints: { ws: `ws://127.0.0.1:${this.port}/agent/ws` },
          prodman: { version: 1, collect_logs: this.collectLogs, collect_syslog: false }
        }))
      })
    })
    // @ts-ignore
    this.wss = new WebSocket.Server({ server: this.server, path: '/agent/ws' })
    this.wss.on('connection', (socket, req) => {
      this.upgrades.push(req.headers)
      this.socket = socket
      socket.on('message', raw => {
        const p = JSON.parse(raw.toString())
        this.packets.push(p)
        this.log.push({ type: 'packet', channel: p.channel, payload: p.payload })
        this.waiters = this.waiters.filter(w => {
          if (!w.match(p)) return true
          w.resolve(p)
          return false
        })
      })
      socket.on('close', (code, reason) => {
        const c = { code, reason: reason ? reason.toString() : '' }
        this.closes.push(c)
        this.log.push({ type: 'close', code: c.code, reason: c.reason })
        const ws = this.closeWaiters
        this.closeWaiters = []
        ws.forEach(w => w(c))
      })
    })
    return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => {
      this.port = (this.server.address() as any).port
      resolve()
    }))
  }

  /** next packet (already received or future) matching */
  next (match: (p: any) => boolean): Promise<any> {
    const seen = this.packets.find(match)
    if (seen) {
      this.packets.splice(this.packets.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise(resolve => this.waiters.push({ match, resolve }))
  }

  channel (name: string, extra?: (p: any) => boolean) {
    return this.next(p => p.channel === name && (!extra || extra(p)))
  }

  /** the next socket close (or the last one, if one already happened) */
  closed (): Promise<{ code: number, reason: string }> {
    if (this.closes.length > 0) return Promise.resolve(this.closes[this.closes.length - 1])
    return new Promise(resolve => this.closeWaiters.push(resolve))
  }

  send (channel: string, payload: any) {
    this.socket.send(JSON.stringify({ channel, payload }))
  }

  stop () {
    this.wss.close()
    this.server.close()
  }
}
