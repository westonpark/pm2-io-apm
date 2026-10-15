/**
 * prodman: running in containers (pmx specs/95-containers.md §1–§4, prodman 11 APM-080…084) for
 * the standalone mode: detection (CTR-001…003), identity and metadata (CTR-010…017), the
 * effective limits (CTR-031) and the container-aware server metrics (CTR-030…033).
 *
 * The Node twin of pmx's Rust `pmx_core::container` and Python `pmx_io._container`: same
 * detection order, same names and the same metric maths. Every host file is read through a
 * `SysRoot`, so tests point `/proc`, `/sys`, `/run`, `/var/run` and `/.dockerenv` at a fixture
 * tree (env `PMX_TEST_SYSROOT`, as in pmx). Uses only `fs`, `os`, `path` and `http` (APM-080).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import * as crypto from 'crypto'

export const MAX_NAME_LEN = 200 // CTR-015

export type Env = { [key: string]: string | undefined }

/** where host files are read from (`/` in production) */
export class SysRoot {
  root: string

  constructor (root?: string) {
    this.root = root || '/'
  }

  static host (env: Env = process.env): SysRoot {
    return new SysRoot(env.PMX_TEST_SYSROOT || '/')
  }

  path (abs: string): string {
    if (this.root === '/') return abs
    return path.join(this.root, abs.replace(/^\/+/, ''))
  }

  read (abs: string): string | null {
    try {
      return fs.readFileSync(this.path(abs), 'utf8')
    } catch (e) {
      return null
    }
  }

  exists (abs: string): boolean {
    try {
      fs.statSync(this.path(abs))
      return true
    } catch (e) {
      return false
    }
  }
}

/** `1`/`true` → true, `0`/`false` → false, anything else → null */
export function envFlag (v: string | undefined | null): boolean | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim().toLowerCase()
  if (s === '1' || s === 'true') return true
  if (s === '0' || s === 'false') return false
  return null
}

function set (env: Env, k: string): string | null {
  const v = env[k]
  return v ? v : null
}

// ------------------------------------------------------------------ detection (CTR-001…003)

const MOUNT_HINTS = ['/docker/containers/', '/containers/', '/kubelet/pods/']
const CGROUP_HINTS = ['docker', 'kubepods', 'containerd', 'libpod', 'ecs']
const ORCHESTRATORS: { [k: string]: string } = { ecs: 'ecs', kubernetes: 'kubernetes', k8s: 'kubernetes', compose: 'compose', none: 'none' }

function lines (text: string): string[] {
  return text.split(/\r?\n/).filter(l => l.length > 0)
}

function fields (line: string): string[] {
  return line.trim().split(/\s+/).filter(f => f.length > 0)
}

export function mountinfoHint (text: string): boolean {
  return lines(text).some(line => {
    const f = fields(line)
    return f.length > 4 && (f[4] === '/' || f[4] === '/etc/hostname') && MOUNT_HINTS.some(h => line.indexOf(h) > -1)
  })
}

function cgroupPaths (text: string): string[] {
  const out: string[] = []
  for (const line of lines(text)) {
    const a = line.indexOf(':')
    const b = a < 0 ? -1 : line.indexOf(':', a + 1)
    if (b < 0) continue
    const p = line.slice(b + 1)
    if (p) out.push(p)
  }
  return out
}

export function cgroupHint (text: string): boolean {
  return cgroupPaths(text).some(p => CGROUP_HINTS.some(h => p.indexOf(h) > -1))
}

export interface Detection {
  inContainer: boolean
  runtime: string
  orchestrator: string
}

export function detect (env: Env, root: SysRoot, linux: boolean): Detection {
  const dockerenv = root.exists('/.dockerenv')
  const containerenv = root.exists('/run/.containerenv')
  const cgroup1 = root.read('/proc/1/cgroup') || ''
  const cgroupSelf = root.read('/proc/self/cgroup') || ''
  const forced = envFlag(env.PMX_CONTAINER)
  let inside: boolean
  if (forced !== null) {
    inside = forced
  } else {
    inside = linux && (
      dockerenv ||
      containerenv ||
      set(env, 'KUBERNETES_SERVICE_HOST') !== null ||
      set(env, 'ECS_CONTAINER_METADATA_URI_V4') !== null ||
      mountinfoHint(root.read('/proc/self/mountinfo') || '') ||
      cgroupHint(cgroup1)
    )
  }
  if (!inside) return { inContainer: false, runtime: 'unknown', orchestrator: 'none' }
  const paths = cgroupPaths(cgroup1).concat(cgroupPaths(cgroupSelf))
  const mentions = (w: string) => paths.some(p => p.indexOf(w) > -1)
  let runtime = 'unknown'
  if (containerenv) runtime = 'podman'
  else if (dockerenv || mentions('docker')) runtime = 'docker'
  else if (mentions('containerd')) runtime = 'containerd'
  let orch: string | undefined = ORCHESTRATORS[(env.PMX_ORCHESTRATOR || '').trim().toLowerCase()]
  if (orch === undefined) {
    if (set(env, 'ECS_CONTAINER_METADATA_URI_V4')) orch = 'ecs'
    else if (set(env, 'KUBERNETES_SERVICE_HOST')) orch = 'kubernetes'
    else if (set(env, 'COMPOSE_PROJECT_NAME')) orch = 'compose'
    else orch = 'none'
  }
  return { inContainer: true, runtime, orchestrator: orch }
}

