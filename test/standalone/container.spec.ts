import * as assert from 'assert'
import 'mocha'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import {
  SysRoot, detect, ContainerInfo, serviceFromPod, containerIdFromFiles, serverNameFor, expandName,
  Cgroup, Limits, containerValues, containerFsMounts, readNetDev, countCpuList, parseMountinfo,
  ContainerMetrics, V1_UNLIMITED
} from '../../src/utils/container'
import { ProdmanTransport } from '../../src/transports/ProdmanTransport'
import { FakeProdman } from './fakeProdman'

const ID = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const ID2 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const HOST = 'host-1'
const tmpRoots: string[] = []

/** a fixture sysroot: { '/proc/self/cgroup': '0::/\n', ... } (a trailing '/' makes a directory) */
function makeRoot (files: { [p: string]: string }): SysRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2io-sysroot-'))
  tmpRoots.push(dir)
  for (const p of Object.keys(files)) {
    const full = path.join(dir, p.replace(/^\/+/, ''))
    if (p.endsWith('/')) {
      mkdirp(full)
      continue
    }
    mkdirp(path.dirname(full))
    fs.writeFileSync(full, files[p])
  }
  return new SysRoot(dir)
}

function mkdirp (dir: string) {
  if (fs.existsSync(dir)) return
  mkdirp(path.dirname(dir))
  fs.mkdirSync(dir)
}

function rmrf (p: string) {
  if (!fs.existsSync(p)) return
  if (fs.statSync(p).isDirectory()) {
    fs.readdirSync(p).forEach(f => rmrf(path.join(p, f)))
    fs.rmdirSync(p)
  } else {
    fs.unlinkSync(p)
  }
}

const MOUNT_V2 = [
  `1590 1480 0:300 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w`,
  `1591 1590 0:301 / /proc rw,nosuid - proc proc rw`,
  `1595 1590 0:26 / /sys/fs/cgroup ro,nosuid - cgroup2 cgroup rw,nsdelegate`,
  `1600 1590 254:1 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw`,
  `1601 1590 254:1 /srv/data /data rw,relatime - ext4 /dev/vda1 rw`,
  `1602 1590 0:310 / /dev/shm rw - tmpfs shm rw`,
  `1603 1590 0:311 / /run/my\\040dir rw - tmpfs tmpfs rw`
].join('\n') + '\n'

/** cgroup v2, private namespace: 0.5 CPU quota on 4 cpus, 512 MiB */
function v2Root (extra: { [p: string]: string } = {}): SysRoot {
  return makeRoot(Object.assign({
    '/.dockerenv': '',
    '/proc/1/cgroup': '0::/\n',
    '/proc/self/cgroup': '0::/\n',
    '/proc/self/mountinfo': MOUNT_V2,
    '/proc/meminfo': 'MemTotal:       16384000 kB\nMemFree:  1000 kB\n',
    '/proc/net/dev': 'Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 1000000 10 1 2 0 0 0 0 2000000 20 3 4 0 0 0 0\n',
    '/sys/devices/system/cpu/online': '0-3\n',
    '/sys/fs/cgroup/cpu.max': '50000 100000\n',
    '/sys/fs/cgroup/cpu.stat': 'usage_usec 1000000\nuser_usec 800000\nsystem_usec 200000\nnr_periods 100\nnr_throttled 10\nthrottled_usec 5000\n',
    '/sys/fs/cgroup/cpuset.cpus.effective': '0-3\n',
    '/sys/fs/cgroup/memory.max': '536870912\n',
    '/sys/fs/cgroup/memory.current': '268435456\n',
    '/sys/fs/cgroup/memory.stat': 'anon 1000\nfile 2000\ninactive_file 67108864\nactive_file 10\n',
    '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n',
    '/sys/fs/cgroup/io.stat': '8:0 rbytes=1000000 wbytes=2000000 rios=1 wios=2\n8:16 rbytes=500 wbytes=0 rios=1 wios=0\n'
  }, extra))
}

