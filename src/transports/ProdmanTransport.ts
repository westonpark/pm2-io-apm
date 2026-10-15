import { Transport, TransportConfig } from '../services/transport'
import Debug from 'debug'
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
import { ContainerInfo, ContainerMetrics, Limits, SysRoot, serverNameFor, hostname } from '../utils/container'

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
 *  - containers (pmx 95 §1–§4, prodman 11 §5): detection and identity, `<service>@<instance>`
 *    server names, the `container` block, `ephemeral`, cgroup-aware server metrics
 *  - planned shutdowns: `agent:shutdown` on SIGTERM/SIGINT, normal end, crash and destroy()
 */

export const DEFAULT_URL = 'http://localhost:8070'
const STATUS_INTERVAL = 1000
const PING_INTERVAL = 5000
const PONG_TIMEOUT = 20000
const MAX_QUEUE = 200
const LOG_BUFFER = 200
/** APM-082: how long the first handshake waits for container detection (ECS metadata) */
const DETECT_WAIT = 1500
/** CTR-010: each ECS metadata request */
const ECS_TIMEOUT = 1000
/** APM-085 / CTR-022 Mode S: flush limit before the close */
const SHUTDOWN_FLUSH = 1000
const SHUTDOWN_POLL = 10
export const AGENT_KIND = '@pm2/io'

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

/**
 * name of this instance in prodman: one prodman server per standalone process (APM-083):
 * `PM2_MACHINE_NAME` (placeholders expanded), else `<service>@<instance>` in a container and
 * `<appName>@<hostname>` outside
 */
export function defaultServerName (appName: string, info?: ContainerInfo): string {
  return serverNameFor(info || ContainerInfo.detect(), appName, null)
}

export type ShutdownReason = 'signal' | 'exit' | 'crash' | 'stop'

/** signal-exit's own signal listeners (used by io.onExit) are not "the application's" */
function isSignalExitListener (fn: any): boolean {
  const g: any = global
  const present = !!((process as any).__signal_exit_emitter__ || g[Symbol.for('signal-exit emitter')])
  return present && typeof fn === 'function' && fn.name === 'listener'
}