// ------------------------------------------------------------------ identity (CTR-010…017)

const HEX64 = /[0-9a-f]{64}/g
const MOUNT_ID = /\/containers\/([0-9a-f]{64})\/|\/docker\/([0-9a-f]{64})/
const POD_SUFFIXES = [
  /-[a-z0-9]{6,10}-[a-z0-9]{5}$/, // Deployment
  /-[a-z0-9]{5}$/, // DaemonSet / Job
  /-[0-9]+$/ // StatefulSet
]

/**
 * CTR-012: a `/containers/<64 hex>/` or `/docker/<64 hex>` segment of mountinfo, else the last
 * 64-hex segment of `/proc/self/cgroup`
 */
export function containerIdFromFiles (mountinfo: string, cgroup: string): string | null {
  for (const line of lines(mountinfo)) {
    const m = MOUNT_ID.exec(line)
    if (m) return m[1] || m[2]
  }
  const found = cgroup.match(HEX64)
  return found && found.length > 0 ? found[found.length - 1] : null
}

/** CTR-013: strip a Deployment, DaemonSet/Job or StatefulSet suffix (tried in that order) */
export function serviceFromPod (pod: string): string {
  for (const rx of POD_SUFFIXES) {
    const m = rx.exec(pod)
    if (m && m.index > 0) return pod.slice(0, m.index)
  }
  return pod
}

export function hostname (): string {
  try {
    return os.hostname() || 'localhost'
  } catch (e) {
    return 'localhost'
  }
}

let RANDOM: string | null = null

/** the `{random}` placeholder: 4 lowercase hex, drawn once per process start (CTR-015) */
export function processRandom (): string {
  if (RANDOM === null) RANDOM = crypto.randomBytes(2).toString('hex')
  return RANDOM
}

export function truncateName (s: string): string {
  return s.slice(0, MAX_NAME_LEN)
}

function str (v: any): string | null {
  if (typeof v === 'string' && v) return v
  if (typeof v === 'number' && isFinite(v)) return String(v)
  return null
}

function flt (v: any): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return isFinite(n) ? n : null
  }
  return null
}

/** the two ECS task metadata v4 documents (CTR-010); null = not fetched or failed */
export class EcsMetadata {
  task: any
  container: any

  constructor (task?: any, container?: any) {
    this.task = task && typeof task === 'object' && !Array.isArray(task) ? task : null
    this.container = container && typeof container === 'object' && !Array.isArray(container) ? container : null
  }

  private t (k: string): any { return this.task ? this.task[k] : null }
  private c (k: string): any { return this.container ? this.container[k] : null }

  cluster () { return str(this.t('Cluster')) }
  taskArn () { return str(this.t('TaskARN')) }
  taskId (): string | null {
    const arn = this.taskArn()
    if (!arn) return null
    const id = arn.slice(arn.lastIndexOf('/') + 1)
    return id || null
  }
  family () { return str(this.t('Family')) }
  revision () { return str(this.t('Revision')) }
  serviceName () { return str(this.t('ServiceName')) }
  zone () { return str(this.t('AvailabilityZone')) }
  /** task-level `Limits.CPU` (vCPUs, may be fractional) */
  taskCpus (): number | null {
    const lim = this.t('Limits')
    const v = lim && typeof lim === 'object' ? flt(lim.CPU) : null
    return v !== null && v > 0 ? v : null
  }
  /** task-level `Limits.Memory` (MiB) in bytes */
  taskMemoryBytes (): number | null {
    const lim = this.t('Limits')
    const v = lim && typeof lim === 'object' ? flt(lim.Memory) : null
    return v !== null && v > 0 ? Math.floor(v * 1024 * 1024) : null
  }
  dockerId () { return str(this.c('DockerId')) }
  containerName () { return str(this.c('Name')) }
  image () { return str(this.c('Image')) }
}

