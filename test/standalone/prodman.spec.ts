import * as assert from 'assert'
import 'mocha'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as io from '../../src'
import { resolveUrl, defaultServerName } from '../../src/transports/ProdmanTransport'
import { FakeProdman } from './fakeProdman'

describe('prodman standalone transport', function () {
  this.timeout(15000)
  const prodman = new FakeProdman()
  const saved = { ...process.env }

  before(async () => {
    await prodman.start()
    delete process.env.pm_id
    process.env.PMX_CONTAINER = '0' // this suite reports as a host (the CI runner may be a container)
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
    assert.strictEqual(defaultServerName('api'), `api@${os.hostname()}`)
    // APM-083: placeholders in an explicit name; outside containers {service} is the app
    process.env.PM2_MACHINE_NAME = '{service}-{instance}-{random}'
    const name = defaultServerName('api')
    assert.ok(new RegExp(`^api-${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{4}$`).test(name), name)
    assert.strictEqual(defaultServerName('api'), name, '{random} is drawn once per process')
    process.env.PM2_MACHINE_NAME = 'x'.repeat(250)
    assert.strictEqual(defaultServerName('api').length, 200)
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
    // APM-084/088: outside a container
    const server = status.payload.data.server
    assert.strictEqual(server.agent_kind, '@pm2/io')
    assert.strictEqual(server.ephemeral, false)
    assert.strictEqual(server.container, undefined)
    assert.strictEqual(server.total_mem, os.totalmem())
    assert.strictEqual(server.cpus, os.cpus().length)
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

// ------------------------------------------------------------------ APM-085…087 shutdown

const CHILD = path.resolve(__dirname, '../fixtures/standalone/shutdownChild.ts')

/** runs the fixture against `prodman`; resolves with the child once it reported `go` */
async function launch (prodman: FakeProdman, mode: string, extraEnv: any = {}): Promise<{ child: any, out: () => string, exited: Promise<{ code: number | null, signal: string | null }> }> {
  const env = Object.assign({}, process.env, {
    PM2_PUBLIC_KEY: 'pub',
    PM2_SECRET_KEY: 'sec',
    PM2_APP_NAME: 'shutdown-app',
    PM2_MACHINE_NAME: `shutdown-${mode}`,
    PRODMAN_URL: `http://127.0.0.1:${prodman.port}`,
    PMX_CONTAINER: '0',
    FIXTURE_MODE: mode,
    TS_NODE_TRANSPILE_ONLY: 'true'
  }, extraEnv)
  delete env.pm_id
  const bun = !!(process.versions as any).bun
  const args = bun ? [CHILD] : ['-r', 'ts-node/register', CHILD]
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.on('data', d => { out += d })
  child.stderr!.on('data', d => { out += d })
  const exited = new Promise<{ code: number | null, signal: string | null }>(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  await prodman.channel('status', p => p.payload.data.process[0].axm_actions.some(a => a.action_name === 'go'))
  return { child, out: () => out, exited }
}

function order (prodman: FakeProdman): string[] {
  return prodman.log
    .filter(e => e.type === 'close' || ['agent:shutdown', 'process:exception'].indexOf(e.channel) > -1)
    .map(e => e.type === 'close' ? `close:${e.code}:${e.reason}` : e.channel === 'agent:shutdown' ? `shutdown:${e.payload.reason}` : e.channel)
}

describe('prodman standalone shutdown (agent:shutdown)', function () {
  this.timeout(30000)
  let prodman: FakeProdman
  let child: any = null

  beforeEach(async () => {
    prodman = new FakeProdman()
    await prodman.start()
  })

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child = null
    prodman.stop()
  })

  it('SIGTERM: one agent:shutdown (signal, planned) before a 1000 close, then dies by the signal', async () => {
    const run = await launch(prodman, 'idle')
    child = run.child
    const sentAt = Date.now()
    child.kill('SIGTERM')
    const shutdown = await prodman.channel('agent:shutdown')
    assert.strictEqual(shutdown.payload.reason, 'signal')
    assert.strictEqual(shutdown.payload.signal, 'SIGTERM')
    assert.strictEqual(shutdown.payload.planned, true)
    assert.ok(typeof shutdown.payload.at === 'number')
    const res = await run.exited
    assert.strictEqual(res.signal, 'SIGTERM', `exit ${JSON.stringify(res)} ${run.out()}`)
    assert.ok(Date.now() - sentAt < 1500, 'termination delayed by at most ~1 s')
    await prodman.closed()
    assert.deepStrictEqual(order(prodman), ['shutdown:signal', 'close:1000:Shutting down'])
  })

  it('SIGINT is reported the same way', async () => {
    const run = await launch(prodman, 'idle')
    child = run.child
    child.kill('SIGINT')
    const shutdown = await prodman.channel('agent:shutdown')
    assert.strictEqual(shutdown.payload.signal, 'SIGINT')
    const res = await run.exited
    assert.strictEqual(res.signal, 'SIGINT')
  })

  it('with an application SIGTERM listener, announces the shutdown but does not exit by itself', async () => {
    const run = await launch(prodman, 'own-handler')
    child = run.child
    child.kill('SIGTERM')
    const shutdown = await prodman.channel('agent:shutdown')
    assert.strictEqual(shutdown.payload.reason, 'signal')
    const close = await prodman.closed()
    assert.strictEqual(close.code, 1000)
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.strictEqual(child.exitCode, null, 'still running')
    assert.strictEqual(child.signalCode, null, 'still running')
    assert.ok(/app: SIGTERM received/.test(run.out()))
    assert.strictEqual(prodman.log.filter(e => e.channel === 'agent:shutdown').length, 1)
  })

  it('io.onExit (signal-exit) does not count as an application listener', async () => {
    const run = await launch(prodman, 'onexit')
    child = run.child
    child.kill('SIGTERM')
    await prodman.channel('agent:shutdown')
    const res = await run.exited
    assert.strictEqual(res.signal, 'SIGTERM')
    assert.ok(/app: onExit callback/.test(run.out()), run.out())
  })

  it('a script that ends sends exit (planned) and exits 0', async () => {
    const run = await launch(prodman, 'ends')
    child = run.child
    prodman.send('trigger:action', { process_id: 0, action_name: 'go' })
    const shutdown = await prodman.channel('agent:shutdown')
    assert.deepStrictEqual([shutdown.payload.reason, shutdown.payload.signal, shutdown.payload.planned], ['exit', null, true])
    const res = await run.exited
    assert.strictEqual(res.code, 0)
    await prodman.closed()
    assert.deepStrictEqual(order(prodman), ['shutdown:exit', 'close:1000:Shutting down'])
  })

  it('an uncaught exception sends the exception, then crash (unplanned), then exits 1', async () => {
    const run = await launch(prodman, 'crash')
    child = run.child
    prodman.send('trigger:action', { process_id: 0, action_name: 'go' })
    const res = await run.exited
    assert.strictEqual(res.code, 1)
    await prodman.closed()
    assert.deepStrictEqual(order(prodman), ['process:exception', 'shutdown:crash', 'close:1000:Shutting down'])
    const shutdown = prodman.log.find(e => e.channel === 'agent:shutdown')
    assert.strictEqual(shutdown.payload.planned, false)
    assert.strictEqual(shutdown.payload.signal, null)
  })

  it('destroy() sends stop (planned) and the app keeps running', async () => {
    const run = await launch(prodman, 'destroy')
    child = run.child
    prodman.send('trigger:action', { process_id: 0, action_name: 'go' })
    const shutdown = await prodman.channel('agent:shutdown')
    assert.deepStrictEqual([shutdown.payload.reason, shutdown.payload.planned], ['stop', true])
    const close = await prodman.closed()
    assert.deepStrictEqual(close, { code: 1000, reason: 'Shutting down' })
    const res = await run.exited
    assert.strictEqual(res.code, 0)
    assert.ok(/still running after destroy/.test(run.out()))
    assert.strictEqual(prodman.log.filter(e => e.channel === 'agent:shutdown').length, 1)
  })

  it('process.exit() hands a best-effort packet to the socket', async () => {
    const run = await launch(prodman, 'exit-call')
    child = run.child
    prodman.send('trigger:action', { process_id: 0, action_name: 'go' })
    const res = await run.exited
    assert.strictEqual(res.code, 3)
    await prodman.closed()
    // best effort: when it arrives it is an unplanned crash (non-zero code), and only once
    const sent = prodman.log.filter(e => e.channel === 'agent:shutdown')
    assert.ok(sent.length <= 1)
    if (sent.length === 1) assert.deepStrictEqual([sent[0].payload.reason, sent[0].payload.planned], ['crash', false])
  })
})
