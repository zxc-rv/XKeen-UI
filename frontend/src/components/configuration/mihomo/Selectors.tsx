import { Button } from '@/components/ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroupAddon } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { IconBoltFilled, IconChevronDown, IconChevronUp, IconCircleArrowRightFilled, IconLoader2, IconPlugX } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
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
  clashApiUnix?: string | null
  onCollapsedStateChange?: (collapsed: boolean) => void
}

const NO_DELAY_TYPES = new Set(['reject', 'dns', 'pass', 'relay'])
const SELECTOR_TYPES = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance'])
const COLLAPSE_SELECTORS_KEY = 'collapseSelectors'
const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'

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

function shouldShowDelay(proxy?: ProxyInfo, isTesting = false): boolean {
  if (!proxy || NO_DELAY_TYPES.has(proxy.type.toLowerCase())) return false
  return getLastDelay(proxy) !== null || isTesting
}

function getProxyTransport(proxy?: Pick<ProxyInfo, 'udp' | 'xudp'>): string | null {
  if (!proxy) return null
  if (proxy.xudp) return 'XUDP'
  return proxy.udp ? 'UDP' : 'TCP'
}

function getChainData(proxies: Record<string, ProxyInfo | undefined>, startName?: string): string {
  const parts: string[] = []
  let current = startName
  const visited = new Set<string>()

  while (current && !visited.has(current)) {
    visited.add(current)
    const proxy = proxies[current]
    parts.push(current, proxy?.icon ?? '')
    if (!proxy || !SELECTOR_TYPES.has(proxy.type) || !proxy.now) break
    current = proxy.now
  }

  return parts.join('\x00')
}

function parseChain(chainStr: string) {
  if (!chainStr) return []
  const parts = chainStr.split('\x00')
  return Array.from({ length: parts.length / 2 }, (_, i) => ({ name: parts[i * 2], icon: parts[i * 2 + 1] || undefined }))
}

function readCollapsedSelectors(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}

  try {
    const raw = localStorage.getItem(COLLAPSE_SELECTORS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object') return {}

    const next: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') next[key] = value
    }
    return next
  } catch {
    return {}
  }
}

function blurActiveElement() {
  if (typeof document === 'undefined') return
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
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
    return !p || !SELECTOR_TYPES.has(p.type) || !p.now ? '' : getChainData(s.proxies as Record<string, ProxyInfo | undefined>, proxyName)
  })
  const chain = useMemo(() => parseChain(chainStr), [chainStr])

  if (!proxy) return null

  const delay = getLastDelay(proxy)
  const showDelayBadge = !NO_DELAY_TYPES.has(proxy.type.toLowerCase()) && (delay !== null || isTestingSingle)
  const transport = getProxyTransport(proxy)?.toLowerCase() ?? proxy.type.toLowerCase()

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

/* ====================== МЕТА-СТРОКА СЕЛЕКТОРА ====================== */
const SelectorStatusRow = memo(function SelectorStatusRow({ selectorName, label }: { selectorName: string; label: string }) {
  const chainStr = useProxiesStore((s) =>
    getChainData(s.proxies as Record<string, ProxyInfo | undefined>, (s.proxies[selectorName] as ProxyInfo | undefined)?.now)
  )
  const chain = useMemo(() => parseChain(chainStr), [chainStr])

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-[13px]">
      <span className="truncate">{label}</span>
      {chain.map((item) => (
        <div key={item.name} className="flex min-w-0 items-center gap-1">
          <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
          {item.icon && (
            <img
              src={item.icon}
              alt=""
              className="size-4 shrink-0 rounded-sm object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          )}
          <span className="truncate">{item.name}</span>
        </div>
      ))}
    </div>
  )
})

const CollapsedProxyOption = memo(function CollapsedProxyOption({ proxyName }: { proxyName: string }) {
  const proxy = useProxiesStore((s) => s.proxies[proxyName] as ProxyInfo | undefined)
  const delay = proxy ? getLastDelay(proxy) : null
  const showDelay = shouldShowDelay(proxy)

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {proxy?.icon && (
          <img
            src={proxy.icon}
            alt=""
            className="size-4 shrink-0 rounded-sm object-contain"
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        )}
        <span className="truncate">{proxyName}</span>
      </div>
      <span className={cn('min-w-8 shrink-0 text-right text-xs font-medium tabular-nums', showDelay ? delayColor(delay) : 'invisible')}>
        {showDelay ? (delay ?? '—') : '0'}
      </span>
    </div>
  )
})

