
import { Action } from './actions'
import { Metric, InternalMetric } from './metrics'
import { IPCTransport } from '../transports/IPCTransport'
import { ProdmanTransport } from '../transports/ProdmanTransport'
import { EventEmitter2 } from 'eventemitter2'

export class TransportConfig {
  /**
   * prodman: base URL of the prodman server (standalone mode).
   * Default: PRODMAN_URL, then KEYMETRICS_NODE, then http://localhost:8070
   */
  url?: string
  /**
   * public key of the bucket to which the agent need to connect
   */
  publicKey: string
  /**
   * Secret key of the bucket to which the agent need to connect
   */
  secretKey: string
  /**
   * The name of the application/service that will be reported to PM2 Enterprise
   */
  appName: string
  /**
   * The name this process appears under in prodman's Servers. Each standalone process needs
   * its own name (prodman keeps one connection per name).
   *
   * default is PM2_MACHINE_NAME, else "<appName>@<hostname>"
   */
  serverName?: string
  /**
   * Broadcast all the logs from your application to our backend
   */
  sendLogs?: Boolean
  /**
   * Since logs can be forwared to our backend you may want to ignore specific
   * logs (containing sensitive data for example)
   */
  logFilter?: string | RegExp
  /**
   * Avoid to broadcast any logs from your application to our backend
   * Even if the sendLogs option set to false, you can still see some logs
   * when going to the log interface (it automatically trigger broacasting log)
   */
  disableLogs?: Boolean
}

export interface Transport extends EventEmitter2 {
  /**
   * Init the transporter (connection, listeners etc)
   */
  init: (config: TransportConfig) => Transport
  /**
   * Destroy the instance (disconnect, cleaning listeners etc)
   */
  destroy: () => void
  /**
   * Send data to remote endpoint
   */
  send: (channel: string, payload: Object) => void
  /**
   * Declare available actions
   */
  addAction: (action: Action) => void
  /**
   * Declare metrics
   */
  setMetrics: (metrics: InternalMetric[]) => void
  /**
   * Declare options for process
   */
  setOptions: (options: any) => void
}

/**
 * Init a transporter implementation with a specific config
 */
export function createTransport (name: string, config: TransportConfig): Transport {
  // prodman: 'websocket' (standalone) reports straight to a prodman server
  const transport: Transport = name === 'websocket' ? new ProdmanTransport() : new IPCTransport()
  transport.init(config)
  return transport
}
