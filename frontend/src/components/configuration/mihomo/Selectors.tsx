import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { IconBoltFilled, IconCircleArrowRightFilled, IconLoader2, IconPlugX } from '@tabler/icons-react'
import { memo, useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { clashFetch } from '../../../lib/api'
import { fetchClashProxies, getConnections, useProxiesStore } from '../../../lib/store'

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
  fixed?: string
  all?: string[]
  history: ProxyHistory[]
  'provider-name'?: string
  icon?: string
}

type ClashMode = 'rule' | 'global' | 'direct'

interface Props {
  clashApiPort: string
  mode: ClashMode
  clashApiSecret: string | null
}

const NO_DELAY_TYPES = new Set(['reject', 'dns', 'pass', 'relay'])
const SELECTOR_TYPES = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance'])

interface SelectorsStore {
  testingAll: Record<string, boolean>
  testingSingle: Record<string, boolean>
}

const useSelectorsStore = create<SelectorsStore>(() => ({
  testingAll: {},
  testingSingle: {},
}))

function getLastDelay(proxy: ProxyInfo): number | null {
  if (NO_DELAY_TYPES.has(proxy.type.toLowerCase())) return null
  return proxy.history.length > 0 ? proxy.history.at(-1)!.delay : null
}

function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-400'
  return 'text-red-400'
}

