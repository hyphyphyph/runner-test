import './style.css'
import { frame, refreshMe, showProblem } from './app.ts'
import { workspaceView, leaveWorkspace } from './views/workspace.ts'
import { accountView, inviteView, magicView, plansView, signInView, studioView } from './views/pages.ts'
import { adminView } from './views/admin.ts'

const main = frame(document.querySelector<HTMLDivElement>('#app')!)

async function route(): Promise<void> {
  const raw = location.hash.replace(/^#/, '') || '/'
  const [path, query = ''] = raw.split('?')
  const params = new URLSearchParams(query)
  const parts = path.split('/').filter(Boolean)
  if (parts[0] !== 'p' && parts.length) leaveWorkspace()
  switch (parts[0]) {
    case undefined:
      return workspaceView(main, null)
    case 'p':
      return workspaceView(main, parts[1] ?? null)
    case 'signin':
      return signInView(main, params.get('next'))
    case 'magic':
      return magicView(main, parts[1] ?? '')
    case 'invite':
      return inviteView(main, parts[1] ?? '')
    case 'account':
      return accountView(main, params)
    case 'plans':
      return plansView(main)
    case 'studio':
      return studioView(main)
    case 'admin':
      return adminView(main)
    default:
      location.hash = '#/'
  }
}

async function boot(): Promise<void> {
  try {
    await refreshMe()
  } catch (e) {
    showProblem(e, () => void boot())
    return
  }
  window.addEventListener('hashchange', () => void route())
  await route()
}

void boot()
