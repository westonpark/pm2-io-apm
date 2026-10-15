// prodman standalone shutdown fixture (APM-086/087): reports from the environment (PM2_* keys,
// PRODMAN_URL), registers the action `go` and does FIXTURE_MODE when prodman triggers it.
import * as io from '../../../src'

const mode = process.env.FIXTURE_MODE || 'idle'
const keepAlive = setInterval(() => { /* the app's own work */ }, 1000)

if (mode === 'own-handler') {
  process.on('SIGTERM', () => console.log('app: SIGTERM received, draining'))
}
if (mode === 'onexit') {
  io.onExit(() => console.log('app: onExit callback'))
}

io.action('go', (reply) => {
  reply({ mode })
  switch (mode) {
    case 'ends':
      // the app's work is done: the event loop empties (beforeExit)
      clearInterval(keepAlive)
      break
    case 'crash':
      setImmediate(() => { throw new Error('boom') })
      break
    case 'destroy':
      setTimeout(() => {
        io.destroy()
        setTimeout(() => {
          console.log('app: still running after destroy')
          clearInterval(keepAlive)
        }, 300)
      }, 50)
      break
    case 'exit-call':
      setTimeout(() => process.exit(3), 50)
      break
  }
})
