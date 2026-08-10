export const LOCAL_ROUTER_ID = 'local'
export const ROUTERS_FILE = '/opt/etc/xkeen/routers.lst'
export const DEFAULT_ROUTER_PORT = 1000
export const ONLINE_PING_INTERVAL_MS = 30_000
export const REMOTE_FETCH_TIMEOUT_MS = 12_000

export interface RemoteRouter {
  host: string
  port: number
  name: string
}

export type RouterCommandStatus = 'idle' | 'pending' | 'success' | 'error'

export interface RouterCommandState {
  status: RouterCommandStatus
  message?: string
}

export function routerId(router: Pick<RemoteRouter, 'host' | 'port'>): string {
  return `${router.host}:${router.port}`
}

export function routerBaseUrl(host: string, port = DEFAULT_ROUTER_PORT): string {
  return `http://${host}:${port}`
}

export function routerLabel(router: RemoteRouter): string {
  const label = router.name.trim()
  return label || `${router.host}:${router.port}`
}

/** One router per line: host:port [name]. Lines starting with # are ignored. */
export function parseRoutersLst(content: string): RemoteRouter[] {
  const routers: RemoteRouter[] = []
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^(\S+?):(\d+)\s*(.*)$/)
    if (!match) continue

    const host = match[1].trim()
    const port = Number(match[2])
    const name = (match[3] ?? '').trim()
    if (!host || port < 1 || port > 65535) continue

    routers.push({ host, port, name })
  }
  return routers
}

export function serializeRoutersLst(routers: RemoteRouter[]): string {
  if (routers.length === 0) return ''
  return `${routers.map((r) => (r.name.trim() ? `${r.host}:${r.port} ${r.name.trim()}` : `${r.host}:${r.port}`)).join('\n')}\n`
}

export function isRoutersConfigFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  return normalized === ROUTERS_FILE || normalized.endsWith('/routers.lst') || normalized === 'routers.lst'
}

export function findRouter(routers: RemoteRouter[], id: string): RemoteRouter | undefined {
  return routers.find((r) => routerId(r) === id)
}