/** cgroup v1 (Docker on an old host): 1.5 CPU quota, no memory limit, cpuset 0-1 */
function v1Root (): SysRoot {
  const cg = `/docker/${ID}`
  return makeRoot({
    '/proc/1/cgroup': `12:cpu,cpuacct:${cg}\n11:memory:${cg}\n10:cpuset:${cg}\n9:blkio:${cg}\n1:name=systemd:${cg}\n`,
    '/proc/self/cgroup': `12:cpu,cpuacct:${cg}\n11:memory:${cg}\n10:cpuset:${cg}\n9:blkio:${cg}\n1:name=systemd:${cg}\n`,
    '/proc/self/mountinfo': [
      `500 400 0:50 / / rw - overlay overlay rw`,
      `510 500 0:60 ${cg} /sys/fs/cgroup/cpu,cpuacct ro - cgroup cgroup rw,cpu,cpuacct`,
      `511 500 0:61 ${cg} /sys/fs/cgroup/memory ro - cgroup cgroup rw,memory`,
      `512 500 0:62 ${cg} /sys/fs/cgroup/cpuset ro - cgroup cgroup rw,cpuset`,
      `513 500 0:63 ${cg} /sys/fs/cgroup/blkio ro - cgroup cgroup rw,blkio`
    ].join('\n') + '\n',
    '/proc/meminfo': 'MemTotal: 8000000 kB\n',
    '/sys/devices/system/cpu/online': '0-7\n',
    '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '150000\n',
    '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000\n',
    '/sys/fs/cgroup/cpu,cpuacct/cpu.stat': 'nr_periods 50\nnr_throttled 5\nthrottled_time 100\n',
    '/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage': '5000000000\n',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '104857600\n',
    '/sys/fs/cgroup/memory/memory.stat': 'cache 1\ntotal_inactive_file 4857600\n',
    '/sys/fs/cgroup/memory/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 2\n',
    '/sys/fs/cgroup/cpuset/cpuset.effective_cpus': '0-1\n',
    '/sys/fs/cgroup/blkio/blkio.throttle.io_service_bytes': '8:0 Read 1000\n8:0 Write 2000\n8:0 Sync 3000\n8:0 Total 3000\nTotal 3000\n'
  })
}

after(() => tmpRoots.forEach(rmrf))