/** one GET with a hard timeout (connect + body), no retries */
export function httpGetJson (url: string, timeoutMs: number, cb: (err: Error | null, doc?: any) => void) {
  let done = false
  const finish = (failure: Error | null, doc?: any) => {
    if (done) return
    done = true
    clearTimeout(timer)
    cb(failure, doc)
  }
  let req: any
  const timer = setTimeout(() => {
    finish(new Error('timed out'))
    try { req.destroy() } catch (e) { /* gone */ }
  }, timeoutMs)
  if (timer && typeof (timer as any).unref === 'function') (timer as any).unref()
  try {
    if (!/^http:\/\//i.test(url)) throw new Error('unsupported URL')
    req = http.get(url, { headers: { Accept: 'application/json' } } as any, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('error', (e) => finish(e))
      res.on('end', () => {
        const code = res.statusCode || 0
        if (code < 200 || code >= 300) return finish(new Error(`HTTP ${code}`))
        let doc: any
        try { doc = JSON.parse(text) } catch (e) { return finish(new Error('invalid JSON')) }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return finish(new Error('invalid JSON'))
        finish(null, doc)
      })
    })
    req.on('error', (e) => finish(e))
    req.on('socket', (s) => { if (s && typeof s.unref === 'function') s.unref() })
  } catch (e) {
    finish(e)
  }
}

/** CTR-010: both documents in parallel, 1 s timeout each, no retries; errors are returned */
export function fetchEcs (base: string, timeoutMs: number, cb: (meta: EcsMetadata, errors: string[]) => void) {
  const root = base.replace(/\/+$/, '')
  const errors: string[] = []
  const docs: any = {}
  let pending = 2
  const one = (key: string, url: string) => httpGetJson(url, timeoutMs, (failure, doc) => {
    if (failure) errors.push(`ECS metadata ${url}: ${failure.message}`)
    else docs[key] = doc
    if (--pending === 0) cb(new EcsMetadata(docs.task, docs.container), errors)
  })
  one('task', root + '/task')
  one('container', root)
}

export interface Identity {
  id: string | null
  shortId: string | null
  name: string | null
  image: string | null
  service: string
  instance: string
  task: string | null
  taskShort: string | null
  cluster: string | null
  namespace: string | null
  revision: string | null
  zone: string | null
  hostname: string
}

export interface NameContext {
  service: string
  instance: string
  hostname: string
  container: string
  task: string
  random: string
}

/** detection plus metadata for this process (CTR-001…017) */
export class ContainerInfo {
  detection: Detection
  ecs: EcsMetadata = new EcsMetadata()
  root: SysRoot
  env: Env
  ecsUri: string | null = null
  errors: string[] = []
  private cachedId: string | null | undefined = undefined

  constructor (detection: Detection, root: SysRoot, env: Env) {
    this.detection = detection
    this.root = root
    // keep a copy: identity must not change if the app edits process.env later
    this.env = {}
    for (const k of ['PMX_SERVICE_NAME', 'PMX_INSTANCE_NAME', 'PMX_IMAGE', 'PMX_EPHEMERAL', 'POD_NAME', 'HOSTNAME', 'POD_NAMESPACE', 'COMPOSE_SERVICE']) {
      if (env[k] !== undefined) this.env[k] = env[k]
    }
  }

  /** detection only; on ECS the metadata is left to `fetchEcs()` (it must never block the app) */
  static detect (env: Env = process.env, root: SysRoot = SysRoot.host(env), linux: boolean = process.platform === 'linux'): ContainerInfo {
    const info = new ContainerInfo(detect(env, root, linux), root, env)
    const uri = set(env, 'ECS_CONTAINER_METADATA_URI_V4')
    if (info.detection.inContainer && uri) info.ecsUri = uri
    return info
  }

  ecsPending (): boolean {
    return this.ecsUri !== null
  }

  /** CTR-010, asynchronously; `cb` runs once both requests ended (≤ ~timeout) */
  fetchEcs (timeoutMs: number, cb: (errors: string[]) => void) {
    const uri = this.ecsUri
    this.ecsUri = null
    if (!uri) return cb([])
    fetchEcs(uri, timeoutMs, (meta, errors) => {
      this.ecs = meta
      this.errors = errors
      this.cachedId = undefined
      cb(errors)
    })
  }

  inContainer (): boolean {
    return this.detection.inContainer
  }

  private e (k: string): string | null {
    const v = this.env[k]
    return v ? v : null
  }

  /** CTR-017: in a container unless `PMX_EPHEMERAL=0`/`false` */
  ephemeral (): boolean {
    return this.inContainer() && envFlag(this.e('PMX_EPHEMERAL')) !== false
  }

  podName (): string | null {
    if (this.detection.orchestrator !== 'kubernetes') return null
    return this.e('POD_NAME') || this.e('HOSTNAME')
  }

