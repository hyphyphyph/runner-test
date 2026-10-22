// Start the NameTempest server.
//
//   node server/main.ts                       serve the API and the built site
//   node server/main.ts operator <email> on   grant the operator role by hand
//   node server/main.ts operator <email> off  remove it

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createApp, createContext, startJobs } from './app.ts'
import { grantOperatorByHand } from './admin.ts'

const dbFile = resolve(process.env.NT_DB ?? 'data/nametempest.db')
mkdirSync(dirname(dbFile), { recursive: true })
const dev = process.env.NODE_ENV !== 'production'
const secret = process.env.NT_SECRET ?? (dev ? 'dev-secret-' + dbFile : '')
if (!secret) {
  console.error('Set NT_SECRET to a long random value in production.')
  process.exit(1)
}
const port = Number(process.env.PORT ?? 8787)
const baseUrl = process.env.NT_BASE_URL ?? (dev ? 'http://localhost:5173' : 'https://nametempest.com')

const ctx = createContext({ dbFile, secret, baseUrl, dev })

const [cmd, email, onOff] = process.argv.slice(2)
if (cmd === 'operator') {
  if (!email || (onOff !== 'on' && onOff !== 'off')) {
    console.error('usage: node server/main.ts operator <email> on|off')
    process.exit(1)
  }
  console.log(grantOperatorByHand(ctx, email, onOff === 'on') ? 'done' : 'no account with that email')
  process.exit(0)
}

const staticDir = resolve('dist')
const server = createApp(ctx, existsSync(staticDir) ? staticDir : null)
startJobs(ctx)
server.listen(port, () => {
  console.log(`NameTempest listening on http://localhost:${port}`)
  if (!process.env.ANTHROPIC_API_KEY) console.log('No ANTHROPIC_API_KEY: names come from the local demo generator.')
  if (ctx.billingMode !== 'stripe') console.log(`Billing mode: ${ctx.billingMode}`)
})
