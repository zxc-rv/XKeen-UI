import { useEffect, useState, useCallback, useMemo } from 'react'
import { IconLoader2, IconBoltFilled, IconCircleArrowRightFilled } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Spinner } from '@/components/ui/spinner'

interface ProxyHistory {
  time: string
  delay: number
}

interface ProxyInfo {
  name: string
  type: string
  udp: boolean
  uot?: boolean
  xudp?: boolean
  alive: boolean
  hidden?: boolean
  now?: string
  all?: string[]
  history: ProxyHistory[]
  'provider-name'?: string
  icon?: string
}

type ClashMode = 'rule' | 'global' | 'direct'

const NO_DELAY_TYPES = new Set(['reject', 'dns', 'pass', 'relay'])

interface Props {
  dashboardPort: string
  mode: ClashMode
  connections: Connection[]
}

interface Connection {
  id: string
  chains: string[]
}

function getLastDelay(proxy: ProxyInfo): number | null {
  if (NO_DELAY_TYPES.has(proxy.type.toLowerCase())) return null
  const history = proxy.history
  return history.length > 0 ? history[history.length - 1].delay : null
}

function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-400'
  return 'text-red-400'
}

export function SelectorsPanel({ dashboardPort, mode, connections }: Props) {
  const [proxies, setProxies] = useState<Record<string, ProxyInfo>>({})
  const [loading, setLoading] = useState(true)
  const [testingAll, setTestingAll] = useState<Record<string, boolean>>({})
  const [testingSingle, setTestingSingle] = useState<Record<string, boolean>>({})

  const baseUrl = `http://${location.hostname}:${dashboardPort}`

  const fetchProxies = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/proxies`)
      const data = await res.json()
      if (data.proxies) setProxies(data.proxies)
    } catch {
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    if (dashboardPort) fetchProxies()
  }, [dashboardPort, fetchProxies])

  function selectProxy(selectorName: string, proxyName: string) {
    setProxies((prev) => ({
      ...prev,
      [selectorName]: { ...prev[selectorName], now: proxyName },
    }))
    ;(async () => {
      try {
        await fetch(`${baseUrl}/proxies/${encodeURIComponent(selectorName)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: proxyName }),
        })
        const affected = connections.filter((conn) => conn.chains?.includes(selectorName)).map((conn) => conn.id)
        await Promise.all(affected.map((id) => fetch(`${baseUrl}/connections/${id}`, { method: 'DELETE' })))
      } catch {}
    })()
  }

  async function testDelay(proxyName: string): Promise<number | null> {
    try {
      const res = await fetch(
        `${baseUrl}/proxies/${encodeURIComponent(proxyName)}/delay?url=https://www.gstatic.com/generate_204&timeout=5000`
      )
      const data = await res.json()
      return data.delay ?? null
    } catch {
      return null
    }
  }

  function applyDelayResult(proxyName: string, delay: number | null) {
    setProxies((prev) => {
      const proxy = prev[proxyName]
      if (!proxy) return prev
      const newHistory = delay !== null ? [...proxy.history, { time: new Date().toISOString(), delay }].slice(-10) : proxy.history
      return { ...prev, [proxyName]: { ...proxy, history: newHistory, alive: delay !== null } }
    })
  }

  async function testAll(selectorName: string) {
    const selector = proxies[selectorName]
    if (!selector?.all) return
    setTestingAll((prev) => ({ ...prev, [selectorName]: true }))

    const targets = selector.all.filter((name) => {
      const p = proxies[name]
      return !p || !NO_DELAY_TYPES.has(p.type.toLowerCase())
    })

    const concurrency = 5
    for (let i = 0; i < targets.length; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency)
      await Promise.all(
        chunk.map(async (proxyName) => {
          const delay = await testDelay(proxyName)
          applyDelayResult(proxyName, delay)
        })
      )
    }

    setTestingAll((prev) => ({ ...prev, [selectorName]: false }))
  }

  async function testSingle(proxyName: string) {
    setTestingSingle((prev) => ({ ...prev, [proxyName]: true }))
    const delay = await testDelay(proxyName)
    applyDelayResult(proxyName, delay)
    setTestingSingle((prev) => ({ ...prev, [proxyName]: false }))
  }

  const selectors = useMemo(() => {
    const allSelectors = Object.values(proxies).filter((p) => {
      if (p.type !== 'Selector' || p.hidden) return false
      if (mode === 'global') return p.name === 'GLOBAL'
      return p.name !== 'GLOBAL'
    })

    const globalProxy = proxies['GLOBAL']
    if (!globalProxy?.all) return allSelectors

    const globalOrder = globalProxy.all.filter((name) => proxies[name]?.type === 'Selector')
    const orderMap = new Map(globalOrder.map((name, i) => [name, i]))

    return [...allSelectors].sort((a, b) => (orderMap.get(a.name) ?? Infinity) - (orderMap.get(b.name) ?? Infinity))
  }, [proxies, mode])

  if (loading) {
    return <div className="absolute inset-4 flex items-center justify-center text-muted-foreground text-sm">Загрузка...</div>
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 overflow-y-auto flex flex-col gap-4">
        {selectors.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Селекторы не найдены</div>
        ) : (
          selectors.map((selector) => {
            const allProxies = selector.all ?? []
            const isTesting = testingAll[selector.name]

            return (
              <div key={selector.name} className="rounded-xl border border-border bg-input-background p-4">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2 min-w-0 pl-0.5">
                    {selector.icon && (
                      <img
                        src={selector.icon}
                        alt=""
                        className="size-6 shrink-0 object-contain rounded-sm"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    )}
                    <span className="font-medium text-[15px] truncate">{selector.name}</span>
                    {selector.now && (
                      <>
                        <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground text-xs truncate">{selector.now}</span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-muted-foreground text-xs">Selector ({allProxies.length})</span>
                    <Button variant="outline" size="sm" className="h-7 w-7" onClick={() => testAll(selector.name)} disabled={isTesting}>
                      {isTesting ? <IconLoader2 size={13} className="animate-spin" /> : <IconBoltFilled size={13} />}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                  {allProxies.map((proxyName) => {
                    const proxy = proxies[proxyName]
                    const delay = proxy ? getLastDelay(proxy) : null
                    const isActive = selector.now === proxyName
                    const showDelay = proxy && !NO_DELAY_TYPES.has(proxy.type.toLowerCase())
                    const isTestingSingle = testingSingle[proxyName]

                    return (
                      <div
                        key={proxyName}
                        className={cn(
                          'flex flex-col gap-2 px-3 py-2.5 rounded-sm border cursor-pointer transition-all text-sm',
                          isActive
                            ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
                            : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5'
                        )}
                        onClick={() => selectProxy(selector.name, proxyName)}
                      >
                        <span className="text-xs font-medium truncate text-start">{proxyName}</span>

                        <div className="flex items-center justify-between gap-1">
                          {proxy && (
                            <span className="text-muted-foreground text-xs">
                              {proxy.type.toLowerCase()} / {proxy.xudp ? 'xudp' : proxy.udp ? 'udp' : 'tcp'}
                            </span>
                          )}

                          {showDelay && delay !== null && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={cn(
                                    'text-xs tabular-nums shrink-0 font-medium transition-opacity cursor-pointer',
                                    delayColor(delay),
                                    isTestingSingle && 'opacity-40'
                                  )}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (!isTestingSingle) testSingle(proxyName)
                                  }}
                                >
                                  {isTestingSingle ? <Spinner /> : delay || '—'}
                                </span>
                              </TooltipTrigger>
                              {proxy && proxy.history.length > 0 && (
                                <TooltipContent side="top" className="p-2">
                                  <div className="flex flex-col gap-1 min-w-[140px]">
                                    {proxy.history.map((entry, i) => (
                                      <div key={i} className="flex items-center justify-between gap-3 text-xs">
                                        <span className="tabular-nums">
                                          {new Date(entry.time).toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')}
                                        </span>
                                        <span className={cn('tabular-nums font-medium', delayColor(entry.delay))}>
                                          {entry.delay ? `${entry.delay}ms` : '—'}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </TooltipContent>
                              )}
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>
    </TooltipProvider>
  )
}