  private containerId (): string | null {
    const docker = this.ecs.dockerId()
    if (docker) return docker
    if (!this.inContainer()) return null
    if (this.cachedId === undefined) {
      this.cachedId = containerIdFromFiles(this.root.read('/proc/self/mountinfo') || '', this.root.read('/proc/self/cgroup') || '')
    }
    return this.cachedId
  }

  identity (appName: string | null, host: string): Identity {
    const ecs = this.ecs
    const pod = this.podName()
    const cid = this.containerId()
    const short = cid ? cid.slice(0, 12) : null
    const service = this.e('PMX_SERVICE_NAME') ||
      ecs.serviceName() ||
      ecs.family() ||
      (pod ? serviceFromPod(pod) : null) ||
      this.e('COMPOSE_SERVICE') ||
      appName ||
      host
    const taskId = ecs.taskId()
    const instance = this.e('PMX_INSTANCE_NAME') || (taskId ? taskId.slice(0, 12) : null) || pod || short || host
    let namespace: string | null = null
    if (this.detection.orchestrator === 'kubernetes') {
      namespace = this.e('POD_NAMESPACE')
      if (namespace === null) {
        const ns = (this.root.read('/var/run/secrets/kubernetes.io/serviceaccount/namespace') || '').trim()
        namespace = ns || null
      }
    }
    return {
      id: cid,
      shortId: short,
      name: ecs.containerName(),
      image: ecs.image() || this.e('PMX_IMAGE'),
      service,
      instance,
      task: ecs.taskArn() || pod,
      taskShort: taskId || pod,
      cluster: ecs.cluster(),
      namespace,
      revision: ecs.revision(),
      zone: ecs.zone(),
      hostname: host
    }
  }

  /**
   * CTR-015 placeholder values; outside containers `{service}` is the app name (else the host
   * name) and `{instance}`, `{container}`, `{task}` the host name
   */
  nameContext (appName: string | null, host: string): NameContext {
    if (!this.inContainer()) {
      return { service: appName || host, instance: host, hostname: host, container: host, task: host, random: processRandom() }
    }
    const idn = this.identity(appName, host)
    return {
      service: idn.service,
      instance: idn.instance,
      hostname: host,
      container: idn.shortId || host,
      task: idn.taskShort || idn.instance,
      random: processRandom()
    }
  }

  /** `<service>@<instance>` in a container (CTR-015); null outside */
  defaultMachineName (appName: string | null, host: string): string | null {
    if (!this.inContainer()) return null
    const idn = this.identity(appName, host)
    return truncateName(`${idn.service}@${idn.instance}`)
  }

  cgroup (): Cgroup | null {
    return Cgroup.locate(this.root)
  }

  /** the `container` block of `status.data.server` (CTR-021) */
  block (appName: string | null, host: string, limits: Limits): any {
    const idn = this.identity(appName, host)
    return {
      runtime: this.detection.runtime,
      orchestrator: this.detection.orchestrator,
      id: idn.id,
      name: idn.name,
      image: idn.image,
      service: idn.service,
      instance: idn.instance,
      task: idn.task,
      cluster: idn.cluster,
      namespace: idn.namespace,
      revision: idn.revision,
      zone: idn.zone,
      limits: limits.toJSON()
    }
  }
}

/** expands the CTR-015 placeholders and truncates to 200 characters */
export function expandName (name: string, ctx: NameContext): string {
  let out = name
  for (const k of ['service', 'instance', 'hostname', 'container', 'task', 'random']) {
    out = out.split(`{${k}}`).join(ctx[k] || '')
  }
  return truncateName(out)
}

/**
 * APM-083 / CTR-015 Mode S: `apmOptions.serverName`, then `PM2_MACHINE_NAME` (placeholders
 * expanded); else `<service>@<instance>` in a container and `<appName>@<hostname>` outside
 */
export function serverNameFor (info: ContainerInfo, appName: string, explicit?: string | null, env: Env = process.env, host: string = hostname()): string {
  const name = explicit || env.PM2_MACHINE_NAME
  if (name) return expandName(name, info.nameContext(appName, host))
  return info.defaultMachineName(appName, host) || truncateName(`${appName}@${host}`)
}

// ------------------------------------------------------------------ cgroup (CTR-030)

function unescapeMount (s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
}

export interface Mount { root: string, point: string, fstype: string, source: string, superOpts: string }

export function parseMountinfo (text: string): Mount[] {
  const out: Mount[] = []
  for (const line of lines(text)) {
    const i = line.indexOf(' - ')
    if (i < 0) continue
    const f = fields(line.slice(0, i))
    const p = fields(line.slice(i + 3))
    if (f.length < 5 || p.length === 0) continue
    out.push({
      root: unescapeMount(f[3]),
      point: unescapeMount(f[4]),
      fstype: p[0],
      source: p.length > 1 ? unescapeMount(p[1]) : '',
      superOpts: p.length > 2 ? p[2] : ''
    })
  }
  return out
}

