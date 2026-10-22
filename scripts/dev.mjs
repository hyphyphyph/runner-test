// Start the Vite front end and the API server together for development.
//
//   npm run dev
//
// Vite serves the page on VITE_PORT (default 5173) and proxies /api to the
// API on PORT (default 8787). Stopping either process stops the other.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer as createViteServer } from 'vite'

const clientPort = Number(process.env.VITE_PORT ?? 5173)
const apiPort = Number(process.env.PORT ?? 8787)

let vite
try {
  vite = await createViteServer({
    server: {
      port: clientPort,
    },
  })
  await vite.listen()
  vite.printUrls()
} catch (error) {
  console.error('[dev] Vite could not start.', error)
  process.exit(1)
}

const api = spawn(process.execPath, ['--watch', 'server/main.ts'], {
  stdio: 'inherit',
  env: process.env,
})

let stopping = false

api.once('error', (error) => {
  console.error('[dev] The API server could not be started.', error)
  void shutdown(1)
})

api.once('exit', (code, signal) => {
  if (stopping) return
  const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`
  console.error(`[dev] The API server stopped with ${reason}.`)
  void shutdown(code ?? 1)
})

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

async function shutdown(code) {
  if (stopping) return
  stopping = true

  if (api.exitCode === null && api.signalCode === null) {
    api.kill('SIGTERM')
    await Promise.race([
      once(api, 'exit'),
      delay(3000).then(() => {
        if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL')
      }),
    ])
  }

  try {
    await vite.close()
  } catch (error) {
    console.error('[dev] Vite did not close cleanly.', error)
  }

  process.exit(code)
}

console.log(`[dev] Vite proxies /api to the API on http://127.0.0.1:${apiPort}.`)