function signalNumber (sig: string): number {
  const n = (os.constants && (os.constants.signals as any)[sig]) || (sig === 'SIGINT' ? 2 : 15)
  return n
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

type ShutdownState = {
  packet: { at: number, reason: ShutdownReason, signal: string | null, planned: boolean }
  /** the sockets the packet went out on (once per connection) */
  sentOn: any[]
  done: boolean
  keepAlive: boolean
  deadline: any
  poll: any
  callbacks: Function[]
}

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
  private container: ContainerInfo
  private containerMetrics: ContainerMetrics | null = null
  private detecting: boolean = false
  private nameFixed: boolean = false
  private shutdownState: ShutdownState | null = null
  /** set once a shutdown finished: no reconnects */
  private stopped: boolean = false
  private hooks: { [event: string]: Function } = {}

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
    // APM-081: detection once, at init (files and environment only; ECS metadata below)
    this.container = ContainerInfo.detect(process.env, SysRoot.host(process.env), process.platform === 'linux')
    if (this.container.inContainer()) this.containerMetrics = new ContainerMetrics(this.container)
    this.serverName = serverNameFor(this.container, config.appName, config.serverName)
    if (config.disableLogs !== true) this.hookStd()
    this.installShutdownHooks()
    if (this.container.ecsPending()) {
      // APM-082: the first handshake waits for the metadata, at most 1.5 s; the app never does
      this.detecting = true
      const ready = () => {
        if (!this.detecting) return
        this.detecting = false
        clearTimeout(this.timers.detect)
        this.start()
      }
      this.timers.detect = unref(setTimeout(ready, DETECT_WAIT))
      this.container.fetchEcs(ECS_TIMEOUT, (errors) => {
        errors.forEach(e => this.logger(e))
        ready()
      })
    } else {
      this.start()
    }
    return this
  }

  private start () {
    if (this.destroyed || this.stopped) return
    if (!this.nameFixed) {
      this.nameFixed = true
      this.serverName = serverNameFor(this.container, this.config.appName, this.config.serverName)
    }
    const c = this.container.detection
    this.logger(`Standalone mode: ${this.config.appName} reports to ${this.url} as ${this.serverName}` +
      (c.inContainer ? ` (container: ${c.runtime}, ${c.orchestrator})` : ''))
    this.connect()
  }

  /** the server name in use (fixed at the first handshake) */
  getServerName (): string {
    return this.serverName
  }

  getContainerInfo (): ContainerInfo {
    return this.container
  }

  private limits (): Limits | null {
    return this.containerMetrics ? this.containerMetrics.limits() : null
  }

  // ---------------------------------------------------------------- connection

  private connect () {
    if (this.destroyed || this.stopped) return
    this.handshake((err, res) => {
      if (this.destroyed || this.stopped) return
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
    // in a container, the effective limits (CTR-031, as pmx-io PYI-154)
    const limits = this.limits()
    const memory = limits ? limits.memoryBytes : os.totalmem()
    const cpus = limits ? os.cpus().slice(0, limits.cpusRoundedUp()) : os.cpus()
    const body = JSON.stringify({
      public_id: this.config.publicKey,
      private_id: this.config.secretKey,
      data: {
        MACHINE_NAME: this.serverName,
        PUBLIC_KEY: this.config.publicKey,
        RECYCLE: false,
        PM2_VERSION: null,
        IO_VERSION: this.version,
        MEMORY: Math.round(memory / 1024 / 1024),
        HOSTNAME: os.hostname(),
        CPUS: cpus
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
      // CTR-022: a shutdown still in progress is announced again on a new connection
      const st = this.shutdownState
      if (st && !st.done) {
        this.sendShutdownPacket()
        this.flushAndClose()
      }
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
      if (this.shutdownState && ws.__pmxShutdownClose) return this.finishShutdown()
      if (this.destroyed || this.stopped) return
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
    let system: any = {}
    let total = os.totalmem()
    let cpuCount = os.cpus().length
    let container: any
    const limits = this.limits()
    if (this.containerMetrics && limits) {
      // CTR-030…033: the container's cgroup and limits, not the node's
      system = this.containerMetrics.collect(limits)
      total = limits.memoryBytes
      cpuCount = limits.cpusRoundedUp()
      try {
        container = this.container.block(this.config.appName, hostname(), limits)
      } catch (e) {
        container = undefined
      }
    } else {
      const cpu = this.hostCpu()
      if (cpu !== null) system['CPU Usage'] = metric(cpu, '%')
      const free = os.freemem()
      system['RAM Usage'] = metric(Math.round((1 - free / total) * 1000) / 10, '%')
      system['RAM Total'] = metric(total, 'b')
      system['RAM Available'] = metric(free, 'b')
    }
    const server: any = {
      username: null,
      hostname: os.hostname(),
      uptime: os.uptime(),
      platform: process.platform,
      pm2_version: null,
      pm2_agent_version: `@pm2/io ${this.version}`,
      agent_kind: AGENT_KIND,
      ephemeral: this.container ? this.container.ephemeral() : false,
      node_version: process.version,
      unique_id: this.uniqueId,
      loadavg: os.loadavg(),
      total_mem: total,
      type: os.type(),
      arch: process.arch,
      cpus: cpuCount,
      cpu_model: (os.cpus()[0] || { model: null }).model,
      system
    }
    if (container) server.container = container

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
        server: Object.assign(server, { username: user })
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

  // ---------------------------------------------------------------- shutdown (APM-085…087)

  private installShutdownHooks () {
    const on = (event: string, fn: Function) => {
      this.hooks[event] = fn
      process.on(event as any, fn as any)
    }
    // APM-086: one listener each; whether we re-raise depends on the app having its own
    for (const sig of ['SIGTERM', 'SIGINT']) {
      try {
        on(sig, () => this.onSignal(sig))
      } catch (e) {
        this.logger(`cannot listen to ${sig}: ${e.message}`)
      }
    }
    // APM-087: the application finished its work
    on('beforeExit', () => {
      if (!this.shutdownState) this.shutdown('exit', null, true)
    })
    // APM-087: process.exit() can only be observed synchronously: best effort
    on('exit', (code) => {
      if (this.shutdownState || !this.connected) return
      const clean = !code
      this.shutdownState = this.newShutdownState(clean ? 'exit' : 'crash', null, clean, false)
      this.sendShutdownPacket()
      this.shutdownState.done = true
    })
  }

  private removeShutdownHooks () {
    for (const event of Object.keys(this.hooks)) {
      process.removeListener(event as any, this.hooks[event] as any)
    }
    this.hooks = {}
  }

  private onSignal (sig: string) {
    const st = this.shutdownState
    if (st && !st.done) {
      // a second signal during the flush skips the rest of it
      this.logger(`${sig} during the shutdown flush: closing now`)
      return this.finishShutdown()
    }
    if (st) return this.afterSignal(sig)
    this.shutdown('signal', sig, true, () => this.afterSignal(sig))
  }

  /**
   * APM-086: without listeners of the application's own, deliver the signal's default action
   * (re-raise; PID 1 ignores a default SIGTERM, so exit 128 + n instead); otherwise the
   * application decides when to exit
   */
  private afterSignal (sig: string) {
    const ours = this.hooks[sig]
    const others = process.listeners(sig as any).filter(l => l !== ours && !isSignalExitListener(l))
    if (others.length > 0) {
      this.logger(`${sig}: the application handles it`)
      return
    }
    if (ours) {
      process.removeListener(sig as any, ours as any)
      delete this.hooks[sig]
    }
    if (process.pid === 1) {
      process.exit(128 + signalNumber(sig))
      return
    }
    try {
      process.kill(process.pid, sig)
    } catch (e) {
      process.exit(128 + signalNumber(sig))
    }
  }

  private newShutdownState (reason: ShutdownReason, signal: string | null, planned: boolean, keepAlive: boolean): ShutdownState {
    return {
      packet: { at: Date.now(), reason, signal, planned },
      sentOn: [],
      done: false,
      keepAlive,
      deadline: null,
      poll: null,
      callbacks: []
    }
  }

  /**
   * CTR-022 / APM-085: send `agent:shutdown` (once per connection), flush for at most 1 s, close
   * with 1000 `Shutting down`, then call `cb`. Without a connection, `cb` runs at once (it is
   * sent on a connection opened while the process still runs). Returns false when a shutdown
   * was already under way (`cb` then runs when it ends).
   */
  shutdown (reason: ShutdownReason, signal: string | null, planned: boolean, cb?: Function): boolean {
    if (this.shutdownState) {
      if (cb) {
        if (this.shutdownState.done) cb()
        else this.shutdownState.callbacks.push(cb)
      }
      return false
    }
    const st = this.newShutdownState(reason, signal, planned, reason !== 'stop')
    if (cb) st.callbacks.push(cb)
    this.shutdownState = st
    this.logger(`Shutdown: ${reason}${signal ? ' ' + signal : ''}`)
    if (!this.connected || !this.ws) {
      this.finishShutdown()
      return true
    }
    this.sendShutdownPacket()
    this.flushAndClose()
    return true
  }

  private sendShutdownPacket () {
    const st = this.shutdownState
    if (!st || !this.ws || st.sentOn.indexOf(this.ws) > -1) return
    if (this.raw('agent:shutdown', st.packet)) st.sentOn.push(this.ws)
  }

  private flushAndClose () {
    const st = this.shutdownState
    if (!st || st.done) return
    const ws = this.ws
    if (!st.deadline) {
      const deadline = setTimeout(() => this.finishShutdown(), SHUTDOWN_FLUSH)
      // the only ref()'d timer: keeps the process alive during the flush (APM-085)
      if (!st.keepAlive) unref(deadline)
      st.deadline = deadline
    }
    clearInterval(st.poll)
    st.poll = unref(setInterval(() => {
      if (!ws || ws !== this.ws) return
      if (ws.bufferedAmount > 0 || this.queue.length > 0) return
      clearInterval(st.poll)
      ws.__pmxShutdownClose = true
      try {
        ws.close(1000, 'Shutting down')
      } catch (e) {
        this.finishShutdown()
      }
    }, SHUTDOWN_POLL))
  }

  private finishShutdown () {
    const st = this.shutdownState
    if (!st || st.done) return
    st.done = true
    this.stopped = true
    clearTimeout(st.deadline)
    clearInterval(st.poll)
    Object.keys(this.timers).forEach(k => { clearTimeout(this.timers[k]); clearInterval(this.timers[k]) })
    this.disconnect()
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try {
        if (ws.readyState === 1) {
          ws.__pmxShutdownClose = true
          ws.close(1000, 'Shutting down')
        }
        // still closing after the flush limit, or never opened: drop it
        if (ws.readyState !== 3) unref(setTimeout(() => { try { ws.terminate() } catch (e) { /* gone */ } }, 100))
      } catch (e) { /* closed */ }
    }
    const cbs = st.callbacks
    st.callbacks = []
    for (const cb of cbs) {
      try { cb() } catch (e) { this.logger(`shutdown callback failed: ${e.message}`) }
    }
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.detecting = false
    this.removeShutdownHooks()
    // APM-087: only the reporting stops ('stop', planned); the app keeps running
    if (!this.shutdownState && this.connected && this.ws) {
      this.shutdown('stop', null, true)
    } else if (this.shutdownState && !this.shutdownState.done) {
      // already flushing; let it finish
    } else {
      Object.keys(this.timers).forEach(k => { clearTimeout(this.timers[k]); clearInterval(this.timers[k]) })
      this.disconnect()
      if (this.ws) {
        try { this.ws.close() } catch (e) { /* already closed */ }
        this.ws = null
      }
    }
    Object.keys(this.timers).forEach(k => { clearTimeout(this.timers[k]); clearInterval(this.timers[k]) })
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