/** CPUs in a list such as `0-3,5` (null when unparsable or empty) */
export function countCpuList (s: string): number | null {
  s = s.trim()
  if (!s) return null
  let n = 0
  for (let part of s.split(',')) {
    part = part.trim()
    if (part.indexOf('-') > -1) {
      const [a, b] = part.split('-', 2)
      if (!/^\d+$/.test(a.trim()) || !/^\d+$/.test(b.trim())) return null
      const lo = parseInt(a, 10)
      const hi = parseInt(b, 10)
      if (hi < lo) return null
      n += hi - lo + 1
    } else {
      if (!/^\d+$/.test(part)) return null
      n += 1
    }
  }
  return n
}

export function kv (text: string | null, key: string): number | null {
  if (text === null) return null
  for (const line of lines(text)) {
    const p = fields(line)
    if (p.length >= 2 && p[0] === key) {
      return /^-?\d+$/.test(p[1]) ? parseInt(p[1], 10) : null
    }
  }
  return null
}

function int (s: string): number {
  return /^\d+$/.test(s) ? parseInt(s, 10) : 0
}

export function parseIoStat (text: string): [number, number] {
  let r = 0
  let w = 0
  for (const line of lines(text)) {
    for (const tok of fields(line).slice(1)) {
      if (tok.indexOf('rbytes=') === 0) r += int(tok.slice(7))
      else if (tok.indexOf('wbytes=') === 0) w += int(tok.slice(7))
    }
  }
  return [r, w]
}

export function parseBlkio (text: string): [number, number] {
  let r = 0
  let w = 0
  for (const line of lines(text)) {
    const f = fields(line)
    if (f.length === 3) {
      if (f[1] === 'Read') r += int(f[2])
      else if (f[1] === 'Write') w += int(f[2])
    }
  }
  return [r, w]
}

function readFile (p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    return null
  }
}

function isDir (p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch (e) {
    return false
  }
}

function optInt (t: string | null): number | null {
  if (t === null) return null
  const s = t.trim()
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null
}

/** v1 `memory.limit_in_bytes` at or above this means "no limit" */
export const V1_UNLIMITED = Math.pow(2, 60)
const V1_CONTROLLERS = ['cpu', 'cpuacct', 'cpuset', 'memory', 'blkio']

export interface CgroupSample {
  usageUsec: number | null
  nrPeriods: number | null
  nrThrottled: number | null
  memCurrent: number | null
  inactiveFile: number | null
  oomKill: number | null
  io: [number, number] | null
}

/** the cgroup of this process: v2 directory, or v1 `controller → directory` */
export class Cgroup {
  version: 1 | 2
  v2: string | null
  v1: { [controller: string]: string }

  constructor (version: 1 | 2, v2?: string | null, v1?: { [controller: string]: string }) {
    this.version = version
    this.v2 = v2 || null
    this.v1 = v1 || {}
  }

  static locate (root: SysRoot): Cgroup | null {
    const text = root.read('/proc/self/cgroup')
    if (text === null) return null
    const mounts = parseMountinfo(root.read('/proc/self/mountinfo') || '')
    const v1: { [c: string]: string } = {}
    let v2Path: string | null = null
    for (const line of lines(text)) {
      const a = line.indexOf(':')
      const b = a < 0 ? -1 : line.indexOf(':', a + 1)
      if (b < 0) continue
      const ctrls = line.slice(a + 1, b)
      const p = line.slice(b + 1)
      if (!ctrls) {
        v2Path = p
        continue
      }
      for (const c of ctrls.split(',')) {
        if (V1_CONTROLLERS.indexOf(c) < 0 || v1[c] !== undefined) continue
        const mount = mounts.find(m => m.fstype === 'cgroup' && m.superOpts.split(',').indexOf(c) > -1)
        let rel = p
        let base: string
        if (mount) {
          if (mount.root !== '/' && p.indexOf(mount.root) === 0) rel = p.slice(mount.root.length)
          base = root.path(mount.point)
        } else {
          base = root.path(`/sys/fs/cgroup/${c}`)
        }
        const joined = path.join(base, rel.replace(/^\/+/, ''))
        v1[c] = isDir(joined) ? joined : base
      }
    }
    if (Object.keys(v1).length > 0) return new Cgroup(1, null, v1)
    if (v2Path === null) return null
    const mount = mounts.find(m => m.fstype === 'cgroup2')
    const point = mount ? mount.point : '/sys/fs/cgroup'
    const mroot = mount ? mount.root : '/'
    let rel = v2Path
    if (mroot !== '/' && rel.indexOf(mroot) === 0) rel = rel.slice(mroot.length)
    const base = root.path(point)
    const joined = path.join(base, rel.replace(/^\/+/, ''))
    return new Cgroup(2, isDir(joined) ? joined : base)
  }

