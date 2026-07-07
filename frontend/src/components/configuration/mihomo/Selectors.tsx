import { Button } from '@/components/ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroupAddon } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  IconBoltFilled,
  IconChevronDown,
  IconChevronUp,
  IconCircleArrowRightFilled,
  IconLoader2,
  IconLock,
  IconPlugX,
} from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { clashFetch } from '../../../lib/api'
import { fetchClashProxies, getConnections, useProxiesStore, useSettings } from '../../../lib/store'
import { DEFAULT_PING_TEST_TIMEOUT, DEFAULT_PING_TEST_URL } from '../../../lib/types'

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

const NO_DELAY_TYPES = new Set(['reject', 'reject-drop', 'dns', 'pass', 'relay'])
const SELECTOR_TYPES = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance'])
const AUTO_POLICY_TYPES = new Set(['Fallback', 'URLTest', 'LoadBalance'])
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

function GraveIcon({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" className={className} style={{ width: size, height: size }}>
      <rect x="46.913" y="424.382" width="418.175" height="87.618" />
      <path d="M263.957 0h-15.916C160.059 0 88.737 71.322 88.737 159.305v238.941h334.525V159.305C423.262 71.322 351.941 0 263.957 0m75.009 225.189h-61.389v95.91h-43.155v-95.91h-61.389v-43.304h61.389v-59.918h43.155v59.918h61.389z" />
    </svg>
  )
}

function getLastDelay(proxy: ProxyInfo): number | null {
  if (NO_DELAY_TYPES.has(proxy.type.toLowerCase())) return null
  return proxy.history.length > 0 ? proxy.history.at(-1)!.delay : null
}

function hasDelayHistory(proxy?: ProxyInfo): boolean {
  return !!proxy && !NO_DELAY_TYPES.has(proxy.type.toLowerCase()) && proxy.history.length > 0
}

function isTimedOutProxy(proxy?: ProxyInfo): boolean {
  return !!proxy && hasDelayHistory(proxy) && getLastDelay(proxy) === 0
}

function isSelectionDisabled(autoPolicy: boolean, proxy?: ProxyInfo): boolean {
  return autoPolicy && isTimedOutProxy(proxy)
}

function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-400'
  return 'text-red-400'
}

function delayColorImportant(delay: number | null): string {
  if (!delay) return 'text-red-400!'
  if (delay < 300) return 'text-green-400!'
  if (delay < 600) return 'text-yellow-400!'
  return 'text-red-400!'
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
  autoPolicy,
  lockSelection,
  onSelect,
  onTestSingle,
}: {
  proxyName: string
  selectorName: string
  autoPolicy: boolean
  lockSelection?: boolean
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
  const hasHistory = hasDelayHistory(proxy)
  const canTest = !NO_DELAY_TYPES.has(proxy.type.toLowerCase())
  const selectionDisabled = lockSelection || isSelectionDisabled(autoPolicy, proxy)
  const transport = getProxyTransport(proxy)?.toLowerCase() ?? proxy.type.toLowerCase()

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-sm border px-3 py-2.5 text-sm transition-all',
        selectionDisabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        isFixed
          ? 'border-purple-400 bg-linear-to-b from-purple-500/25 to-purple-500/15'
          : isActive
            ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
            : selectionDisabled
              ? 'border-ring/35 bg-[linear-gradient(135deg,rgba(148,163,184,0.08)_0%,transparent_55%)]'
              : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5'
      )}
      onClick={() => !selectionDisabled && onSelect(selectorName, proxyName)}
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
            <TooltipTrigger render={<span className="truncate text-[13px] font-medium">{proxyName}</span>} />
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

        {canTest && (
          <Tooltip>
            <TooltipTrigger render={
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
                {isTestingSingle ? (
                  <Spinner />
                ) : hasHistory ? (
                  delay || <GraveIcon size={14} />
                ) : (
                  <IconBoltFilled size={13} className="text-foreground" />
                )}
              </span>
            } />
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
const SelectorStatusRow = memo(function SelectorStatusRow({
  selectorName,
  label,
  fixedProxyName,
  onClearFixed,
}: {
  selectorName: string
  label: string
  fixedProxyName?: string
  onClearFixed?: () => Promise<void>
}) {
  const chainStr = useProxiesStore((s) =>
    getChainData(s.proxies as Record<string, ProxyInfo | undefined>, (s.proxies[selectorName] as ProxyInfo | undefined)?.now)
  )
  const chain = useMemo(() => parseChain(chainStr), [chainStr])
  const [isClearingFixed, setIsClearingFixed] = useState(false)

  async function handleClearFixed(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (!onClearFixed || isClearingFixed) return
    blurActiveElement()
    setIsClearingFixed(true)
    try {
      await onClearFixed()
    } finally {
      setIsClearingFixed(false)
    }
  }

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-[13px]">
      <span className="truncate">{label}</span>
      {chain.map((item, i) => (
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
          {i === 0 && fixedProxyName === item.name && onClearFixed && (
            <Tooltip>
              <TooltipTrigger render={
                <button
                  type="button"
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm text-purple-400 transition-colors hover:text-purple-300 disabled:opacity-50"
                  onClick={handleClearFixed}
                  disabled={isClearingFixed}
                  aria-label="Снять фиксацию выбора"
                >
                  {isClearingFixed ? <IconLoader2 size={12} className="animate-spin" /> : <IconLock size={17} />}
                </button>
              } />
              <TooltipContent>Снять фиксацию</TooltipContent>
            </Tooltip>
          )}
          <span className="truncate">{item.name}</span>
        </div>
      ))}
    </div>
  )
})

const CollapsedProxyOption = memo(function CollapsedProxyOption({
  proxyName,
  disabled,
  onTestSingle,
}: {
  proxyName: string
  disabled: boolean
  onTestSingle: (proxyName: string) => Promise<void>
}) {
  const proxy = useProxiesStore((s) => s.proxies[proxyName] as ProxyInfo | undefined)
  const isTestingSingle = useSelectorsStore((s) => !!s.testingSingle[proxyName])
  const delay = proxy ? getLastDelay(proxy) : null
  const hasHistory = hasDelayHistory(proxy)
  const showDelay = shouldShowDelay(proxy, isTestingSingle)
  const canTest = !!proxy && !NO_DELAY_TYPES.has(proxy.type.toLowerCase())

  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', disabled && 'opacity-70')}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
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
      {canTest && (
        <button
          type="button"
          data-slot="proxy-delay-test"
          className={cn(
            'ml-auto flex h-5 min-w-8 shrink-0 cursor-pointer items-center justify-center bg-transparent px-1.5 text-xs font-medium tabular-nums outline-hidden',
            showDelay ? delayColorImportant(delay) : 'text-foreground!'
          )}
          style={showDelay ? undefined : { color: '#fff' }}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (!isTestingSingle) void onTestSingle(proxyName)
          }}
        >
          {isTestingSingle ? <Spinner /> : hasHistory ? delay || <GraveIcon size={14} /> : <IconBoltFilled className="size-3.5" />}
        </button>
      )}
    </div>
  )
})

