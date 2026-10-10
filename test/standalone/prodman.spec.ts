import * as assert from 'assert'
import 'mocha'
import * as http from 'http'
import * as WebSocket from 'ws'
import * as io from '../../src'
import { resolveUrl, defaultServerName } from '../../src/transports/ProdmanTransport'

/** a minimal prodman: verifyPM2 handshake + agent WebSocket on one port */
class FakeProdman {
  server: http.Server
  wss: any
  handshakes: any[] = []
  upgrades: any[] = []
  packets: any[] = []
  socket: any = null
  collectLogs = false
  port = 0
  private waiters: Array<{ match: (p: any) => boolean, resolve: (p: any) => void }> = []

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
        this.waiters = this.waiters.filter(w => {
          if (!w.match(p)) return true
          w.resolve(p)
          return false
        })
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

  send (channel: string, payload: any) {
    this.socket.send(JSON.stringify({ channel, payload }))
  }

  stop () {
    this.wss.close()
    this.server.close()
  }
}

describe('prodman standalone transport', function () {
  this.timeout(15000)
  const prodman = new FakeProdman()
  const saved = { ...process.env }

  before(async () => {
    await prodman.start()
    delete process.env.pm_id
    process.env.PM2_PUBLIC_KEY = 'pub'
    process.env.PM2_SECRET_KEY = 'sec'
    process.env.PM2_APP_NAME = 'orders-api'
    process.env.PM2_MACHINE_NAME = 'orders-api-1'
    process.env.PRODMAN_URL = `http://127.0.0.1:${prodman.port}`
    io.init({ metrics: { v8: false, http: false, eventLoop: false, runtime: false, network: false } as any, apmOptions: { sendLogs: true } as any })
  })

  after(() => {
    io.destroy()
    prodman.stop()
    process.env = saved
  })

  it('resolves the URL and server name like the agent', () => {
    assert.strictEqual(resolveUrl('prodman.example.com/'), 'https://prodman.example.com')
    assert.strictEqual(resolveUrl('192.168.1.5:8070'), 'http://192.168.1.5:8070')
    assert.strictEqual(resolveUrl('http://x:1/'), 'http://x:1')
    const machine = process.env.PM2_MACHINE_NAME
    delete process.env.PM2_MACHINE_NAME
    assert.ok(/^api@.+/.test(defaultServerName('api')))
    process.env.PM2_MACHINE_NAME = machine
  })

  it('handshakes with the bucket keys and opens the agent socket with X-KM headers', async () => {
    const status = await prodman.channel('status')
    const hs = prodman.handshakes[0]
    assert.strictEqual(hs.url, '/api/node/verifyPM2')
    assert.strictEqual(hs.data.public_id, 'pub')
    assert.strictEqual(hs.data.data.MACHINE_NAME, 'orders-api-1')
    const h = prodman.upgrades[0]
    assert.strictEqual(h['x-km-public'], 'pub')
    assert.strictEqual(h['x-km-secret'], 'sec')
    assert.strictEqual(h['x-km-server'], 'orders-api-1')
    assert.ok(/^@pm2\/io /.test(h['x-pm2-version']))
    assert.strictEqual(status.payload.server_name, 'orders-api-1')
  })

  it('reports this process in status, with metrics, actions and runtime', async () => {
    const counter = io.counter({ name: 'Orders processed' })
    counter.inc(); counter.inc()
    io.action('purge cache', (reply) => reply({ purged: 3 }))
    const status = await prodman.channel('status', p => {
      const proc = p.payload.data.process[0]
      return proc.axm_monitor['Orders processed'] && proc.axm_actions.some(a => a.action_name === 'purge cache')
    })
    const proc = status.payload.data.process[0]
    assert.strictEqual(status.payload.data.process.length, 1)
    assert.strictEqual(proc.name, 'orders-api')
    assert.strictEqual(proc.pid, process.pid)
    assert.strictEqual(proc.status, 'online')
    assert.strictEqual(proc.axm_monitor['Orders processed'].value, 2)
    const names = proc.axm_actions.map(a => a.action_name)
    assert.ok(names.indexOf('purge cache') > -1)
    assert.ok(names.indexOf('km:heapdump') > -1, 'profiling actions are exposed too')
    assert.strictEqual(proc.runtime.kind, 'node')
    assert.strictEqual(proc.runtime.version, process.versions.node)
    assert.strictEqual(proc.runtime.execMode, 'standalone')
    assert.ok(status.payload.data.server.system['RAM Total'].value > 0)
    assert.strictEqual(status.payload.data.server.pm2_version, null)
  })

  it('runs remote actions and replies', async () => {
    prodman.send('trigger:action', { process_id: 0, action_name: 'purge cache' })
    const ack = await prodman.channel('trigger:action:success')
    assert.strictEqual(ack.payload.action_name, 'purge cache')
    const reply = await prodman.channel('axm:reply')
    assert.strictEqual(reply.payload.data.action_name, 'purge cache')
    assert.deepStrictEqual(reply.payload.data.return, { purged: 3 })
    assert.deepStrictEqual(reply.payload.process, { pm_id: 0, name: 'orders-api', rev: null, server: 'orders-api-1' })

    prodman.send('trigger:action', { process_id: 0, action_name: 'nope' })
    const fail = await prodman.channel('trigger:action:failure')
    assert.ok(/unknown action/.test(fail.payload.err))
  })

  it('sends events and exceptions on the agent channels', async () => {
    io.emit('order:failed', { id: 42 })
    const ev = await prodman.channel('human:event')
    assert.strictEqual(ev.payload.name, 'order:failed')
    assert.strictEqual(ev.payload.data.id, 42)
    assert.strictEqual(ev.payload.data.__name, undefined)

    io.notifyError(new Error('payment declined'))
    const ex = await prodman.channel('process:exception')
    assert.strictEqual(ex.payload.data.message, 'payment declined')
    assert.ok(Array.isArray(ex.payload.data.last_logs))
  })

  it('forwards stdout/stderr when sendLogs is set, and serves getLogs', async () => {
    console.log('hello from the app')
    const log = await prodman.channel('logs', p => /hello from the app/.test(p.payload.data))
    assert.strictEqual(log.payload.log_type, 'out')
    prodman.send('trigger:pm2:action', { method_name: 'getLogs', parameters: { name: 'orders-api', lines: 50, request_id: 'r1' } })
    const res = await prodman.channel('trigger:pm2:result', p => p.payload.meta.request_id === 'r1')
    assert.ok(/hello from the app/.test(res.payload.ret.data[0].out))
  })

  it('refuses PM2-only methods instead of leaving prodman waiting', async () => {
    prodman.send('trigger:pm2:action', { method_name: 'restart', parameters: { name: 'orders-api', request_id: 'r2' } })
    const res = await prodman.channel('trigger:pm2:result', p => p.payload.meta.request_id === 'r2')
    assert.ok(/runs without PM2/.test(res.payload.ret.err.message))
    prodman.send('trigger:pm2:action', { method_name: 'ping', parameters: { request_id: 'r3' } })
    const pong = await prodman.channel('trigger:pm2:result', p => p.payload.meta.request_id === 'r3')
    assert.deepStrictEqual(pong.payload.ret, { err: null, data: { msg: 'pong' } })
  })

  it('reconnects after the socket drops, re-sending a full status', async () => {
    const before = prodman.upgrades.length
    prodman.socket.terminate()
    await prodman.channel('status', () => prodman.upgrades.length > before)
    assert.strictEqual(prodman.handshakes.length >= 2, true)
  })
})