  private r1 (controller: string, name: string): string | null {
    const d = this.v1[controller]
    return d ? readFile(path.join(d, name)) : null
  }

  private r2 (name: string): string | null {
    if (this.version !== 2 || !this.v2) return null
    return readFile(path.join(this.v2, name))
  }

  /** CPUs allowed by the quota (`quota / period`); null without a quota */
  cpuQuota (): number | null {
    let q: number
    let p: number
    if (this.version === 2) {
      const t = this.r2('cpu.max')
      if (t === null) return null
      const parts = fields(t)
      if (parts.length < 2 || parts[0] === 'max') return null
      q = Number(parts[0])
      p = Number(parts[1])
    } else {
      const tq = optInt(this.r1('cpu', 'cpu.cfs_quota_us'))
      const tp = optInt(this.r1('cpu', 'cpu.cfs_period_us'))
      if (tq === null || tp === null || tq <= 0) return null
      q = tq
      p = tp
    }
    if (!isFinite(q) || !isFinite(p)) return null
    return q > 0 && p > 0 ? q / p : null
  }

  cpusetCount (): number | null {
    const t = this.version === 2
      ? this.r2('cpuset.cpus.effective')
      : (this.r1('cpuset', 'cpuset.effective_cpus') || this.r1('cpuset', 'cpuset.cpus'))
    return t !== null ? countCpuList(t) : null
  }

  memoryLimit (): number | null {
    if (this.version === 2) {
      const t = this.r2('memory.max')
      if (t === null || t.trim() === 'max') return null
      return optInt(t)
    }
    const v = optInt(this.r1('memory', 'memory.limit_in_bytes'))
    return v !== null && v < V1_UNLIMITED ? v : null
  }

  /** every counter (missing files → null) */
  sample (): CgroupSample {
    if (this.version === 2) {
      const cpu = this.r2('cpu.stat') || ''
      const stat = this.r2('memory.stat')
      const ev = this.r2('memory.events')
      const io = this.r2('io.stat')
      return {
        usageUsec: kv(cpu, 'usage_usec'),
        nrPeriods: kv(cpu, 'nr_periods'),
        nrThrottled: kv(cpu, 'nr_throttled'),
        memCurrent: optInt(this.r2('memory.current')),
        inactiveFile: kv(stat, 'inactive_file'),
        oomKill: kv(ev, 'oom_kill'),
        io: io !== null ? parseIoStat(io) : null
      }
    }
    const cpu = this.r1('cpu', 'cpu.stat') || ''
    const usage = optInt(this.r1('cpuacct', 'cpuacct.usage'))
    const stat = this.r1('memory', 'memory.stat')
    const oom = this.r1('memory', 'memory.oom_control')
    const blk = this.r1('blkio', 'blkio.throttle.io_service_bytes') || this.r1('blkio', 'blkio.throttle.io_service_bytes_recursive')
    return {
      usageUsec: usage !== null ? Math.floor(usage / 1000) : null,
      nrPeriods: kv(cpu, 'nr_periods'),
      nrThrottled: kv(cpu, 'nr_throttled'),
      memCurrent: optInt(this.r1('memory', 'memory.usage_in_bytes')),
      inactiveFile: kv(stat, 'total_inactive_file'),
      oomKill: kv(oom, 'oom_kill'),
      io: blk !== null ? parseBlkio(blk) : null
    }
  }
}

export function onlineCpus (root: SysRoot): number {
  const t = root.read('/sys/devices/system/cpu/online')
  const n = t !== null ? countCpuList(t) : null
  if (n) return n
  const cpus = os.cpus()
  return cpus && cpus.length > 0 ? cpus.length : 1
}

export function readMeminfo (root: SysRoot): { [k: string]: number } {
  const out: { [k: string]: number } = {}
  for (const line of lines(root.read('/proc/meminfo') || '')) {
    const p = fields(line)
    if (p.length >= 2 && p[0].charAt(p[0].length - 1) === ':' && /^\d+$/.test(p[1])) {
      out[p[0].slice(0, -1)] = parseInt(p[1], 10) * (p.length > 2 && p[2] === 'kB' ? 1024 : 1)
    }
  }
  return out
}

export function hostTotalMemory (root: SysRoot): number {
  const mi = readMeminfo(root)
  return mi.MemTotal || os.totalmem()
}

/** effective CPU and memory limits (CTR-031) */
export class Limits {
  constructor (public cpus: number, public hasQuota: boolean, public memoryBytes: number) {}