const SelectorCombobox = memo(function SelectorCombobox({
  selectorName,
  options,
  autoPolicy,
  lockSelection,
  onSelect,
  onTestSingle,
  visible,
}: {
  selectorName: string
  options: string[]
  autoPolicy: boolean
  lockSelection?: boolean
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
  visible: boolean
}) {
  const selector = useProxiesStore((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const value = selector?.now ?? null
  const selectedProxy = useProxiesStore((s) => (value ? (s.proxies[value] as ProxyInfo | undefined) : undefined))
  const isFixed = !!value && selector?.fixed === value
  const disabledOptions = useProxiesStore(
    useShallow((s) =>
      Object.fromEntries(
        options.map((proxyName) => [proxyName, lockSelection || isSelectionDisabled(autoPolicy, s.proxies[proxyName] as ProxyInfo | undefined)])
      )
    )
  )
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(false)
    }
  }, [visible])

  return (
    <Combobox
      items={options}
      value={value}
      open={visible ? open : false}
      itemToStringLabel={(item) => item}
      itemToStringValue={(item) => item}
      onOpenChange={setOpen}
      onValueChange={(proxyName) => proxyName && !disabledOptions[proxyName] && onSelect(selectorName, proxyName)}
      autoHighlight
    >
      <ComboboxInput
        fullWidth
        className={cn(
          'w-full *:data-[slot=input-group-control]:bg-transparent! *:data-[slot=input-group-control]:hover:bg-transparent! *:data-[slot=input-group-control]:focus:bg-transparent! *:data-[slot=input-group-control]:focus-visible:bg-transparent!',
          isFixed && 'border-purple-400! hover:border-purple-400!'
        )}
        openBorderColor={isFixed ? '#c084fc' : undefined}
        openShadowColor={isFixed ? 'rgba(192,132,252,0.2)' : undefined}
        placeholder={lockSelection ? 'Балансировка нагрузки' : 'Выберите прокси'}
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
            <ComboboxItem
              key={proxyName}
              value={proxyName}
              aria-disabled={disabledOptions[proxyName] || undefined}
              className={cn(
                disabledOptions[proxyName] &&
                'pointer-events-none cursor-not-allowed opacity-70 [&_[data-slot=proxy-delay-test]]:pointer-events-auto'
              )}
            >
              <CollapsedProxyOption proxyName={proxyName} disabled={!!disabledOptions[proxyName]} onTestSingle={onTestSingle} />
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
  onClearFixed,
  collapsed,
  onToggleCollapse,
}: {
  selectorName: string
  onTestAll: (name: string) => void
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
  onClearFixed: (selectorName: string) => Promise<void>
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
  const autoPolicy = AUTO_POLICY_TYPES.has(selector.type)
  const lockSelection = selector.type === 'LoadBalance'
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

        <SelectorStatusRow
          selectorName={selectorName}
          label={`${selector.type} (${allProxies.length})`}
          fixedProxyName={autoPolicy ? selector.fixed : undefined}
          onClearFixed={autoPolicy && selector.fixed ? () => onClearFixed(selectorName) : undefined}
        />
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
                  autoPolicy={autoPolicy}
                  lockSelection={lockSelection}
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
              key={selectorName}
              selectorName={selectorName}
              options={allProxies}
              autoPolicy={autoPolicy}
              lockSelection={lockSelection}
              onSelect={onSelect}
              onTestSingle={onTestSingle}
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
  const pingTestUrl = useSettings((s) => s.pingTestUrl)
  const pingTestTimeout = useSettings((s) => s.pingTestTimeout)
  const [collapsedSelectors, setCollapsedSelectors] = useState<Record<string, boolean>>(() => readCollapsedSelectors())

  const pingTestQuery = useMemo(() => {
    const url = pingTestUrl.trim() || DEFAULT_PING_TEST_URL
    const timeout = Number.isFinite(pingTestTimeout) && pingTestTimeout > 0 ? Math.trunc(pingTestTimeout) : DEFAULT_PING_TEST_TIMEOUT
    return `url=${encodeURIComponent(url)}&timeout=${timeout}`
  }, [pingTestTimeout, pingTestUrl])

  const clearFixedSelection = useCallback(
    async (selectorName: string) => {
      try {
        await clashFetch(clashApiPort, `proxies/${encodeURIComponent(selectorName)}`, {
          method: 'DELETE',
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
        })
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
      } catch {
        /* */
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix]
  )

  const requestProxyDelay = useCallback(
    async (proxyName: string) => {
      try {
        const providerName = (useProxiesStore.getState().proxies[proxyName] as ProxyInfo | undefined)?.['provider-name']
        const endpoint = providerName
          ? `providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent(proxyName)}/healthcheck?${pingTestQuery}`
          : `proxies/${encodeURIComponent(proxyName)}/delay?${pingTestQuery}`
        const data = await clashFetch<{ delay?: number }>(clashApiPort, endpoint, {
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
          retry: false,
        })
        return data.delay && data.delay > 0 ? data.delay : 0
      } catch {
        return 0
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix, pingTestQuery]
  )

  const applyDelayResults = useCallback((results: ReadonlyArray<readonly [string, number]>) => {
    if (!results.length) return
    const time = new Date().toISOString()
    useProxiesStore.setState((state) => {
      const next = { ...state.proxies }
      let changed = false
      for (const [name, delay] of results) {
        const proxy = state.proxies[name] as ProxyInfo | undefined
        if (!proxy) continue
        const newHistory = [...proxy.history, { time, delay }].slice(-10)
        next[name] = { ...proxy, history: newHistory, alive: delay > 0 }
        changed = true
      }
      return changed ? { proxies: next } : {}
    })
  }, [])

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
      try {
        applyDelayResults([[proxyName, await requestProxyDelay(proxyName)]])
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
      } catch {
        /* */
      } finally {
        useSelectorsStore.setState((s) => ({ testingSingle: { ...s.testingSingle, [proxyName]: false } }))
      }
    },
    [applyDelayResults, clashApiPort, clashApiSecret, clashApiUnix, requestProxyDelay]
  )

  const selectProxy = useCallback(
    (selectorName: string, proxyName: string) => {
      const proxies = useProxiesStore.getState().proxies as Record<string, ProxyInfo | undefined>
      if (isSelectionDisabled(AUTO_POLICY_TYPES.has(proxies[selectorName]?.type ?? ''), proxies[proxyName])) return

      useProxiesStore.setState((state) => ({
        proxies: { ...state.proxies, [selectorName]: { ...state.proxies[selectorName], now: proxyName } },
      }))
        ; (async () => {
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
        const proxies = useProxiesStore.getState().proxies as Record<string, ProxyInfo | undefined>
        const results = await Promise.all(
          selector.all
            .filter((name) => {
              const type = proxies[name]?.type?.toLowerCase()
              return !!type && !NO_DELAY_TYPES.has(type)
            })
            .map(async (name) => [name, await requestProxyDelay(name)] as const)
        )
        applyDelayResults(results)
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
      } catch {
        /* */
      } finally {
        useSelectorsStore.setState((s) => ({ testingAll: { ...s.testingAll, [selectorName]: false } }))
      }
    },
    [applyDelayResults, clashApiPort, clashApiSecret, clashApiUnix, requestProxyDelay]
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
      <div className="absolute inset-4 flex scrollbar-thin flex-col gap-4 overflow-y-auto">
        {selectorNames.map((name) => (
          <SelectorRow
            key={name}
            selectorName={name}
            onTestAll={testAll}
            onSelect={selectProxy}
            onTestSingle={testSingle}
            onClearFixed={clearFixedSelection}
            collapsed={!!collapsedSelectors[name]}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}
