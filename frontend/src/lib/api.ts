const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000]
const RETRY_STATUSES = new Set([502, 503, 504])

export async function apiCall<T = unknown>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const isGet = method === 'GET'
  const res = await fetch(`/api/${endpoint}`, {
    method,
    headers: !isGet ? { 'Content-Type': 'application/json' } : {},
    body: !isGet ? JSON.stringify(body) : undefined,
  })
  return (await res.json()) as T
}

export async function clashFetch<T = unknown>(
  port: string,
  path: string,
  options?: { method?: string; secret?: string | null; body?: unknown; unix?: string | null }
): Promise<T> {
  const { method = 'GET', secret, body, unix } = options ?? {}
  const normalizedPath = path.replace(/^\/+/, '')

  const headers: Record<string, string> = {}
  if (!unix && port) headers['X-Clash-Port'] = port
  if (!unix && secret) headers['X-Clash-Secret'] = secret
  if (unix) headers['X-Clash-Unix'] = unix
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const reqOptions: RequestInit = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }

  // Долбим ретраи если пришла 502/503/504 или отвалилась сеть
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fetch(`/clash/${normalizedPath}`, reqOptions)

      if (!res.ok && RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
        continue
      }

      if (res.status === 204 || res.headers.get('content-length') === '0') return {} as T
      return (await res.json()) as T
    } catch (error) {
      if (attempt === RETRY_DELAYS.length) throw error
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
    }
  }
  throw new Error('Max retries exceeded')
}

export function getFileLanguage(filename: string): string {
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml'
  if (filename.endsWith('.lst')) return 'plaintext'
  return 'json'
}

export function capitalize(str: string) {
  return str ? str[0].toUpperCase() + str.slice(1) : ''
}