  static effective (cg: Cgroup | null, root: SysRoot, ecsCpus: number | null, ecsMem: number | null, hostTotal: number): Limits {
    const online = onlineCpus(root)
    const quota = cg ? cg.cpuQuota() : null
    const cpuset = cg ? cg.cpusetCount() : null
    const cands: number[] = []
    for (const c of [quota, ecsCpus !== null && ecsCpus > 0 ? ecsCpus : null, cpuset, online]) if (c !== null) cands.push(c)
    const cpus = cands.length > 0 ? Math.min.apply(null, cands) : online
    const mems: number[] = []
    for (const m of [cg ? cg.memoryLimit() : null, ecsMem !== null && ecsMem > 0 ? ecsMem : null, hostTotal > 0 ? hostTotal : null]) if (m !== null) mems.push(m)
    const mem = mems.length > 0 ? Math.min.apply(null, mems) : hostTotal
    return new Limits(cpus, quota !== null, mem)
  }

  toJSON () {
    return { cpus: this.cpus, memoryBytes: this.memoryBytes }
  }

  cpusRoundedUp (): number {
    return Math.max(1, Math.ceil(this.cpus))
  }
}

// ------------------------------------------------------------------ metrics (CTR-032/033)

export function metric (value: any, unit: string) {
  return { value, type: 'metric', unit, historic: true }
}

function round (v: number, d: number): number {
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

/**
 * the cgroup-derived values of a container snapshot (CTR-031…033). `prev` is the previous
 * sample and the seconds since it (null on the first snapshot: rates are 0)
 */
export function containerValues (limits: Limits, prev: { sample: CgroupSample, dt: number } | null, cur: CgroupSample): any {
  const out: any = {}
  const dt = prev ? prev.dt : 0
  const p = prev ? prev.sample : null
  const delta = (key: string): { has: boolean, d: number | null } => {
    const c = cur[key]
    if (c === null || c === undefined) return { has: false, d: null }
    if (!p || dt <= 0 || p[key] === null || p[key] === undefined) return { has: true, d: null }
    return { has: true, d: Math.max(0, c - p[key]) }
  }
  const usage = delta('usageUsec')
  if (usage.has) {
    let pct = 0
    if (usage.d !== null && dt > 0 && limits.cpus > 0) {
      pct = Math.min(100, Math.max(0, usage.d / (dt * 1e6 * limits.cpus) * 100))
    }
    out['CPU Usage'] = metric(round(pct, 1), '%')
  }
  if (limits.hasQuota) {
    const per = delta('nrPeriods')
    const thr = delta('nrThrottled')
    if (per.has && thr.has) {
      let pct = 0
      if (per.d !== null && thr.d !== null && per.d > 0) pct = Math.min(100, thr.d / per.d * 100)
      out['CPU Throttled'] = metric(round(pct, 1), '%')
    }
  }
  const total = limits.memoryBytes
  if (cur.memCurrent !== null) {
    const active = Math.max(0, cur.memCurrent - (cur.inactiveFile || 0))
    out['RAM Usage'] = metric(total > 0 ? round(active / total * 100, 1) : 0, '%')
    out['RAM Total'] = metric(total, 'b')
    out['RAM Available'] = metric(Math.max(0, total - active), 'b')
    out['RAM Active'] = metric(active, 'b')
  } else if (total > 0) {
    out['RAM Total'] = metric(total, 'b')
  }
  if (cur.io !== null) {
    let rr = 0
    let wr = 0
    if (p && dt > 0 && p.io !== null) {
      rr = Math.max(0, cur.io[0] - p.io[0]) / dt
      wr = Math.max(0, cur.io[1] - p.io[1]) / dt
    }
    out['Disk Reads'] = metric(round(rr / 1e6, 3), 'mb/s')
    out['Disk Writes'] = metric(round(wr / 1e6, 3), 'mb/s')
  }
  if (cur.oomKill !== null) out['OOM Kills'] = metric(cur.oomKill, '')
  return out
}

const PSEUDO_FS = ['proc', 'sysfs', 'tmpfs', 'devtmpfs', 'mqueue', 'devpts', 'securityfs', 'debugfs', 'tracefs',
  'pstore', 'bpf', 'fusectl', 'configfs', 'hugetlbfs', 'autofs', 'binfmt_misc', 'nsfs', 'ramfs', 'rpc_pipefs',
  'efivarfs', 'selinuxfs']

/**
 * CTR-032: `/` and bind or volume mounts — not pseudo filesystems, `cgroup*` or `overlay` other
 * than `/`, nothing under `/proc`, `/sys` or `/dev`
 */
export function containerFsMounts (mountinfo: string): string[] {
  const out: string[] = []
  for (const m of parseMountinfo(mountinfo)) {
    const pt = m.point
    let keep: boolean
    if (pt === '/') {
      keep = true
    } else {
      const fsType = m.fstype
      keep = !(PSEUDO_FS.indexOf(fsType) > -1 || fsType.indexOf('cgroup') === 0 || fsType === 'overlay' ||
        ['/proc', '/sys', '/dev'].some(x => pt === x || pt.indexOf(x + '/') === 0))
    }
    if (keep && out.indexOf(pt) < 0) out.push(pt)
  }
  return out
}

/** `/proc/net/dev`: iface → [rx bytes, tx bytes, rx errs, tx errs, rx drop, tx drop] */
export function readNetDev (root: SysRoot): { [iface: string]: number[] } {
  const out: { [iface: string]: number[] } = {}
  const all = (root.read('/proc/net/dev') || '').split(/\r?\n/).slice(2)
  for (const line of all) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim()
    const f = fields(line.slice(i + 1))
    if (!/^[A-Za-z0-9._-]+$/.test(name) || f.length < 12) continue
    if (![0, 8, 2, 10, 3, 11].every(k => /^\d+$/.test(f[k]))) continue
    out[name] = [0, 8, 2, 10, 3, 11].map(k => parseInt(f[k], 10))
  }
  return out
}

