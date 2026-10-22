import './style.css'
import { api } from '../shared/client.ts'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <main>
    <h1>Hello, NameTempest</h1>
    <p>nametempest.com</p>
    <p id="server-status" class="server-status" data-state="checking">Checking the server…</p>
  </main>
`

const status = app.querySelector<HTMLParagraphElement>('#server-status')!

api
  .health()
  .then((health) => {
    status.dataset.state = health.status === 'ok' ? 'ok' : 'degraded'
    status.textContent = `Server ${health.status} · database ${health.database.status} · migrations ${health.database.migrations}`
  })
  .catch((error: unknown) => {
    status.dataset.state = 'unreachable'
    status.textContent = error instanceof Error ? `Server not reachable: ${error.message}` : 'Server not reachable.'
  })