/* ====================== ОДИНОЧНАЯ КАРТОЧКА ====================== */
const ProxyCard = memo(function ProxyCard({
  proxyName,
  selectorName,
  onSelect,
  onTestSingle,
}: {
  proxyName: string
  selectorName: string
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
}) {
  const proxy = useProxiesStore((s) => s.proxies[proxyName] as ProxyInfo | undefined)
  const isActive = useProxiesStore((s) => (s.proxies[selectorName] as ProxyInfo | undefined)?.now === proxyName)
  const isFixed = useProxiesStore((s) => (s.proxies[selectorName] as ProxyInfo | undefined)?.fixed === proxyName)
  const isTestingSingle = useSelectorsStore((s) => !!s.testingSingle[proxyName])

  const chainStr = useProxiesStore((s): string => {
    const p = s.proxies[proxyName] as ProxyInfo | undefined
    if (!p || !SELECTOR_TYPES.has(p.type) || !p.now) return ''
    const parts: string[] = [proxyName, p.icon ?? '']
    let current: string | undefined = p.now
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      visited.add(current)
      const next = s.proxies[current] as ProxyInfo | undefined
      parts.push(current, next?.icon ?? '')
      if (!next || !SELECTOR_TYPES.has(next.type) || !next.now) break
      current = next.now
    }
    return parts.join('\x00')
  })
  const chain = useMemo(() => {
    if (!chainStr) return []
    const parts = chainStr.split('\x00')
    return Array.from({ length: parts.length / 2 }, (_, i) => ({ name: parts[i * 2], icon: parts[i * 2 + 1] || undefined }))
  }, [chainStr])

  if (!proxy) return null

  const delay = getLastDelay(proxy)
  const showDelayBadge = !NO_DELAY_TYPES.has(proxy.type.toLowerCase()) && (delay !== null || isTestingSingle)
  const transport = proxy.xudp ? 'xudp' : proxy.udp ? 'udp' : 'tcp'

  return (
    <div
      className={cn(
        'flex cursor-pointer flex-col gap-2 rounded-sm border px-3 py-2.5 text-sm transition-all',
        isFixed
          ? 'border-purple-400 bg-linear-to-b from-purple-500/25 to-purple-500/15'
          : isActive
            ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
            : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5'
      )}
      onClick={() => onSelect(selectorName, proxyName)}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {proxy.icon && (
          <img
            src={proxy.icon}
            alt=""
            className="size-4 shrink-0 rounded-sm object-contain"
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        )}
        {chain.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate text-[13px] font-medium">{proxyName}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="p-2">
              <div className="flex flex-wrap items-center gap-1">
                {chain.map((item, i) => (
                  <div key={item.name} className="flex items-center gap-1">
                    {i > 0 && <IconCircleArrowRightFilled size={10} className="text-muted-foreground shrink-0" />}
                    {item.icon && (
                      <img
                        src={item.icon}
                        alt=""
                        className="size-3.5 shrink-0 rounded-sm object-contain"
                        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                      />
                    )}
                    <span className="text-[13px]">{item.name}</span>
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="truncate text-[13px] font-medium">{proxyName}</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-1">
        <span className="text-muted-foreground text-xs">
          {proxy.type.toLowerCase()} / {transport}
        </span>

        {showDelayBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'shrink-0 cursor-pointer text-xs font-medium tabular-nums transition-opacity',
                  delayColor(delay),
                  isTestingSingle && 'opacity-40'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isTestingSingle) onTestSingle(proxyName)
                }}
              >
                {isTestingSingle ? <Spinner /> : delay || '—'}
              </span>
            </TooltipTrigger>
            {proxy.history.length > 0 && (
              <TooltipContent side="top" className="p-2">
                <div className="flex min-w-35 flex-col gap-1">
                  {proxy.history.map((entry, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="tabular-nums">
                        {new Date(entry.time).toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')}
                      </span>
                      <span className={cn('font-medium tabular-nums', delayColor(entry.delay))}>
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
})

/* ====================== NOW-СТРОКА СЕЛЕКТОРА ====================== */
const SelectorNowRow = memo(function SelectorNowRow({ selectorName }: { selectorName: string }) {
  const chainStr = useProxiesStore((s): string => {
    const parts: string[] = []
    let current = (s.proxies[selectorName] as ProxyInfo | undefined)?.now
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      visited.add(current)
      const proxy = s.proxies[current] as ProxyInfo | undefined
      parts.push(current, proxy?.icon ?? '')
      if (!proxy || !SELECTOR_TYPES.has(proxy.type) || !proxy.now) break
      current = proxy.now
    }
    return parts.join('\x00')
  })

  const chain = useMemo(() => {
    if (!chainStr) return []
    const parts = chainStr.split('\x00')
    return Array.from({ length: parts.length / 2 }, (_, i) => ({ name: parts[i * 2], icon: parts[i * 2 + 1] || undefined }))
  }, [chainStr])

  if (chain.length === 0) return null

  return (
    <div className="mt-1.5 mb-1 flex flex-wrap items-center gap-1">
      {chain.map((item) => (
        <div key={item.name} className="flex items-center gap-1">
          <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
          {item.icon && (
            <img
              src={item.icon}
              alt=""
              className="size-4 shrink-0 rounded-sm object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          )}
          <span className="text-muted-foreground truncate text-[13px]">{item.name}</span>
        </div>
      ))}
    </div>
  )
})

/* ====================== СТРОКА СЕЛЕКТОРА ====================== */
const SelectorRow = memo(function SelectorRow({
  selectorName,
  onTestAll,
  onSelect,
  onTestSingle,
}: {
  selectorName: string
  onTestAll: (name: string) => void
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
}) {
  const selector = useProxiesStore((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const isTesting = useSelectorsStore((s) => !!s.testingAll[selectorName])

  if (!selector) return null

  const allProxies = selector.all ?? []

  return (
    <div className="border-border bg-input-background rounded-xl border p-4">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            {selector.icon && (
              <img
                src={selector.icon}
                alt=""
                className="size-6 shrink-0 rounded-sm object-contain"
                onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
              />
            )}
            <span className="truncate text-[15px] font-medium">{selectorName}</span>
          </div>
          {selector.now && <SelectorNowRow selectorName={selectorName} />}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-gray-400">
            {selector.type} ({allProxies.length})
          </span>
          <Button variant="outline" size="icon-sm" onClick={() => onTestAll(selectorName)} disabled={isTesting}>
            {isTesting ? <IconLoader2 size={13} className="animate-spin" /> : <IconBoltFilled size={13} />}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {allProxies.map((proxyName) => (
          <ProxyCard key={proxyName} proxyName={proxyName} selectorName={selectorName} onSelect={onSelect} onTestSingle={onTestSingle} />
        ))}
      </div>
    </div>
  )
})

/* ====================== ОСНОВНОЙ КОМПОНЕНТ ====================== */
export function SelectorsPanel({ clashApiPort, mode, clashApiSecret }: Props) {
  const loading = useProxiesStore((s) => s.loading)
  const error = useProxiesStore((s) => s.error)

  const selectorNames = useProxiesStore(
    useShallow((s) => {
      const allSelectors = Object.values(s.proxies).filter((p: any) => {
        if (!SELECTOR_TYPES.has(p.type) || p.hidden) return false
        return mode === 'global' ? p.name === 'GLOBAL' : p.name !== 'GLOBAL'
      }) as ProxyInfo[]
      const globalProxy = s.proxies['GLOBAL'] as ProxyInfo | undefined
      if (!globalProxy?.all) return allSelectors.map((p) => p.name)
      const globalOrder = globalProxy.all.filter((name) => SELECTOR_TYPES.has((s.proxies[name] as any)?.type))
      const orderMap = new Map(globalOrder.map((name, i) => [name, i]))
      return [...allSelectors].sort((a, b) => (orderMap.get(a.name) ?? Infinity) - (orderMap.get(b.name) ?? Infinity)).map((p) => p.name)
    })
  )

  const testSingle = useCallback(
    async (proxyName: string) => {
      useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: true } }))
      let delay: number | null = null
      try {
        const data = await clashFetch<{ delay?: number }>(
          clashApiPort,
          `proxies/${encodeURIComponent(proxyName)}/delay?url=https://www.gstatic.com/generate_204&timeout=5000`,
          { secret: clashApiSecret }
        )
        delay = data.delay ?? null
      } catch {
        /* */
      }
      useProxiesStore.setState((state) => {
        const proxy = state.proxies[proxyName] as ProxyInfo | undefined
        if (!proxy) return {}
        const newHistory = delay !== null ? [...proxy.history, { time: new Date().toISOString(), delay }].slice(-10) : proxy.history
        return { proxies: { ...state.proxies, [proxyName]: { ...proxy, history: newHistory, alive: delay !== null } } }
      })
      useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: false } }))
    },
    [clashApiPort, clashApiSecret]
  )

  const selectProxy = useCallback(
    (selectorName: string, proxyName: string) => {
      useProxiesStore.setState((state) => ({
        proxies: { ...state.proxies, [selectorName]: { ...state.proxies[selectorName], now: proxyName } },
      }))
      ;(async () => {
        try {
          await clashFetch(clashApiPort, `proxies/${encodeURIComponent(selectorName)}`, {
            method: 'PUT',
            secret: clashApiSecret,
            body: { name: proxyName },
          })
          await fetchClashProxies(clashApiPort, clashApiSecret, true)
          const affected = getConnections()
            .filter((conn) => conn.chains?.includes(selectorName))
            .map((conn) => conn.id)
          await Promise.all(
            affected.map((id) => clashFetch(clashApiPort, `connections/${id}`, { method: 'DELETE', secret: clashApiSecret }))
          )
        } catch {
          /* */
        }
      })()
    },
    [clashApiPort, clashApiSecret]
  )

  const testAll = useCallback(
    async (selectorName: string) => {
      const selector = useProxiesStore.getState().proxies[selectorName] as ProxyInfo | undefined
      if (!selector?.all) return

      useSelectorsStore.setState((s) => ({ testingAll: { ...s.testingAll, [selectorName]: true } }))

      try {
        const delays = await clashFetch<Record<string, number>>(
          clashApiPort,
          `group/${encodeURIComponent(selectorName)}/delay?url=https://www.gstatic.com/generate_204&timeout=5000`,
          { secret: clashApiSecret }
        )

        useProxiesStore.setState((state) => {
          const next = { ...state.proxies }
          for (const [name, delay] of Object.entries(delays)) {
            const proxy = state.proxies[name] as ProxyInfo | undefined
            if (!proxy) continue
            const effectiveDelay = delay > 0 ? delay : null
            const newHistory =
              effectiveDelay !== null
                ? [...proxy.history, { time: new Date().toISOString(), delay: effectiveDelay }].slice(-10)
                : proxy.history
            next[name] = { ...proxy, history: newHistory, alive: effectiveDelay !== null }
          }
          return { proxies: next }
        })
      } catch {
        /* */
      }

      useSelectorsStore.setState((s) => ({ testingAll: { ...s.testingAll, [selectorName]: false } }))
      await fetchClashProxies(clashApiPort, clashApiSecret, true)
    },
    [clashApiPort, clashApiSecret]
  )

  if (loading) {
    return (
      <div className="text-muted-foreground absolute inset-4 flex items-center justify-center text-sm">
        <Spinner className="mr-2 size-5" /> Загрузка...
      </div>
    )
  }

  if (error || selectorNames.length === 0) {
    return (
      <div className="absolute inset-4">
        <Empty className="text-muted-foreground border-border absolute inset-0 gap-3 rounded-xl border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconPlugX />
            </EmptyMedia>
            <EmptyTitle className="text-sm tracking-normal">
              <span>{error ? 'Ошибка загрузки данных Clash API' : 'Селекторы не найдены'}</span>
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => fetchClashProxies(clashApiPort, clashApiSecret)}>
              Повторить
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 flex flex-col gap-4 overflow-y-auto">
        {selectorNames.map((name) => (
          <SelectorRow key={name} selectorName={name} onTestAll={testAll} onSelect={selectProxy} onTestSingle={testSingle} />
        ))}
      </div>
    </TooltipProvider>
  )
}
