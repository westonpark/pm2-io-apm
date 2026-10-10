import { Transport, TransportConfig } from '../services/transport'
import * as Debug from 'debug'
import { Action } from '../services/actions'
import { InternalMetric } from '../services/metrics'
import { EventEmitter2 } from 'eventemitter2'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'
import { URL } from 'url'

/**
 * prodman: standalone transport. An app that is not run by PM2 (a container, `node app.js`,
 * a serverless worker…) reports straight to a prodman server, as if it were a PM2 agent
 * managing a single process: same handshake, WebSocket and channels as the pm2_prodman agent
 * (prodman docs/agent-protocol.md). Replaces upstream's PM2.io-only @pm2/agent-node transport.
 *
 *  - handshake `POST {url}/api/node/verifyPM2`, retried forever with backoff
 *  - WebSocket to the returned endpoint with the X-KM-* headers; reconnects with backoff,
 *    ping every 5s, reconnect when no pong for 20s
 *  - `status` every second: this process (metrics, actions, options, runtime) + host info
 *  - events, exceptions, action replies, profiles, dependencies, logs: same channels as the agent
 *  - remote actions (`trigger:action`, scoped actions) run through the action service
 *  - logs: stdout/stderr are forwarded when `sendLogs` is set or the bucket collects logs,
 *    unless `disableLogs`; recent lines are kept for exceptions and `getLogs`
 *  - sockets and timers are unref'd, so the transport never keeps the app alive
 */

export const DEFAULT_URL = 'http://localhost:8070'
const STATUS_INTERVAL = 1000
const PING_INTERVAL = 5000
const PONG_TIMEOUT = 20000
const MAX_QUEUE = 200
const LOG_BUFFER = 200

/** prodman base URL: config → PRODMAN_URL → KEYMETRICS_NODE → localhost:8070 */
export function resolveUrl (configured?: string): string {
  let url = (configured || process.env.PRODMAN_URL || process.env.KEYMETRICS_NODE || DEFAULT_URL).trim()
  if (!/^[a-z]+:\/\//i.test(url)) {
    const host = url.split('/')[0].split(':')[0]
    const local = host === 'localhost' || /^[\d.]+$/.test(host)
    url = (local ? 'http://' : 'https://') + url
  }
  return url.replace(/\/+$/, '')
}

/** name of this instance in prodman: one prodman server per standalone process */
export function defaultServerName (appName: string): string {
  return process.env.PM2_MACHINE_NAME || `${appName}@${os.hostname()}`
}

function ioVersion (): string {
  for (const p of ['../../../package.json', '../../package.json']) {
    try { return require(p).version } catch (e) { /* try the next layout (build vs src) */ }
  }
  return 'unknown'
}