const SelectorCombobox = memo(function SelectorCombobox({
  selectorName,
  options,
  onSelect,
  visible,
}: {
  selectorName: string
  options: string[]
  onSelect: (selectorName: string, proxyName: string) => void
  visible: boolean
}) {
  const selector = useProxiesStore((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const value = selector?.now ?? null
  const selectedProxy = useProxiesStore((s) => (value ? (s.proxies[value] as ProxyInfo | undefined) : undefined))
  const isFixed = !!value && selector?.fixed === value
  const [open, setOpen] = useState(false)

  return (
    <Combobox
      items={options}
      value={value}
      open={visible ? open : false}
      itemToStringLabel={(item) => item}
      itemToStringValue={(item) => item}
      onOpenChange={setOpen}
      onValueChange={(proxyName) => proxyName && onSelect(selectorName, proxyName)}
      autoHighlight
    >
      <ComboboxInput
        className={cn('w-full', isFixed && 'border-purple-400! hover:border-purple-400!')}
        openBorderColor={isFixed ? '#c084fc' : undefined}
        openShadowColor={isFixed ? 'rgba(192,132,252,0.2)' : undefined}
        placeholder="Выберите прокси"
      >
        {selectedProxy?.icon && (
          <InputGroupAddon align="inline-start">
            <img
              src={selectedProxy.icon}
              alt=""
              className="size-4 shrink-0 rounded-sm object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          </InputGroupAddon>
        )}
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>Ничего не найдено</ComboboxEmpty>
        <ComboboxList>
          {(proxyName: string) => (
            <ComboboxItem key={proxyName} value={proxyName}>
              <CollapsedProxyOption proxyName={proxyName} />
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
})

/* ====================== СТРОКА СЕЛЕКТОРА ====================== */
const SelectorRow = memo(function SelectorRow({
  selectorName,
  onTestAll,
  onSelect,
  onTestSingle,
  collapsed,
  onToggleCollapse,
}: {
  selectorName: string
  onTestAll: (name: string) => void
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
  collapsed: boolean
  onToggleCollapse: (name: string) => void
}) {
  const selector = useProxiesStore((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const isTesting = useSelectorsStore((s) => !!s.testingAll[selectorName])
  const selectedProxy = useProxiesStore((s) => {
    const currentName = (s.proxies[selectorName] as ProxyInfo | undefined)?.now
    return currentName ? (s.proxies[currentName] as ProxyInfo | undefined) : undefined
  })

  if (!selector) return null

  const allProxies = selector.all ?? []
  const selectedDelay = selectedProxy ? getLastDelay(selectedProxy) : null
  const showSelectedDelay = !!selectedProxy && selectedDelay !== null && selectedDelay > 0

  return (
    <div className="border-border bg-input-background rounded-xl border p-4">
      <div className="mb-2.5 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
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

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={collapsed ? 'Развернуть селектор' : 'Свернуть селектор'}
              onMouseDown={blurActiveElement}
              onClick={() => onToggleCollapse(selectorName)}
            >
              {collapsed ? <IconChevronDown size={13} /> : <IconChevronUp size={13} />}
            </Button>
            <Button
              variant="outline"
              size={showSelectedDelay ? 'sm' : 'icon-sm'}
              className={cn(showSelectedDelay && 'px-2 text-xs font-medium tabular-nums', showSelectedDelay && delayColor(selectedDelay))}
              onClick={() => onTestAll(selectorName)}
              disabled={isTesting}
            >
              {isTesting ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : showSelectedDelay ? (
                selectedDelay
              ) : (
                <IconBoltFilled size={13} />
              )}
            </Button>
          </div>
        </div>

        <SelectorStatusRow selectorName={selectorName} label={`${selector.type} (${allProxies.length})`} />
      </div>

      <div className="flex flex-col gap-0">
        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
            collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {allProxies.map((proxyName) => (
                <ProxyCard
                  key={proxyName}
                  proxyName={proxyName}
                  selectorName={selectorName}
                  onSelect={onSelect}
                  onTestSingle={onTestSingle}
                />
              ))}
            </div>
          </div>
        </div>

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
            collapsed ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className={cn('min-h-0', collapsed ? 'overflow-visible' : 'overflow-hidden')}>
            <SelectorCombobox
              key={collapsed ? `${selectorName}-collapsed` : `${selectorName}-expanded`}
              selectorName={selectorName}
              options={allProxies}
              onSelect={onSelect}
              visible={collapsed}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

/* ====================== ОСНОВНОЙ КОМПОНЕНТ ====================== */
export function SelectorsPanel({ clashApiPort, mode, clashApiSecret, clashApiUnix, onCollapsedStateChange }: Props) {
  const loading = useProxiesStore((s) => s.loading)
  const error = useProxiesStore((s) => s.error)
  const [collapsedSelectors, setCollapsedSelectors] = useState<Record<string, boolean>>(() => readCollapsedSelectors())

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

  const persistedCollapsedSelectors = useMemo(
    () => Object.fromEntries(selectorNames.map((name) => [name, collapsedSelectors[name] ?? false])),
    [selectorNames, collapsedSelectors]
  )

  useEffect(() => {
    localStorage.setItem(COLLAPSE_SELECTORS_KEY, JSON.stringify(persistedCollapsedSelectors))
  }, [persistedCollapsedSelectors])

  useEffect(() => {
    onCollapsedStateChange?.(selectorNames.length > 0 && selectorNames.every((name) => persistedCollapsedSelectors[name]))
  }, [onCollapsedStateChange, persistedCollapsedSelectors, selectorNames])

  useEffect(() => {
    function handleToggleAll(event: Event) {
      const collapsed = (event as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed
      if (typeof collapsed !== 'boolean') return
      blurActiveElement()
      setCollapsedSelectors((prev) => {
        const next = { ...prev }
        for (const name of selectorNames) next[name] = collapsed
        return next
      })
    }

    window.addEventListener(TOGGLE_ALL_SELECTORS_EVENT, handleToggleAll as EventListener)
    return () => window.removeEventListener(TOGGLE_ALL_SELECTORS_EVENT, handleToggleAll as EventListener)
  }, [selectorNames])

  const testSingle = useCallback(
    async (proxyName: string) => {
      useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: true } }))
      let delay: number | null = null
      try {
        const data = await clashFetch<{ delay?: number }>(
          clashApiPort,
          `proxies/${encodeURIComponent(proxyName)}/delay?url=https://www.gstatic.com/generate_204&timeout=5000`,
          { secret: clashApiSecret, unix: clashApiUnix ?? null }
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
    [clashApiPort, clashApiSecret, clashApiUnix]
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
            unix: clashApiUnix ?? null,
            body: { name: proxyName },
          })
          await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
          const affected = getConnections()
            .filter((conn) => conn.chains?.includes(selectorName))
            .map((conn) => conn.id)
          await Promise.all(
            affected.map((id) =>
              clashFetch(clashApiPort, `connections/${id}`, { method: 'DELETE', secret: clashApiSecret, unix: clashApiUnix ?? null })
            )
          )
        } catch {
          /* */
        }
      })()
    },
    [clashApiPort, clashApiSecret, clashApiUnix]
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
          { secret: clashApiSecret, unix: clashApiUnix ?? null }
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
      await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
    },
    [clashApiPort, clashApiSecret, clashApiUnix]
  )

  const toggleCollapse = useCallback((selectorName: string) => {
    blurActiveElement()
    setCollapsedSelectors((prev) => ({ ...prev, [selectorName]: !prev[selectorName] }))
  }, [])

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
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchClashProxies(clashApiPort, clashApiSecret, false, clashApiUnix ?? null)}
            >
              Повторить
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={700}>
      <div className="absolute inset-4 flex flex-col gap-4 overflow-y-auto [scrollbar-width:thin]">
        {selectorNames.map((name) => (
          <SelectorRow
            key={name}
            selectorName={name}
            onTestAll={testAll}
            onSelect={selectProxy}
            onTestSingle={testSingle}
            collapsed={!!collapsedSelectors[name]}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}
