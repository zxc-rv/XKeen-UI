const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000]

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getClashHttpBase(port: string): string {
  if (import.meta.env.DEV) return '/clash'
  return `http://${location.hostname}:${port}`
}

export async function apiCall<T = unknown>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const maxRetries = method === 'GET' ? 5 : 0

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
  options?: { method?: string; secret?: string | null; body?: unknown }
): Promise<T> {
  const { method = 'GET', secret, body } = options ?? {}
  const normalizedPath = path.replace(/^\/+/, '')
  const base = getClashHttpBase(port)

  const res = await fetch(`${base}/${normalizedPath}`, {
    method,
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204 || res.headers.get('content-length') === '0') return {} as T
  return res.json() as T
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