/** version field of the app's package.json (as PM2 reports it), if any */
function appVersion (): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      return typeof pkg.version === 'string' ? pkg.version : null
    } catch (e) {
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

function backoff (attempt: number, min: number, max: number): number {
  const base = Math.min(max, min * Math.pow(2, attempt))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function unref (t: any) {
  if (t && typeof t.unref === 'function') t.unref()
  return t
}

type Handshake = { ws: string, collectLogs: boolean }

export class ProdmanTransport extends EventEmitter2 implements Transport {
  private logger: Function = Debug('axm:transport:prodman')
  private config: TransportConfig
  private url: string
  private serverName: string
  private initiated: boolean = false
  private destroyed: boolean = false
  private ws: any = null
  private connected: boolean = false
  private attempts: number = 0
  private timers: { [name: string]: any } = {}
  private lastPong: number = 0
  private queue: Array<{ channel: string, payload: any }> = []
  private collectLogs: boolean = false
  private restoreStd: Function | null = null
  private writing: boolean = false
  private logBuffer: { out: string[], err: string[] } = { out: [], err: [] }
  private startedAt: number = Date.now()
  private uniqueId: string = crypto.randomBytes(12).toString('hex')
  private cpuPrev: { usage: NodeJS.CpuUsage, at: number } = { usage: process.cpuUsage(), at: Date.now() }
  private hostCpuPrev: { idle: number, total: number } | null = null
  private version: string = ioVersion()
  private appVer: string | null = appVersion()

  /** what PM2 would know about this process */
  private proc = {
    axm_actions: [] as any[],
    axm_monitor: {} as any,
    axm_options: {} as any
  }

  init (config: TransportConfig): Transport {
    if (this.initiated) {
      console.error(`Trying to re-init the transport, please avoid`)
      return this
    }
    if (!config || !config.publicKey || !config.secretKey || !config.appName) {
      throw new Error('[@pm2/io] standalone mode needs publicKey, secretKey and appName (PM2_PUBLIC_KEY, PM2_SECRET_KEY, PM2_APP_NAME)')
    }
    this.initiated = true
    this.config = config
    this.url = resolveUrl(config.url)
    this.serverName = config.serverName || defaultServerName(config.appName)
    if (config.disableLogs !== true) this.hookStd()
    this.logger(`Standalone mode: ${config.appName} reports to ${this.url} as ${this.serverName}`)
    this.connect()
    return this
  }

  // ---------------------------------------------------------------- connection

  private connect () {
    if (this.destroyed) return
    this.handshake((err, res) => {
      if (this.destroyed) return
      if (err || !res) {
        const delay = backoff(this.attempts++, 1000, 60000)
        this.logger(`Handshake failed (${err && err.message}), retrying in ${delay}ms`)
        this.timers.retry = unref(setTimeout(() => this.connect(), delay))
        return
      }
      this.collectLogs = res.collectLogs
      this.open(res.ws)
    })
  }

  private handshake (cb: (err: Error | null, res?: Handshake) => void) {
    const body = JSON.stringify({
      public_id: this.config.publicKey,
      private_id: this.config.secretKey,
      data: {
        MACHINE_NAME: this.serverName,
        PUBLIC_KEY: this.config.publicKey,
        RECYCLE: false,
        PM2_VERSION: null,
        IO_VERSION: this.version,
        MEMORY: Math.round(os.totalmem() / 1024 / 1024),
        HOSTNAME: os.hostname(),
        CPUS: os.cpus()
      }
    })
    let target: URL
    try {
      target = new URL(this.url + '/api/node/verifyPM2')
    } catch (e) {
      return cb(e)
    }
    const lib: any = target.protocol === 'https:' ? https : http
    let done = false
    const finish = (err: Error | null, res?: Handshake) => {
      if (done) return
      done = true
      cb(err, res)
    }
    const req = lib.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let data: any
        try { data = JSON.parse(text) } catch (e) { return finish(new Error(`invalid handshake response (HTTP ${res.statusCode})`)) }
        if (!data || data.active !== true || !data.endpoints || !data.endpoints.ws) {
          const msg = (data && data.msg) || 'bucket not active'
          console.error(`[@pm2/io] prodman refused the connection: ${msg}`)
          return finish(new Error(msg))
        }
        const prodman = data.prodman || {}
        finish(null, { ws: data.endpoints.ws, collectLogs: prodman.collect_logs === true })
      })
    })
    req.on('timeout', () => req.destroy(new Error('handshake timed out')))
    req.on('error', (e) => finish(e))
    req.end(body)
  }

  private open (endpoint: string) {
    const WebSocket = require('ws')
    const ws = new WebSocket(endpoint, {
      headers: {
        'X-KM-PUBLIC': this.config.publicKey,
        'X-KM-SECRET': this.config.secretKey,
        'X-KM-SERVER': this.serverName,
        'X-PM2-VERSION': `@pm2/io ${this.version}`,
        'X-PROTOCOL-VERSION': '1'
      },
      perMessageDeflate: false
    })
    this.ws = ws

    ws.on('open', () => {
      if (ws !== this.ws) return ws.terminate()
      if (ws._socket && ws._socket.unref) ws._socket.unref()
      this.connected = true
      this.attempts = 0
      this.lastPong = Date.now()
      this.logger(`Connected to ${endpoint}`)
      this.sendStatus()
      this.flush()
      this.timers.status = unref(setInterval(() => this.sendStatus(), STATUS_INTERVAL))
      this.timers.ping = unref(setInterval(() => this.heartbeat(), PING_INTERVAL))
    })
    ws.on('pong', () => { this.lastPong = Date.now() })
    ws.on('message', (raw) => {
      let packet: any
      try { packet = JSON.parse(raw.toString()) } catch (e) { return }
      if (packet && typeof packet.channel === 'string') this.onPacket(packet.channel, packet.payload || {})
    })
    ws.on('error', (err) => this.logger(`WebSocket error: ${err.message}`))
    ws.on('close', (code) => {
      if (ws !== this.ws) return
      this.logger(`WebSocket closed (${code})`)
      this.disconnect()
      if (this.destroyed) return
      const delay = backoff(this.attempts++, 5000, 60000)
      this.timers.retry = unref(setTimeout(() => this.connect(), delay))
    })
  }

  private heartbeat () {
    if (!this.ws || !this.connected) return
    if (Date.now() - this.lastPong > PONG_TIMEOUT) {
      this.logger('No pong from prodman, reconnecting')
      return this.ws.terminate()
    }
    try { this.ws.ping() } catch (e) { /* closing */ }
  }

  private disconnect () {
    this.connected = false
    clearInterval(this.timers.status)
    clearInterval(this.timers.ping)
  }

  private raw (channel: string, payload: any): boolean {
    if (!this.connected || !this.ws) return false
    try {
      this.ws.send(JSON.stringify({ channel, payload }))
      return true
    } catch (e) {
      return false
    }
  }

  private flush () {
    const pending = this.queue
    this.queue = []
    pending.forEach(p => this.raw(p.channel, p.payload))
  }

  // ---------------------------------------------------------------- prodman → app

  private onPacket (channel: string, payload: any) {
    switch (channel) {
      case 'status:resend':
        return this.sendStatus()
      case 'trigger:action':
      case 'trigger:scoped_action': {
        const name = payload.action_name
        const known = this.proc.axm_actions.some(a => a.action_name === name)
        if (!known) {
          return this.raw('trigger:action:failure', { success: false, err: `unknown action ${name}`, id: payload.process_id, action_name: name })
        }
        this.raw('trigger:action:success', { success: true, id: payload.process_id, action_name: name })
        // the action service replies through send('axm:reply' | 'axm:scoped_action:*')
        return this.emit('data', { msg: name, action_name: name, opts: payload.opts, uuid: payload.uuid })
      }
      case 'trigger:pm2:action':
        return this.onPM2Action(payload)
    }
    this.logger(`Ignoring ${channel}`)
  }

  /** PM2 methods mostly don't apply without PM2; answer instead of leaving prodman waiting */
  private onPM2Action (payload: any) {
    const method = payload.method_name
    const params = payload.parameters || {}
    let ret: { err: any, data: any }
    if (method === 'ping') {
      ret = { err: null, data: { msg: 'pong' } }
    } else if (method === 'getLogs') {
      const lines = Math.max(1, Math.min(parseInt(params.lines, 10) || 200, LOG_BUFFER))
      const type = params.type || 'both'
      ret = {
        err: null,
        data: [{
          pm_id: 0,
          name: this.config.appName,
          out: type === 'err' ? '' : this.logBuffer.out.slice(-lines).join(''),
          err: type === 'out' ? '' : this.logBuffer.err.slice(-lines).join('')
        }]
      }
    } else if (method === 'startLogging' || method === 'stopLogging') {
      this.collectLogs = method === 'startLogging' || this.config.sendLogs === true
      ret = { err: null, data: { success: true } }
    } else {
      ret = { err: { message: `${method} is not available: ${this.config.appName} runs without PM2 (@pm2/io standalone)` }, data: null }
    }
    this.raw('trigger:pm2:result', {
      ret,
      meta: {
        method_name: method,
        app_name: this.config.appName,
        machine_name: this.serverName,
        public_key: this.config.publicKey,
        request_id: params.request_id
      }
    })
  }

  // ---------------------------------------------------------------- app → prodman

  private processRef () {
    return { pm_id: 0, name: this.config.appName, rev: null, server: this.serverName }
  }

  send (channel: string, payload: any) {
    let packet: any
    switch (channel) {
      case 'human:event': {
        const data = Object.assign({}, payload)
        const name = data.__name
        delete data.__name
        packet = { at: Date.now(), name, data, process: this.processRef() }
        break
      }
      case 'process:exception': {
        const data = Object.assign({}, payload)
        if (!data.last_logs) data.last_logs = this.logBuffer.err.slice(-20).concat(this.logBuffer.out.slice(-20))
        packet = { at: Date.now(), data, process: this.processRef() }
        break
      }
      default:
        packet = { at: Date.now(), data: payload, process: this.processRef() }
    }
    if (this.raw(channel, packet)) return 0
    if (this.queue.length >= MAX_QUEUE) this.queue.shift()
    this.queue.push({ channel, payload: packet })
    return -1
  }

  setMetrics (metrics: InternalMetric[]) {
    this.proc.axm_monitor = metrics.reduce((object, metric: InternalMetric) => {
      if (typeof metric.name !== 'string') return object
      object[metric.name] = {
        historic: metric.historic,
        unit: metric.unit,
        type: metric.id,
        value: metric.value
      }
      return object
    }, {})
  }

  addAction (action: Action) {
    this.logger(`Add action: ${action.name}:${action.type}`)
    this.proc.axm_actions = this.proc.axm_actions.filter(a => a.action_name !== action.name)
    this.proc.axm_actions.push({
      action_name: action.name,
      action_type: action.type,
      arity: action.arity,
      opts: action.opts
    })
  }

  setOptions (options) {
    this.proc.axm_options = Object.assign(this.proc.axm_options, options)
  }

  // ---------------------------------------------------------------- status

  private cpuPercent (): number {
    const now = Date.now()
    const usage = process.cpuUsage()
    const elapsed = (now - this.cpuPrev.at) * 1000
    const used = (usage.user - this.cpuPrev.usage.user) + (usage.system - this.cpuPrev.usage.system)
    this.cpuPrev = { usage, at: now }
    return elapsed > 0 ? Math.max(0, Math.round((used / elapsed) * 100)) : 0
  }

  private hostCpu (): number | null {
    const totals = os.cpus().reduce((acc, c) => {
      const t = c.times
      acc.idle += t.idle
      acc.total += t.user + t.nice + t.sys + t.irq + t.idle
      return acc
    }, { idle: 0, total: 0 })
    const prev = this.hostCpuPrev
    this.hostCpuPrev = totals
    if (!prev || totals.total <= prev.total) return null
    return Math.round((1 - (totals.idle - prev.idle) / (totals.total - prev.total)) * 1000) / 10
  }

  status () {
    const metric = (value, unit) => ({ value, type: 'metric', unit, historic: true })
    const system: any = {}
    const cpu = this.hostCpu()
    if (cpu !== null) system['CPU Usage'] = metric(cpu, '%')
    const total = os.totalmem()
    const free = os.freemem()
    system['RAM Usage'] = metric(Math.round((1 - free / total) * 1000) / 10, '%')
    system['RAM Total'] = metric(total, 'b')
    system['RAM Available'] = metric(free, 'b')

    let user: string | null = null
    try { user = os.userInfo().username } catch (e) { user = process.env.USER || null }
    const script = process.argv[1] || null

    return {
      at: Date.now(),
      server_name: this.serverName,
      internal_ip: internalIp(),
      data: {
        process: [{
          pid: process.pid,
          name: this.config.appName,
          interpreter: 'node',
          args: process.execArgv,
          path: script,
          restart_time: 0,
          created_at: this.startedAt,
          exec_mode: 'fork_mode',
          pm_uptime: this.startedAt,
          status: 'online',
          pm_id: 0,
          unique_id: this.uniqueId,
          cpu: this.cpuPercent(),
          memory: process.memoryUsage().rss,
          versioning: null,
          node_env: process.env.NODE_ENV || null,
          axm_actions: this.proc.axm_actions,
          axm_monitor: this.proc.axm_monitor,
          axm_options: this.proc.axm_options,
          axm_dynamic: {},
          namespace: 'default',
          version: this.appVer,
          node_version: process.versions.node,
          unstable_restarts: 0,
          pm_cwd: process.cwd(),
          instances: 1,
          watch: false,
          autorestart: false,
          runtime: {
            kind: 'node',
            version: process.versions.node,
            versionSource: 'process',
            interpreter: 'node',
            interpreterPath: process.execPath,
            interpreterArgs: [],
            nodeArgs: process.execArgv,
            virtualenv: null,
            script,
            args: process.argv.slice(2),
            cwd: process.cwd(),
            execMode: 'standalone',
            instances: 1,
            user,
            nodeEnv: process.env.NODE_ENV || null,
            watch: false,
            autorestart: false,
            maxMemoryRestart: null,
            killTimeout: null,
            cronRestart: null,
            mergeLogs: false
          }
        }],
        server: {
          username: user,
          hostname: os.hostname(),
          uptime: os.uptime(),
          platform: process.platform,
          pm2_version: null,
          pm2_agent_version: `@pm2/io ${this.version}`,
          node_version: process.version,
          unique_id: this.uniqueId,
          loadavg: os.loadavg(),
          total_mem: total,
          type: os.type(),
          arch: process.arch,
          cpus: os.cpus().length,
          cpu_model: (os.cpus()[0] || { model: null }).model,
          system
        }
      }
    }
  }

  private sendStatus () {
    this.raw('status', this.status())
  }

  // ---------------------------------------------------------------- logs

  private hookStd () {
    const out: any = process.stdout
    const err: any = process.stderr
    const outWrite = out.write
    const errWrite = err.write
    const filter = this.config.logFilter
    const capture = (type: 'out' | 'err', chunk: any) => {
      if (this.writing) return
      this.writing = true
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        if (filter && (typeof filter === 'string' ? text.indexOf(filter) > -1 : filter.test(text))) return
        const buf = this.logBuffer[type]
        buf.push(text)
        if (buf.length > LOG_BUFFER) buf.shift()
        if (this.collectLogs || this.config.sendLogs === true) {
          this.raw('logs', { at: Date.now(), data: text, log_type: type, process: this.processRef() })
        }
      } catch (e) {
        // never break the app's output
      } finally {
        this.writing = false
      }
    }
    out.write = function (chunk, ...rest) { capture('out', chunk); return outWrite.call(out, chunk, ...rest) }
    err.write = function (chunk, ...rest) { capture('err', chunk); return errWrite.call(err, chunk, ...rest) }
    this.restoreStd = () => {
      out.write = outWrite
      err.write = errWrite
    }
  }

  destroy () {
    this.destroyed = true
    Object.keys(this.timers).forEach(k => { clearTimeout(this.timers[k]); clearInterval(this.timers[k]) })
    this.disconnect()
    if (this.ws) {
      try { this.ws.close() } catch (e) { /* already closed */ }
      this.ws = null
    }
    if (this.restoreStd) this.restoreStd()
    this.restoreStd = null
    this.logger('destroy')
  }
}

function internalIp (): string | null {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return null
}
