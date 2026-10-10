<div align="center">
  <a href="http://pm2.keymetrics.io">
    <img width=411px src="https://raw.githubusercontent.com/keymetrics/pm2-io-apm/master/pres/io-white.png">
  </a>
  <br/>

<br/>
<br/>
</div>


## Prodman

This fork of `@pm2/io` reports to a [prodman](https://github.com/westonpark/prodman) server.

* **Apps run by PM2 (pm2_prodman):** nothing changes. The library talks to the PM2 daemon over
  IPC and the daemon's agent forwards everything to prodman.
* **Apps run without PM2** (a container's `node app.js`, ECS tasks, workers): the library connects
  to prodman itself, as a one-process PM2 agent. It uses the same handshake, WebSocket and
  channels (prodman `docs/agent-protocol.md`), so the app appears in prodman's Servers and
  Apps with its metrics, actions (including CPU/heap profiling), events, exceptions and logs.

Install it from GitHub (it builds on install; npm 12+ needs `--allow-git=root` to fetch from git):

```bash
npm install --allow-git=root github:westonpark/pm2-io-apm
```

Standalone mode starts automatically when the bucket keys and an app name are set, and the
process isn't run by PM2:

```bash
PRODMAN_URL=https://prodman.example.com \
PM2_PUBLIC_KEY=<public key> PM2_SECRET_KEY=<secret key> PM2_APP_NAME=orders-api \
node app.js
```

```js
const io = require('@pm2/io')
io.init({ apmOptions: { sendLogs: true } })   // or set everything here, see below
```

| Setting (`apmOptions`) | Environment | Default |
|---|---|---|
| `url` | `PRODMAN_URL` (then `KEYMETRICS_NODE`) | `http://localhost:8070` |
| `publicKey`, `secretKey` | `PM2_PUBLIC_KEY`, `PM2_SECRET_KEY` | required (Bucket settings → Connect) |
| `appName` | `PM2_APP_NAME` | required |
| `serverName` | `PM2_MACHINE_NAME` | `<appName>@<hostname>` |
| `sendLogs` | | `false`; logs are also sent while the bucket's "collect logs" is on |
| `disableLogs` | | `false`; `true` never captures stdout/stderr |
| `logFilter` | | lines containing this string, or matching this RegExp, are not sent |

Notes:

* Each standalone process needs its own server name, because prodman keeps one connection per
  name. The default `<appName>@<hostname>` is unique per container; set `PM2_MACHINE_NAME` when
  several copies of an app share a host.
* PM2-only remote commands (restart, reload, stop…) answer with an error, since there is no PM2
  to carry them out. `ping` works, and "Logs" shows the last 200 lines the app printed.
* The connection never keeps the app alive: it exits when its own work is done.
* It retries forever, with backoff, if prodman is unreachable or the keys are wrong, and
  queues the last 200 events while disconnected.
* Inside PM2 (`pm_id` set) the library always uses IPC, even if the `PM2_*` keys are in the
  environment (as with `pm2-runtime` in Docker).
* The `proxy` option from upstream is not supported.

### `PM2_APP_NAME` and `PM2_MACHINE_NAME`

Prodman organises everything as **servers** that run **processes**, and lists **applications**
by grouping processes with the same name across servers. Under PM2, the server is the machine
and its PM2 agent, and the process names are the app names in PM2. A standalone app has no PM2,
so these two variables supply both:

* **`PM2_APP_NAME`** is the **application name**. It is the name of the one process the app
  reports, so it is what appears under **Applications** and in app-level views (metrics, logs,
  issues, events, actions). Copies of the same app on different hosts or containers should all
  use the same `PM2_APP_NAME`, so prodman shows them as instances of one application.
* **`PM2_MACHINE_NAME`** is the **server name**. It is the entry under **Servers**, and the
  identity of the connection (`X-KM-SERVER`). Prodman keeps one live connection per server name,
  so every running copy needs a different one. A second copy with the same name replaces the
  first, and the two keep taking over from each other. When it is not set, the name is
  `<PM2_APP_NAME>@<hostname>`, which is unique as long as only one copy runs per host or
  container.

For example, two ECS tasks of `orders-api` appear as servers `orders-api@ip-10-0-1-12` and
`orders-api@ip-10-0-2-34`, and as one application `orders-api` with 2 instances.

### Not seeing the app under its `PM2_APP_NAME`?

The app is listed under `PM2_APP_NAME` only when the library actually runs in standalone mode.
Otherwise `PM2_APP_NAME` is ignored. Check:

1. **Is the app run by PM2?** Under PM2 (`pm_id` is set) the library always reports through the
   PM2 daemon, and the app is listed under its **PM2 name** (`name` in the ecosystem file, or
   `pm2 start app.js --name …`), on the machine's server. Rename it there; `PM2_APP_NAME` has no
   effect under PM2.
2. **Are all three of `PM2_PUBLIC_KEY`, `PM2_SECRET_KEY` and `PM2_APP_NAME` set** in the app's own
   environment (not just your shell) **before `@pm2/io` is first required**? Requiring it starts it
   from the environment. With one of them missing, standalone mode stays off (the library prints a
   warning naming the missing variables).
3. **Is it this fork?** Upstream `@pm2/io` from npm has no prodman transport and silently does
   nothing outside PM2. `require('@pm2/io/package.json').version` should be 7.x. Only one copy of
   `@pm2/io` runs per process (the first one loaded is shared), so a dependency that pulls in
   upstream `@pm2/io` and loads it first wins. Check with `npm ls @pm2/io`.
4. **Did it connect?** A wrong URL keeps it retrying quietly, and wrong keys print
   `[@pm2/io] prodman refused the connection`. Run with `DEBUG=axm:transport:prodman` to see the
   handshake, the URL it uses (`PRODMAN_URL`, default `http://localhost:8070`) and the server name.
5. **Look under Servers too.** The app's server is `PM2_MACHINE_NAME` (or `<PM2_APP_NAME>@<hostname>`).
   If it is there but flapping, two copies share a server name; give each its own `PM2_MACHINE_NAME`.

---

The [@pm2/io](https://github.com/keymetrics/pm2-io-apm/tree/master/test) module comes along with PM2. It is the PM2 library responsible for gathering the metrics, reporting exceptions, exposing remote actions and every interaction with your application.

You can also use it as a standalone agent, to connect your Node.js process to prodman without launching it with PM2 (see [Prodman](#prodman)).

# Table of Contents

- [**Installation**](https://github.com/keymetrics/pm2-io-apm/tree/master#installation)
- [**Expose Custom Metrics**](https://github.com/keymetrics/pm2-io-apm/tree/master#expose-custom-metrics)
- [**Expose Remote Actions**](https://github.com/keymetrics/pm2-io-apm#expose-remote-actions-trigger-functions-remotely)
- [**Report Custom Errors**](https://github.com/keymetrics/pm2-io-apm#report-user-error)
- [**Distributed Tracing**](https://github.com/keymetrics/pm2-io-apm#distributed-tracing)
- [**Configuration**](https://github.com/keymetrics/pm2-io-apm/tree/master#configuration)
- [**Migration Guide**](https://github.com/keymetrics/pm2-io-apm#migration-guides)
- [**Development**](https://github.com/keymetrics/pm2-io-apm/tree/master#development)
- [**Notes**](https://github.com/keymetrics/pm2-io-apm/tree/master#notes)


# Installation

With npm:

```bash
npm install @pm2/io --save
```

With yarn:

```bash
yarn add @pm2/io
```

## V8 Runtime Metrics

To retrieve by default V8 Runtime metrics like:
- V8 Garbage Collector metrics
- [CPU Context Switch](https://unix.stackexchange.com/questions/442969/what-exactly-are-voluntary-context-switches)
- [Page Fault](https://en.wikipedia.org/wiki/Page_fault#Types)

Install:

```bash
npm install @pm2/node-runtime-stats
```

And restart the application.

## Custom Metrics

@pm2/io allows you to gather metrics from your code to be reported in the PM2 Plus/Enterprise dashboard.

### Create a custom metrics

You can create a new custom metrics with the method `metric()` of `@pm2/io`.

```javascript
const io = require('@pm2/io');

const users = io.metric({
  name: 'Realtime user',
});
users.set(10)
```

This arguments are available:

- **name**: The metric name (required; string)
- **id**: The type of metric (default 'metric', string)
- **unit**: unit of the measure (default ''; string)
- **historic**: keep the history in PM2 Plus (default: true; boolean)

There are 4 different types of metrics:

- **gauge**: To expose a variable's value
- **counter**: A discrete counter to be triggered manually to count a number of occurrence
- **meter**: To measure a frequency, a number of occurrences of a repeating event per unit of time
- **histogram**: To measure a statistic, a statistic on a metric over the last 5 minutes

### Metric: Variable Exposition

The first type of metric, called `metric`, allows to expose a variable's value. The variable can be exposed passively, with a function that gets called every second, or actively, with a method that you use to update the value.

#### Active Mode

In active mode, you need to create a probe and call the method `set()` to update the value.

```javascript
const myMetric = io.metric({
  name: 'Realtime Value'
});

myMetric.set(23);
```

#### Passive Mode

In passive mode you hust need to return the variable to be monitored:

```javascript
const myMetric = io.metric({
  name: 'Realtime Value',
  value: () => {
    return variable_to_monitor
  }
});
```

### Counter: Discrete Counter

The second type of metric, called `counter`, is a discrete counter that helps you count the number of occurrence of a particular event. The counter starts at 0 and can be incremented or decremented.

```javascript
const io = require('@pm2/io');

const currentReq = io.counter({
  name: 'Current req processed',
  type: 'counter',
});

http.createServer((req, res) => {
  // Increment the counter, counter will eq 1
  currentReq.inc();
  req.on('end', () => {
    // Decrement the counter, counter will eq 0
    currentReq.dec();
  });
});
```

### Meter: Frequency

The third type of metric, called `meter`, compute the frequency of an event. Each time the event happens, you need to call the `mark()` method. By default, the frequency is the number of events per second over the last minute.

```javascript
const io = require('@pm2/io');

const reqsec = io.meter({
  name: 'req/sec',
  type: 'meter',
});

http.createServer((req, res) => {
  reqsec.mark();
  res.end({ success: true });
});
```

Additional options:
- **samples**: (optional)(default: 1) Rate unit. Defaults to **1** sec.
- **timeframe**: (optional)(default: 60) Timeframe over which the events will be analyzed. Defaults to **60** sec.

### Histogram: Statistics

Collect values and provide statistic tools to explore their distribution over the last 5 minutes.

```javascript
const io = require('@pm2/io');

const latency = io.histogram({
  name: 'latency',
  measurement: 'mean'
});

var latencyValue = 0;

setInterval(() => {
  latencyValue = Math.round(Math.random() * 100);
  latency.update(latencyValue);
}, 100);
```

Options are:
- **measurement** : default: mean; min, max, sum, count, variance, mean, stddev, median, p75, p95, p99, p99.

## Expose Remote Actions: Trigger Functions remotely

Remotely trigger functions from PM2 Plus or Enterprise.

### Simple actions

The function takes a function as a parameter (cb here) and need to be called once the job is finished.

Example:

```javascript
const io = require('@pm2/io');

io.action('db:clean', (cb) => {
  clean.db(() => {
    // cb must be called at the end of the action
    return cb({ success: true });
  });
});
```

## Report user error

By default, in the Issue tab, you are only alerted for uncaught exceptions. Any exception that you catch is not reported. You can manually report them with the `notifyError()` method.

```javascript
const io = require('@pm2/io');

io.notifyError(new Error('This is an error'), {
  // you can some http context that will be reported in the UI
  http: {
    url: req.url
  },
  // or anything that you can like an user id
  custom: {
    user: req.user.id
  }
});
```

#### Express error reporting

If you want you can configure your express middleware to automatically send you an error with the error middleware of express :

```javascript
const io = require('@pm2/io')
const express = require('express')
const app = express()

// add the routes that you want
app.use('/toto', () => {
  throw new Error('ajdoijerr')
})

// always add the middleware as the last one
app.use(io.expressErrorHandler())
```

#### Koa error reporting

We also expose a custom koa middleware to report error with a specific koa middleware :

```javascript
const io = require('@pm2/io')
const Koa = require('koa')
const app = new Koa()

// the order isn't important with koa
app.use(pmx.koaErrorHandler())

// add the routes that you want
app.use(async ctx => {
  ctx.throw(new Error('toto'))
})
```

## Distributed Tracing

The Distributed Tracing allows to captures and propagates distributed traces through your system, allowing you to visualize how customer requests flow across services, rapidly perform deep root cause analysis, and better analyze latency across a highly distributed set of services.
If you want to enable it, here the simple options to enable:


```javascript
const io = require('@pm2/io').init({
  tracing: {
    enabled: true,
    // will add the actual queries made to database, false by default
    detailedDatabasesCalls: true,
    // if you want you can ignore some endpoint based on their path
    ignoreIncomingPaths: [
      // can be a regex
      /misc/,
      // or a exact string
      '/api/bucket'
      // or a function with the request
      (url, request) => {
        return true
      }
    ],
    // same as above but used to match entire URLs
    ignoreOutgoingUrls: [],
    /**
     * Determines the probability of a request to be traced. Ranges from 0.0 to 1.0
     * default is 0.5
     */
    samplingRate: 0.5
  }
})
```

By default we ignore specific incoming requests (you can override this by setting `ignoreIncomingPaths: []`):
- Request with the OPTIONS or HEAD method
- Request fetching a static ressources (`*.js`, `*.css`, `*.ico`, `*.svg`, `.png` or `*webpack*`)

### What's get traced

When your application will receive a request from either `http`, `https` or `http2` it will start a trace. After that, we will trace the following modules:
 - `http` outgoing requests
 - `https` outgoing requests
 - `http2` outgoing requests
 - `mongodb-core` version 1 - 3
 - `redis` versions > 2.6
 - `ioredis` versions > 2.6
 - `mysql` version 1 - 3
 - `mysql2` version 1 - 3
 - `pg` version > 6
 - `vue-server-renderer` version 2

### Custom Tracing API

The custom tracing API can be used to create custom trace spans. A span is a particular unit of work within a trace, such as an RPC request. Spans may be nested; the outermost span is called a root span, even if there are no nested child spans. Root spans typically correspond to incoming requests, while child spans typically correspond to outgoing requests, or other work that is triggered in response to incoming requests. This means that root spans shouldn't be created in a context where a root span already exists; a child span is more suitable here. Instead, root spans should be created to track work that happens outside of the request lifecycle entirely, such as periodically scheduled work. To illustrate:

```js
const io = require('@pm2/io').init({ tracing: true })
const tracer = io.getTracer()
// ...

app.get('/:token', function (req, res) {
  const token = req.params.token
  // the '2' correspond to the type of operation you want to trace
  // can be 0 (UNKNOWN), 1 (SERVER) or 2 (CLIENT)
  // 'verifyToken' here will be the name of the operation
  const customSpan = tracer.startChildSpan('verifyToken', 2)
  // note that customSpan can be null if you are not inside a request
  req.Token.verifyToken(token, (err, result) => {
    if (err) {
      // you can add tags to the span to attach more details to the span
      customSpan.addAttribute('error', err.message)
      customSpan.end()
      return res.status(500).send('error')
    }
    customSpan.addAttribute('result', result)
    // be sure to always .end() the spans
    customSpan.end()
    // redirect the user if the token is valid
    res.send('/user/me')
  })
})

// For any significant work done _outside_ of the request lifecycle, use
// startRootSpan.
const traceOptions = {
    name: 'my custom trace',
    // the '1' correspond to the type of operation you want to trace
    // can be 0 (UNKNOWN), 1 (SERVER) or 2 (CLIENT)
    kind: '1'
  }
plugin.tracer.startRootSpan(traceOptions, rootSpan => {
  // ...
  // Be sure to call rootSpan.end().
  rootSpan.end()
});
```

## Configuration

### Global configuration object

```javascript
export class IOConfig {
  /**
   * Automatically catch unhandled errors
   */
  catchExceptions?: boolean = true
  /**
   * Configure the metrics to add automatically to your process
   */
  metrics?: {
    eventLoop: boolean = true,
    network: boolean = false,
    http: boolean = true,
    gc: boolean = true,
    v8: boolean = true
  }
  /**
   * Configure the default actions that you can run
   */
  actions?: {
    eventLoopDump?: boolean = true
  }
  /**
   * Configure availables profilers that will be exposed
   */
  profiling?: {
    /**
     * Toggle the CPU profiling actions
     */
    cpuJS: boolean = true
    /**
     * Toggle the heap snapshot actions
     */
    heapSnapshot: boolean = true
    /**
     * Toggle the heap sampling actions
     */
    heapSampling: boolean = true
    /**
     * Force a specific implementation of profiler
     *
     * available:
     *  - 'addon' (using the v8-profiler-node8 addon)
     *  - 'inspector' (using the "inspector" api from node core)
     *  - 'none' (disable the profilers)
     *  - 'both' (will try to use inspector and fallback on addon if available)
     */
    implementation: string = 'both'
  }
  /**
   * Configure the transaction tracing options
   */
  tracing?: {
    /**
     * Enabled the distributed tracing feature.
     */
    enabled: boolean
    /**
     * If you want to report a specific service name
     * the default is the same as in apmOptions
     */
    serviceName?: string
    /**
     * Generate trace for outgoing request that aren't connected to a incoming one
     * default is false
     */
    outbound?: boolean
    /**
     * Determines the probability of a request to be traced. Ranges from 0.0 to 1.0
     * default is 0.5
     */
    samplingRate?: number,
    /**
     * Add details about databases calls (redis, mongodb etc)
     */
    detailedDatabasesCalls?: boolean,
    /**
     * Ignore specific incoming request depending on their path
     */
    ignoreIncomingPaths?: Array<IgnoreMatcher<httpModule.IncomingMessage>>
    /**
     * Ignore specific outgoing request depending on their url
     */
    ignoreOutgoingUrls?: Array<IgnoreMatcher<httpModule.ClientRequest>>
    /**
     * Set to true when wanting to create span for raw TCP connection
     * instead of new http request
     */
    createSpanWithNet: boolean
  }
  /**
   * Report straight to a prodman server without PM2 (see Prodman above).
   *
   * default is false, or true when PM2_PUBLIC_KEY, PM2_SECRET_KEY and PM2_APP_NAME are set
   * and the process is not run by PM2
   */
  standalone?: boolean = false
  /**
   * Define custom options for the standalone mode
   */
  apmOptions?: {
    /**
     * Base URL of the prodman server (default PRODMAN_URL, KEYMETRICS_NODE, http://localhost:8070)
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
     * The name this process appears under in prodman's Servers
     *
     * default is PM2_MACHINE_NAME, else "<appName>@<hostname>"
     */
    serverName?: string
    /**
     * Broadcast all the logs from your application to our backend
     */
    sendLogs?: Boolean
    /**
     * Avoid to broadcast any logs from your application to our backend
     * Even if the sendLogs option set to false, you can still see some logs
     * when going to the log interface (it automatically trigger broacasting log)
     */
    disableLogs?: Boolean
    /**
     * Since logs can be forwared to our backend you may want to ignore specific
     * logs (containing sensitive data for example)
     */
    logFilter?: string | RegExp
  }
}
```

You can pass whatever options you want to `io.init`, it will automatically update its configuration.

## Migration Guides

### 2.x to 3.x

Here the list of breaking changes :

- Removed `io.scopedAction` because of low user adoption
- Removed `io.notify` in favor of `io.notifyError` (droppin replacement)
- Removed support for `gc-stats` module
- Removed Heap profiling support when using the profiler addon (which wasn't possible at all)
- Removed deep-metrics support (the module that allowed to get metrics about websocket/mongo out of the box), we are working on a better solution.
- Removed `io.transpose`
- Removed `io.probe()` to init metrics
- **Changed the configuration structure**

High chance that if you used a custom configuration for `io.init`, you need to change it to reflect the new configuration.
Apart from that and the `io.notify` removal, it shouldn't break the way you instanciated metrics.
If you find something else that breaks please report it to us (tech@keymetrics.io).

### 3.x to 4.x

The only difference with the 4.x version is the new tracing system put in place, so the only changs are related to it:

- **Dropped the support for node 4** (you can still use the 3.x if you use node 4 but you will not have access to the distributed tracing)
- **Changed the tracing configuration** (see options above)

## Development

To auto rebuild on file change:

```bash
$ npm install
$ npm run watch
```

To test only one file:

```bash
$ npm run unit <typescript-file-to-test.ts>
```

Run transpilation + test + coverage:

```bash
$ npm run test
```

Run transpilation + test only:

```bash
$ npm run unit <test>
```

## Notes

Curently this package isn't compatible with `amqp` if you use the `network` metrics. We recommend to disable the metrics with the following configuration in this case :

```javascript
io.init({
  metrics: {
    network: false
  }
})
```