describe('containers: detection (CTR-001…003)', () => {
  const empty = () => makeRoot({ '/proc/': '' })

  it('an empty root with no hints is not a container', () => {
    assert.deepStrictEqual(detect({}, empty(), true), { inContainer: false, runtime: 'unknown', orchestrator: 'none' })
  })

  it('/.dockerenv → docker, /run/.containerenv → podman', () => {
    assert.deepStrictEqual(detect({}, makeRoot({ '/.dockerenv': '' }), true), { inContainer: true, runtime: 'docker', orchestrator: 'none' })
    assert.deepStrictEqual(detect({}, makeRoot({ '/run/.containerenv': '', '/.dockerenv': '' }), true).runtime, 'podman')
  })

  it('cgroup v1 paths: kubepods + containerd', () => {
    const root = makeRoot({ '/proc/1/cgroup': `11:memory:/kubepods/burstable/pod1/cri-containerd-${ID}\n` })
    assert.deepStrictEqual(detect({}, root, true), { inContainer: true, runtime: 'containerd', orchestrator: 'none' })
  })

  it('mountinfo: root or /etc/hostname from a container path', () => {
    const root = makeRoot({ '/proc/self/mountinfo': MOUNT_V2 })
    const d = detect({}, root, true)
    assert.strictEqual(d.inContainer, true)
    assert.strictEqual(d.runtime, 'unknown', 'a private cgroup namespace (0::/) names no runtime')
  })

  it('environment: ECS, Kubernetes, Compose and the overrides', () => {
    const root = empty()
    assert.strictEqual(detect({ ECS_CONTAINER_METADATA_URI_V4: 'http://x' }, root, true).orchestrator, 'ecs')
    assert.strictEqual(detect({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, root, true).orchestrator, 'kubernetes')
    assert.strictEqual(detect({ ECS_CONTAINER_METADATA_URI_V4: 'http://x', KUBERNETES_SERVICE_HOST: 'y' }, root, true).orchestrator, 'ecs')
    assert.strictEqual(detect({ PMX_CONTAINER: '1', COMPOSE_PROJECT_NAME: 'shop' }, root, true).orchestrator, 'compose')
    assert.strictEqual(detect({ PMX_CONTAINER: 'true', PMX_ORCHESTRATOR: 'k8s' }, root, true).orchestrator, 'kubernetes')
    assert.strictEqual(detect({ PMX_CONTAINER: '1', PMX_ORCHESTRATOR: 'compose' }, root, true).orchestrator, 'compose')
    assert.strictEqual(detect({ KUBERNETES_SERVICE_HOST: 'y', PMX_ORCHESTRATOR: 'none' }, root, true).orchestrator, 'none')
    // PMX_CONTAINER=0 wins over every hint
    assert.strictEqual(detect({ PMX_CONTAINER: 'false', KUBERNETES_SERVICE_HOST: 'y' }, makeRoot({ '/.dockerenv': '' }), true).inContainer, false)
  })

  it('non-Linux hosts are never containers unless PMX_CONTAINER=1', () => {
    const root = makeRoot({ '/.dockerenv': '' })
    assert.strictEqual(detect({ KUBERNETES_SERVICE_HOST: 'y' }, root, false).inContainer, false)
    assert.strictEqual(detect({ PMX_CONTAINER: '1' }, root, false).inContainer, true)
  })
})

describe('containers: identity and names (CTR-011…017, APM-083)', () => {
  it('strips Deployment, DaemonSet/Job and StatefulSet suffixes in that order', () => {
    assert.strictEqual(serviceFromPod('orders-api-7d9f8b6c5d-x2k4q'), 'orders-api')
    assert.strictEqual(serviceFromPod('node-exporter-x2k4q'), 'node', 'the Deployment rule is tried first')
    assert.strictEqual(serviceFromPod('fluentd-x2k4q'), 'fluentd')
    assert.strictEqual(serviceFromPod('postgres-0'), 'postgres')
    assert.strictEqual(serviceFromPod('standalone'), 'standalone')
  })

  it('container id from mountinfo, else the last 64-hex cgroup segment', () => {
    assert.strictEqual(containerIdFromFiles(MOUNT_V2, ''), ID)
    assert.strictEqual(containerIdFromFiles(`1 2 0:1 /docker/${ID2} /x rw - ext4 a rw`, ''), ID2)
    assert.strictEqual(containerIdFromFiles('', `0::/system.slice/docker-${ID}.scope\n1:cpu:/docker/${ID2}\n`), ID2)
    assert.strictEqual(containerIdFromFiles('', '0::/\n'), null)
  })

  it('Docker: <first app or COMPOSE_SERVICE>@<12-char container id>', () => {
    const root = v2Root()
    const info = ContainerInfo.detect({}, root, true)
    assert.strictEqual(info.inContainer(), true)
    assert.strictEqual(info.ephemeral(), true)
    assert.strictEqual(serverNameFor(info, 'orders', null, {}, HOST), `orders@${ID.slice(0, 12)}`)
    const compose = ContainerInfo.detect({ COMPOSE_PROJECT_NAME: 'shop', COMPOSE_SERVICE: 'web' }, root, true)
    assert.strictEqual(compose.detection.orchestrator, 'compose')
    assert.strictEqual(serverNameFor(compose, 'orders', null, {}, HOST), `web@${ID.slice(0, 12)}`)
    const pinned = ContainerInfo.detect({ PMX_EPHEMERAL: 'false' }, root, true)
    assert.strictEqual(pinned.ephemeral(), false)
  })

  it('Kubernetes: POD_NAME, else HOSTNAME; namespace from env or the service account file', () => {
    const root = makeRoot({ '/var/run/secrets/kubernetes.io/serviceaccount/namespace': 'shop\n', '/proc/self/cgroup': '0::/\n' })
    const env = { KUBERNETES_SERVICE_HOST: '10.0.0.1', POD_NAME: 'orders-api-7d9f8b6c5d-x2k4q', HOSTNAME: 'other' }
    const info = ContainerInfo.detect(env, root, true)
    const idn = info.identity('app', HOST)
    assert.strictEqual(idn.service, 'orders-api')
    assert.strictEqual(idn.instance, 'orders-api-7d9f8b6c5d-x2k4q')
    assert.strictEqual(idn.task, 'orders-api-7d9f8b6c5d-x2k4q')
    assert.strictEqual(idn.namespace, 'shop')
    const byHost = ContainerInfo.detect({ KUBERNETES_SERVICE_HOST: 'x', HOSTNAME: 'worker-0', POD_NAMESPACE: 'jobs', PMX_IMAGE: 'img:1' }, root, true)
    const b = byHost.block('app', HOST, new Limits(1, false, 1024))
    assert.deepStrictEqual(
      [b.service, b.instance, b.namespace, b.image, b.orchestrator, b.cluster, b.limits],
      ['worker', 'worker-0', 'jobs', 'img:1', 'kubernetes', null, { cpus: 1, memoryBytes: 1024 }]
    )
  })

  it('PMX_SERVICE_NAME / PMX_INSTANCE_NAME win', () => {
    const info = ContainerInfo.detect({ KUBERNETES_SERVICE_HOST: 'x', POD_NAME: 'a-0', PMX_SERVICE_NAME: 'svc', PMX_INSTANCE_NAME: 'i1' }, v2Root(), true)
    assert.strictEqual(serverNameFor(info, 'app', null, {}, HOST), 'svc@i1')
  })

  it('explicit names: apmOptions.serverName, then PM2_MACHINE_NAME, placeholders expanded, 200 chars', () => {
    const info = ContainerInfo.detect({ KUBERNETES_SERVICE_HOST: 'x', POD_NAME: 'orders-7d9f8b6c5d-x2k4q' }, v2Root(), true)
    assert.strictEqual(serverNameFor(info, 'app', null, { PM2_MACHINE_NAME: '{service}/{instance}/{hostname}/{container}/{task}' }, HOST),
      `orders/orders-7d9f8b6c5d-x2k4q/${HOST}/${ID.slice(0, 12)}/orders-7d9f8b6c5d-x2k4q`)
    assert.strictEqual(serverNameFor(info, 'app', 'opt-{service}', { PM2_MACHINE_NAME: 'env' }, HOST), 'opt-orders')
    const r = serverNameFor(info, 'app', 'x-{random}', {}, HOST)
    assert.ok(/^x-[0-9a-f]{4}$/.test(r))
    assert.strictEqual(serverNameFor(info, 'app', 'x-{random}', {}, HOST), r)
    assert.strictEqual(serverNameFor(info, 'app', '{service}-' + 'y'.repeat(300), {}, HOST).length, 200)
    const long = ContainerInfo.detect({ PMX_CONTAINER: '1', PMX_SERVICE_NAME: 's'.repeat(300) }, v2Root(), true)
    assert.strictEqual(serverNameFor(long, 'app', null, {}, HOST).length, 200)
    // outside containers: {service} = app, {instance}/{container}/{task} = host name
    const host = ContainerInfo.detect({ PMX_CONTAINER: '0' }, v2Root(), true)
    assert.strictEqual(serverNameFor(host, 'app', null, {}, HOST), `app@${HOST}`)
    assert.strictEqual(expandName('{service}:{instance}:{container}:{task}', host.nameContext('app', HOST)), `app:${HOST}:${HOST}:${HOST}`)
  })
})

describe('containers: cgroups and limits (CTR-030…033)', () => {
  it('cgroup v2: quota, cpuset, memory limit and the effective limits', () => {
    const root = v2Root()
    const cg = Cgroup.locate(root)!
    assert.strictEqual(cg.version, 2)
    assert.strictEqual(cg.cpuQuota(), 0.5)
    assert.strictEqual(cg.cpusetCount(), 4)
    assert.strictEqual(cg.memoryLimit(), 536870912)
    const lim = Limits.effective(cg, root, null, null, 16384000 * 1024)
    assert.deepStrictEqual(lim.toJSON(), { cpus: 0.5, memoryBytes: 536870912 })
    assert.strictEqual(lim.hasQuota, true)
    assert.strictEqual(lim.cpusRoundedUp(), 1)
  })

  it('cgroup v2 without limits: cpuset/online CPUs and the host memory', () => {
    const root = v2Root({ '/sys/fs/cgroup/cpu.max': 'max 100000\n', '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/cpuset.cpus.effective': '0-1,3\n' })
    const cg = Cgroup.locate(root)!
    assert.strictEqual(cg.cpuQuota(), null)
    assert.strictEqual(cg.memoryLimit(), null)
    const lim = Limits.effective(cg, root, null, null, 16384000 * 1024)
    assert.deepStrictEqual(lim.toJSON(), { cpus: 3, memoryBytes: 16384000 * 1024 })
    assert.strictEqual(lim.hasQuota, false)
  })

  it('ECS task-level limits apply when the cgroup shows none (Fargate)', () => {
    const root = v2Root({ '/sys/fs/cgroup/cpu.max': 'max 100000\n', '/sys/fs/cgroup/memory.max': 'max\n' })
    const lim = Limits.effective(Cgroup.locate(root), root, 0.25, 1024 * 1024 * 1024, 16384000 * 1024)
    assert.deepStrictEqual(lim.toJSON(), { cpus: 0.25, memoryBytes: 1073741824 })
    assert.strictEqual(lim.cpusRoundedUp(), 1)
  })

  it('cgroup v1: controllers from mountinfo, quota/period, unlimited memory, cpuset', () => {
    const root = v1Root()
    const cg = Cgroup.locate(root)!
    assert.strictEqual(cg.version, 1)
    assert.strictEqual(cg.cpuQuota(), 1.5)
    assert.strictEqual(cg.cpusetCount(), 2)
    assert.strictEqual(cg.memoryLimit(), null, `>= ${V1_UNLIMITED} is no limit`)
    const lim = Limits.effective(cg, root, null, null, 8000000 * 1024)
    assert.deepStrictEqual(lim.toJSON(), { cpus: 1.5, memoryBytes: 8192000000 })
    const s = cg.sample()
    assert.deepStrictEqual(s, {
      usageUsec: 5000000, nrPeriods: 50, nrThrottled: 5, memCurrent: 104857600, inactiveFile: 4857600, oomKill: 2, io: [1000, 2000]
    })
  })

  it('metric maths: CPU Usage, CPU Throttled, RAM, disk and OOM Kills', () => {
    const lim = new Limits(0.5, true, 536870912)
    const prev = { usageUsec: 1000000, nrPeriods: 100, nrThrottled: 10, memCurrent: 0, inactiveFile: 0, oomKill: 0, io: [1000000, 2000000] as [number, number] }
    const cur = { usageUsec: 1400000, nrPeriods: 120, nrThrottled: 15, memCurrent: 268435456, inactiveFile: 67108864, oomKill: 1, io: [3000000, 2500000] as [number, number] }
    const first = containerValues(lim, null, prev)
    assert.strictEqual(first['CPU Usage'].value, 0, 'no rate on the first sample')
    assert.strictEqual(first['CPU Throttled'].value, 0)
    const m = containerValues(lim, { sample: prev, dt: 1 }, cur)
    // 0.4 s of CPU in 1 s on 0.5 CPU = 80 %
    assert.strictEqual(m['CPU Usage'].value, 80)
    assert.strictEqual(m['CPU Usage'].unit, '%')
    assert.strictEqual(m['CPU Throttled'].value, 25)
    assert.strictEqual(m['RAM Total'].value, 536870912)
    assert.strictEqual(m['RAM Active'].value, 201326592)
    assert.strictEqual(m['RAM Available'].value, 335544320)
    assert.strictEqual(m['RAM Usage'].value, 37.5)
    assert.strictEqual(m['Disk Reads'].value, 2)
    assert.strictEqual(m['Disk Writes'].value, 0.5)
    assert.deepStrictEqual(m['OOM Kills'], { value: 1, type: 'metric', unit: '', historic: true })
    // capped at 100 %, and no CPU Throttled without a quota
    const busy = containerValues(new Limits(0.25, false, 1), { sample: prev, dt: 1 }, cur)
    assert.strictEqual(busy['CPU Usage'].value, 100)
    assert.strictEqual(busy['CPU Throttled'], undefined)
  })

  it('ContainerMetrics.collect samples the fixture cgroup, network and filesystems', () => {
    const root = v2Root()
    const info = ContainerInfo.detect({}, root, true)
    const cm = new ContainerMetrics(info)
    const lim = cm.limits()
    const first = cm.collect(lim, 100)
    assert.strictEqual(first['RAM Total'].value, 536870912)
    assert.strictEqual(first['OOM Kills'].value, 1)
    assert.strictEqual(first['net:rx_5:eth0'].value, 0)
    fs.writeFileSync(root.path('/sys/fs/cgroup/cpu.stat'), 'usage_usec 1250000\nnr_periods 110\nnr_throttled 12\n')
    fs.writeFileSync(root.path('/proc/net/dev'), 'a\nb\n  eth0: 3000000 10 1 2 0 0 0 0 2000000 20 3 4 0 0 0 0\n')
    const second = cm.collect(lim, 102)
    assert.strictEqual(second['CPU Usage'].value, 25) // 0.25 s over 2 s on 0.5 CPU
    assert.strictEqual(second['CPU Throttled'].value, 20)
    assert.strictEqual(second['net:rx_5:eth0'].value, 1) // 2 MB in 2 s
    assert.strictEqual(second['net:rx_errors_60:eth0'].value, 0)
    assert.strictEqual(second['CPU Temperature'], undefined)
  })

  it('parsers: cpu lists, mountinfo escapes, filesystems, /proc/net/dev', () => {
    assert.strictEqual(countCpuList('0-3,5,7-8'), 7)
    assert.strictEqual(countCpuList(''), null)
    assert.strictEqual(countCpuList('3-1'), null)
    assert.strictEqual(parseMountinfo(MOUNT_V2)[6].point, '/run/my dir')
    assert.deepStrictEqual(containerFsMounts(MOUNT_V2), ['/', '/etc/hostname', '/data'])
    const net = readNetDev(v2Root())
    assert.deepStrictEqual(net.eth0, [1000000, 2000000, 1, 3, 2, 4])
  })
})

// ------------------------------------------------------------------ ECS metadata (CTR-010) and the transport

/** ECS task metadata v4 endpoint */
class FakeEcs {
  server: http.Server
  port = 0
  requests: string[] = []
  hang = false

  start (): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.requests.push(req.url || '')
      if (this.hang) return // never answers: the 1 s timeout applies
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v4/abc/task') {
        return res.end(JSON.stringify({
          Cluster: 'arn:aws:ecs:eu-west-2:123:cluster/prod',
          TaskARN: 'arn:aws:ecs:eu-west-2:123:task/prod/3f2a9c1b7d0445e6a1b2c3d4e5f60718',
          Family: 'orders-task',
          Revision: '42',
          ServiceName: 'orders',
          AvailabilityZone: 'eu-west-2a',
          LaunchType: 'FARGATE',
          Limits: { CPU: 0.25, Memory: 1024 }
        }))
      }
      if (req.url === '/v4/abc') {
        return res.end(JSON.stringify({
          DockerId: '3f2a9c1b7d0445e6a1b2c3d4e5f60718-1234567890',
          Name: 'app',
          Image: '123.dkr.ecr.eu-west-2.amazonaws.com/orders:1.4.2',
          Limits: { CPU: 256, Memory: 1024 }
        }))
      }
      res.statusCode = 404
      res.end('{}')
    })
    return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => {
      this.port = (this.server.address() as any).port
      resolve()
    }))
  }

  uri () {
    return `http://127.0.0.1:${this.port}/v4/abc`
  }

  stop () {
    this.server.close()
  }
}

