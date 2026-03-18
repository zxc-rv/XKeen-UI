const RETRY_DELAYS = [1000, 1500, 2500, 4000, 8000]
const RETRY_STATUSES = new Set([502, 503, 504])
let clashWarmupUntil = 0

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function setClashWarmup(ms: number) {
  const next = Date.now() + ms
  if (next > clashWarmupUntil) clashWarmupUntil = next
}

async function waitClashWarmup() {
  const wait = clashWarmupUntil - Date.now()
  if (wait > 0) await delay(wait)
}

function getClashHttpBase(): string {
  return '/clash'
}

export async function apiCall<T = unknown>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const maxRetries = method === 'GET' ? 5 : 0
  await waitClashWarmup()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`/api/${endpoint}`, {
        method,
        headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
        body: method !== 'GET' ? JSON.stringify(body) : undefined,
      })

      if (!response.ok && attempt < maxRetries) {
        await delay(RETRY_DELAYS[attempt])
        continue
      }

      return (await response.json()) as T
    } catch (error) {
      if (attempt === maxRetries) throw error
      await delay(RETRY_DELAYS[attempt])
    }
  }

  throw new Error('Max retries exceeded')
}

export async function clashFetch<T = unknown>(
  port: string,
  path: string,
  options?: { method?: string; secret?: string | null; body?: unknown; unix?: string | null }
): Promise<T> {
  const { method = 'GET', secret, body, unix } = options ?? {}
  const normalizedPath = path.replace(/^\/+/, '')
  const base = getClashHttpBase()
  const useUnix = !!unix

  const maxRetries = method === 'GET' ? 5 : 0

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${base}/${normalizedPath}`, {
        method,
        headers: {
          ...(!useUnix && port ? { 'X-Clash-Port': port } : {}),
          ...(!useUnix && secret ? { 'X-Clash-Secret': secret } : {}),
          ...(useUnix && unix ? { 'X-Clash-Unix': unix } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (!res.ok && attempt < maxRetries && RETRY_STATUSES.has(res.status)) {
        await delay(RETRY_DELAYS[attempt])
        continue
      }

      if (res.status === 204 || res.headers.get('content-length') === '0') return {} as T
      return res.json() as T
    } catch (error) {
      if (attempt === maxRetries) throw error
      await delay(RETRY_DELAYS[attempt])
    }
  }

  throw new Error('Max retries exceeded')
}

export function getFileLanguage(filename: string): string {
  if (filename.endsWith('.json')) return 'json'
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml'
  if (filename.endsWith('.lst')) return 'plaintext'
  return 'json'
}

export function capitalize(str: string) {
  return str ? str[0].toUpperCase() + str.slice(1) : ''
}
