// Live editing (SharedProjects.liveEditing). Every open view of a project
// holds a server-sent event stream; each saved change is pushed to all of
// them, so no member has to refresh to see another member's change.

import type { ServerResponse } from 'node:http'

export class Live {
  private channels = new Map<string, Set<ServerResponse>>()

  subscribe(projectId: string, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    let set = this.channels.get(projectId)
    if (!set) this.channels.set(projectId, (set = new Set()))
    set.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 20000)
    res.on('close', () => {
      clearInterval(ping)
      set!.delete(res)
      if (set!.size === 0) this.channels.delete(projectId)
    })
  }

  publish(projectId: string, event: Record<string, unknown>): void {
    const set = this.channels.get(projectId)
    if (!set) return
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const res of set) res.write(data)
  }

  // Close every stream of a project, used when access to it ends.
  close(projectId: string): void {
    const set = this.channels.get(projectId)
    if (!set) return
    for (const res of set) res.end()
    this.channels.delete(projectId)
  }
}