describe('containers: ECS metadata and the standalone transport (APM-082…084, APM-089)', function () {
  this.timeout(15000)
  const ecs = new FakeEcs()
  const saved = Object.assign({}, process.env)
  let prodman: FakeProdman
  let transport: ProdmanTransport | null = null

  before(async () => {
    await ecs.start()
  })

  beforeEach(async () => {
    prodman = new FakeProdman()
    await prodman.start()
    ecs.hang = false
  })

  afterEach(() => {
    if (transport) transport.destroy()
    transport = null
    prodman.stop()
    process.env = Object.assign({}, saved)
  })

  after(() => ecs.stop())

  it('reads both ECS documents: identity, task-level limits, metadata failures leave nulls', (done) => {
    const info = ContainerInfo.detect({ ECS_CONTAINER_METADATA_URI_V4: ecs.uri() }, v2Root({ '/sys/fs/cgroup/cpu.max': 'max 100000\n', '/sys/fs/cgroup/memory.max': 'max\n' }), true)
    assert.strictEqual(info.ecsPending(), true)
    info.fetchEcs(1000, (errors) => {
      assert.deepStrictEqual(errors, [])
      const idn = info.identity('app', HOST)
      assert.strictEqual(idn.service, 'orders')
      assert.strictEqual(idn.instance, '3f2a9c1b7d04')
      assert.strictEqual(idn.id, '3f2a9c1b7d0445e6a1b2c3d4e5f60718-1234567890', 'Fargate DockerId used unchanged')
      assert.strictEqual(idn.revision, '42')
      assert.strictEqual(serverNameFor(info, 'app', null, {}, HOST), 'orders@3f2a9c1b7d04')
      const lim = new ContainerMetrics(info).limits()
      assert.deepStrictEqual(lim.toJSON(), { cpus: 0.25, memoryBytes: 1073741824 })
      done()
    })
  })

  it('a silent metadata endpoint times out after 1 s and falls back', (done) => {
    ecs.hang = true
    const info = ContainerInfo.detect({ ECS_CONTAINER_METADATA_URI_V4: ecs.uri() }, v2Root(), true)
    const t0 = Date.now()
    info.fetchEcs(1000, (errors) => {
      const took = Date.now() - t0
      assert.ok(took >= 900 && took < 1500, `took ${took} ms`)
      assert.strictEqual(errors.length, 2)
      assert.strictEqual(info.identity('app', HOST).cluster, null)
      assert.strictEqual(serverNameFor(info, 'app', null, {}, HOST), `app@${ID.slice(0, 12)}`)
      done()
    })
  })

  const startTransport = (env: any) => {
    delete process.env.PM2_MACHINE_NAME
    Object.assign(process.env, env)
    transport = new ProdmanTransport()
    transport.init({ publicKey: 'pub', secretKey: 'sec', appName: 'orders-api', url: `http://127.0.0.1:${prodman.port}`, disableLogs: true })
  }

  it('in an ECS container: <service>@<task id>, the container block, ephemeral, effective limits', async () => {
    const root = v2Root()
    startTransport({ PMX_CONTAINER: '1', PMX_TEST_SYSROOT: root.root, ECS_CONTAINER_METADATA_URI_V4: ecs.uri() })
    const status = await prodman.channel('status')
    const hs = prodman.handshakes[0].data.data
    assert.strictEqual(hs.MACHINE_NAME, 'orders@3f2a9c1b7d04')
    assert.strictEqual(hs.MEMORY, 512, 'MiB of the effective memory')
    assert.strictEqual(hs.CPUS.length, 1)
    assert.strictEqual(prodman.upgrades[0]['x-km-server'], 'orders@3f2a9c1b7d04')
    const server = status.payload.data.server
    assert.strictEqual(status.payload.server_name, 'orders@3f2a9c1b7d04')
    assert.strictEqual(server.agent_kind, '@pm2/io')
    assert.strictEqual(server.ephemeral, true)
    assert.deepStrictEqual(server.container, {
      runtime: 'docker',
      orchestrator: 'ecs',
      id: '3f2a9c1b7d0445e6a1b2c3d4e5f60718-1234567890',
      name: 'app',
      image: '123.dkr.ecr.eu-west-2.amazonaws.com/orders:1.4.2',
      service: 'orders',
      instance: '3f2a9c1b7d04',
      task: 'arn:aws:ecs:eu-west-2:123:task/prod/3f2a9c1b7d0445e6a1b2c3d4e5f60718',
      cluster: 'arn:aws:ecs:eu-west-2:123:cluster/prod',
      namespace: null,
      revision: '42',
      zone: 'eu-west-2a',
      limits: { cpus: 0.25, memoryBytes: 536870912 }
    })
    assert.strictEqual(server.cpus, 1)
    assert.strictEqual(server.total_mem, 536870912)
    assert.strictEqual(server.system['RAM Total'].value, 536870912)
    assert.strictEqual(server.system['RAM Usage'].value, 37.5)
    assert.strictEqual(server.system['OOM Kills'].value, 1)
    assert.ok(server.system['CPU Throttled'], 'CPU Throttled with a quota')
    assert.ok(server.system['CPU Usage'])
  })

  it('a silent ECS endpoint delays the first handshake by at most 1.5 s', async () => {
    ecs.hang = true
    const t0 = Date.now()
    startTransport({ PMX_CONTAINER: '1', PMX_TEST_SYSROOT: v2Root().root, ECS_CONTAINER_METADATA_URI_V4: ecs.uri() })
    await prodman.channel('status')
    const took = Date.now() - t0
    assert.ok(took < 1600, `took ${took} ms`)
    assert.strictEqual(prodman.handshakes[0].data.data.MACHINE_NAME, `orders-api@${ID.slice(0, 12)}`)
  })

  it('outside a container: agent_kind, ephemeral false and no container block', async () => {
    startTransport({ PMX_CONTAINER: '0' })
    const status = await prodman.channel('status')
    const server = status.payload.data.server
    assert.strictEqual(server.agent_kind, '@pm2/io')
    assert.strictEqual(server.ephemeral, false)
    assert.ok(!('container' in server))
    assert.strictEqual(status.payload.server_name, `orders-api@${os.hostname()}`)
  })
})