/**
 * `status.data.server.system` in a container (CTR-030…033). Outside containers the transport
 * keeps the APM-030 host metrics.
 */
export class ContainerMetrics {
  info: ContainerInfo
  root: SysRoot
  cgroup: Cgroup | null
  private prevCg: { at: number, sample: CgroupSample } | null = null
  private prevNet: { [iface: string]: number[] } = {}
  private last: number | null = null
  private fsAt: number = 0
  private fsCache: any = null

  constructor (info: ContainerInfo) {
    this.info = info
    this.root = info.root
    this.cgroup = info.inContainer() ? info.cgroup() : null
  }

  limits (): Limits {
    return Limits.effective(this.cgroup, this.root, this.info.ecs.taskCpus(), this.info.ecs.taskMemoryBytes(), hostTotalMemory(this.root))
  }

  /** never throws (`{}` on failure) */
  collect (limits: Limits = this.limits(), now: number = monotonic()): any {
    try {
      const dt = this.last !== null ? now - this.last : 0
      this.last = now
      const cur: CgroupSample = this.cgroup ? this.cgroup.sample() : { usageUsec: null, nrPeriods: null, nrThrottled: null, memCurrent: null, inactiveFile: null, oomKill: null, io: null }
      const prev = this.prevCg
      this.prevCg = { at: now, sample: cur }
      const out = containerValues(limits, prev ? { sample: prev.sample, dt: now - prev.at } : null, cur)
      const net = readNetDev(this.root)
      for (const iface of Object.keys(net)) {
        const c = net[iface]
        const p = this.prevNet[iface]
        const rate = (i: number) => (!p || dt <= 0) ? 0 : Math.max(0, c[i] - p[i]) / dt
        out[`net:rx_5:${iface}`] = metric(round(rate(0) / 1e6, 3), 'mb/s')
        out[`net:tx_5:${iface}`] = metric(round(rate(1) / 1e6, 3), 'mb/s')
        const counters: Array<[string, number]> = [['rx_errors_60', 2], ['tx_errors_60', 3], ['rx_dropped_60', 4], ['tx_dropped_60', 5]]
        for (const [k, i] of counters) out[`net:${k}:${iface}`] = metric(Math.round(rate(i) * 60), '/min')
      }
      this.prevNet = net
      const fsm = this.filesystems(now)
      for (const k of Object.keys(fsm)) out[k] = fsm[k]
      return out
    } catch (e) {
      return {}
    }
  }

  /** `fs:use`/`fs:size` (statfs is cheap but mounts rarely change: refresh every 5 s) */
  private filesystems (now: number): any {
    if (this.fsCache && now - this.fsAt < 5) return this.fsCache
    this.fsAt = now
    const out: any = {}
    const statfs = (fs as any).statfsSync // Node >= 18.15, Bun
    const text = this.root.read('/proc/self/mountinfo')
    if (typeof statfs === 'function' && text) {
      for (const mp of containerFsMounts(text)) {
        if (!isDir(mp)) continue
        try {
          const st = statfs(mp)
          const bsize = Number(st.bsize)
          const total = Number(st.blocks) * bsize
          const used = total - Number(st.bfree) * bsize
          const avail = Number(st.bavail) * bsize
          if (used + avail <= 0) continue
          out[`fs:use:${mp}`] = metric(round(used / (used + avail) * 100, 2), '%')
          out[`fs:size:${mp}`] = metric(round(total / 1e9, 2), 'gb')
        } catch (e) {
          continue
        }
      }
    }
    this.fsCache = out
    return out
  }
}

/** seconds, monotonic */
export function monotonic (): number {
  const t = process.hrtime()
  return t[0] + t[1] / 1e9
}
