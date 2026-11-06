import { DISPLAY_EVENT, readSelectorDisplay } from './SelectorDisplaySettings'
import { Button } from '@/components/ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { InputGroupAddon } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LazyMotion, domAnimation, m } from 'framer-motion'
import {
  IconBolt,
  IconChevronDown,
  IconChevronUp,
  IconCircleArrowRightFilled,
  IconLoader2,
  IconLock,
  IconPlugX,
  IconSearch,
  IconScaleOff,
  IconX,
} from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { clashFetch } from '../../../lib/api'
import { fetchClashProxies, getConnections, showToast, useProxiesStore, useSettings } from '../../../lib/store'
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
  smux?: boolean
  tfo?: boolean
  alive: boolean
  hidden?: boolean
  now?: string
  fixed?: string
  all?: string[]
  history: ProxyHistory[]
  'provider-name'?: string
  icon?: string
}

interface SmartNodeRank {
  Name: string
  Rank: string
  Weight: number
}

interface SmartNodeWeight {
  rank: string
  weight: number
  order: number
}

type ClashMode = 'rule' | 'global' | 'direct'

interface Props {
  clashApiPort: string
  mode: ClashMode
  clashApiSecret: string | null
  clashApiUnix?: string | null
  showHiddenSelectors?: boolean
  onCollapsedStateChange?: (collapsed: boolean) => void
}

const NO_DELAY_TYPES = new Set(['reject', 'reject-drop', 'dns', 'pass', 'relay'])
const SELECTOR_TYPES = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance', 'Smart'])
const AUTO_POLICY_TYPES = new Set(['Fallback', 'URLTest', 'LoadBalance', 'Smart'])
const COLLAPSE_SELECTORS_KEY = 'collapseSelectors'
const NO_SORT_TYPES = new Set([
  'Dns',
  'Compatible',
  'Direct',
  'Reject',
  'RejectDrop',
  'Pass',
  'Fallback',
  'URLTest',
  'LoadBalance',
  'Selector',
  'Smart',
])
const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'
const SMART_NOW_PLACEHOLDER = 'Smart - Select'
const SMART_RANK_LABELS: Record<string, string> = {
  MostUsed: 'часто',
  OccasionalUsed: 'иногда',
  RarelyUsed: 'редко',
}

interface SelectorsStore {
  testingAll: Record<string, boolean>
  testingSingle: Record<string, boolean>
  smartNodes: Record<string, Record<string, SmartNodeWeight>>
}

const useSelectorsStore = create<SelectorsStore>(() => ({
  testingAll: {},
  testingSingle: {},
  smartNodes: {},
}))

function isSmartType(type?: string): boolean {
  return type?.toLowerCase() === 'smart'
}

function isSmartPlaceholder(name?: string | null): boolean {
  return name === SMART_NOW_PLACEHOLDER
}

function getProxyHistory(proxy?: ProxyInfo): ProxyHistory[] {
  return Array.isArray(proxy?.history) ? proxy.history : []
}

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
  return getProxyHistory(proxy).at(-1)?.delay ?? null
}

function hasDelayHistory(proxy?: ProxyInfo): boolean {
  return !!proxy && !NO_DELAY_TYPES.has(proxy.type.toLowerCase()) && getProxyHistory(proxy).length > 0
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
  if (delay < 600) return 'text-yellow-300'
  return 'text-red-400'
}

function shouldShowDelay(proxy?: ProxyInfo, isTesting = false): boolean {
  if (!proxy || NO_DELAY_TYPES.has(proxy.type.toLowerCase())) return false
  return getLastDelay(proxy) !== null || isTesting
}

function hasNConsecutiveTimeouts(proxy: ProxyInfo | undefined, n: number): boolean {
  if (!proxy || n < 1) return false
  const history = getProxyHistory(proxy)
  if (history.length < n) return false
  return history.slice(-n).every((entry) => entry.delay === 0)
}

function sortProxyNames(proxyNames: string[], order: string, proxies: Record<string, ProxyInfo | undefined>): string[] {
  if (order === 'default') return proxyNames
  const sortable: { name: string; index: number; delay: number | null }[] = []
  const nonSortable: { name: string; index: number }[] = []
  proxyNames.forEach((name, index) => {
    const proxy = proxies[name]
    if (proxy && NO_SORT_TYPES.has(proxy.type)) {
      nonSortable.push({ name, index })
    } else {
      sortable.push({ name, index, delay: proxy ? getLastDelay(proxy) : null })
    }
  })
  if (order === 'name') {
    sortable.sort((a, b) => a.name.localeCompare(b.name))
  } else {
    sortable.sort((a, b) => {
      const aTimeout = a.delay === 0
      const bTimeout = b.delay === 0
      if (aTimeout && bTimeout) return 0
      if (aTimeout) return 1
      if (bTimeout) return -1
      if (a.delay === null && b.delay === null) return 0
      if (a.delay === null) return 1
      if (b.delay === null) return -1
      return a.delay - b.delay
    })
  }
  const result = new Array(proxyNames.length)
  for (const item of nonSortable) result[item.index] = item.name
  let sortIdx = 0
  for (let i = 0; i < result.length; i++) {
    if (result[i] === undefined) {
      result[i] = sortable[sortIdx++].name
    }
  }
  return result
}

function getChainData(proxies: Record<string, ProxyInfo | undefined>, startName?: string): string {
  const parts: string[] = []
  let current = startName
  const visited = new Set<string>()

  while (current && !visited.has(current)) {
    visited.add(current)
    if (isSmartPlaceholder(current)) {
      parts.push('Автовыбор', '')
      break
    }
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
  const smartInfo = useSelectorsStore((s) => s.smartNodes[selectorName]?.[proxyName])

  const chainStr = useProxiesStore((s): string => {
    const p = s.proxies[proxyName] as ProxyInfo | undefined
    return !p || !SELECTOR_TYPES.has(p.type) || !p.now ? '' : getChainData(s.proxies as Record<string, ProxyInfo | undefined>, proxyName)
  })
  const chain = useMemo(() => parseChain(chainStr), [chainStr])

  if (!proxy) return null

  const delay = getLastDelay(proxy)
  const hasHistory = hasDelayHistory(proxy)
  const history = getProxyHistory(proxy)
  const canTest = !NO_DELAY_TYPES.has(proxy.type.toLowerCase())
  const selectionDisabled = lockSelection || isSelectionDisabled(autoPolicy, proxy)
  const smartLabel = smartInfo ? (SMART_RANK_LABELS[smartInfo.rank] ?? smartInfo.rank) : null
  const showTcpOnly = proxy.udp === false
  return (
    <div
      className={cn(
        'text-foreground flex flex-col gap-2.5 rounded-md border px-3 py-2.5 text-sm transition-all',
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
      onContextMenu={(e) => {
        e.preventDefault()
        if (canTest && !isTestingSingle) onTestSingle(proxyName)
      }}
    >
      <div className="text-foreground flex min-w-0 items-center gap-1.5">
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
        <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5 text-xs tracking-wide">
            <span>{proxy.type.toLowerCase()}</span>
            {showTcpOnly && (
              <>
                <span className="bg-muted-foreground/40 size-0.5 rounded-full" />
                <span className="text-red-400">tcp only</span>
              </>
            )}
            {proxy.smux && (
              <>
                <span className="bg-muted-foreground/40 size-0.5 rounded-full" />
                <span>smux</span>
              </>
            )}
            {proxy.tfo && (
              <>
                <span className="bg-muted-foreground/40 size-0.5 rounded-full" />
                <span>tfo</span>
              </>
            )}
            {smartLabel && (
              <>
                <span className="bg-muted-foreground/40 size-0.5 rounded-full" />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          smartInfo!.rank === 'MostUsed' && 'text-green-400',
                          smartInfo!.rank === 'OccasionalUsed' && 'text-yellow-300'
                        )}
                      >
                        {smartLabel}
                      </span>
                    }
                  />
                  <TooltipContent>Smart-вес: {smartInfo!.weight.toFixed(1)}%</TooltipContent>
                </Tooltip>
              </>
            )}
        </div>

        {canTest && (
          <Tooltip>
            <TooltipTrigger
              render={
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
                    <IconBolt size={13} className="text-foreground" />
                  )}
                </span>
              }
            />
            {history.length > 0 ? (
              <TooltipContent side="top" className="p-2">
                <div className="flex min-w-35 flex-col gap-1">
                  {history.map((entry, i) => (
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
            ) : (
              <TooltipContent>Замерить отклик</TooltipContent>
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
  const chainStr = useProxiesStore((s) => {
    const now = (s.proxies[selectorName] as ProxyInfo | undefined)?.now
    if (!now) return ''
    return getChainData(s.proxies as Record<string, ProxyInfo | undefined>, now)
  })
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
              className="size-4 shrink-0 object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          )}
          {i === 0 && fixedProxyName === item.name && onClearFixed && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="flex size-4 shrink-0 items-center justify-center rounded-sm text-purple-400 transition-colors hover:text-purple-300 disabled:opacity-50"
                    onClick={handleClearFixed}
                    disabled={isClearingFixed}
                    aria-label="Снять фиксацию выбора"
                  >
                    {isClearingFixed ? <IconLoader2 size={12} className="animate-spin" /> : <IconLock size={17} />}
                  </button>
                }
              />
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
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-slot="proxy-delay-test"
                className={cn(
                  'ml-auto flex h-5 min-w-8 shrink-0 cursor-pointer items-center justify-center bg-transparent px-1.5 text-xs font-medium tabular-nums outline-hidden',
                  showDelay ? delayColor(delay) : 'text-foreground!'
                )}
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
                {isTestingSingle ? <Spinner /> : hasHistory ? delay || <GraveIcon size={14} /> : <IconBolt className="size-3.5" />}
              </button>
            }
          />
          <TooltipContent>Замерить отклик</TooltipContent>
        </Tooltip>
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
  const rawValue = selector?.now ?? null
  const value = isSmartPlaceholder(rawValue) ? null : rawValue
  const selectedProxy = useProxiesStore((s) => (value ? (s.proxies[value] as ProxyInfo | undefined) : undefined))
  const isFixed = !!value && selector?.fixed === value
  const isSmart = isSmartType(selector?.type)
  const disabledOptions = useProxiesStore(
    useShallow((s) =>
      Object.fromEntries(
        options.map((proxyName) => [
          proxyName,
          lockSelection || isSelectionDisabled(autoPolicy, s.proxies[proxyName] as ProxyInfo | undefined),
        ])
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
        placeholder={lockSelection || isSmart ? 'Автовыбор' : 'Выберите прокси'}
      >
        {selectedProxy?.icon && (
          <InputGroupAddon align="inline-start">
            <img
              src={selectedProxy.icon}
              alt=""
              className="size-4 shrink-0 object-contain"
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
  display,
  onTestAll,
  onSelect,
  onTestSingle,
  onClearFixed,
  onFlushSmart,
  activePickerSelector,
  onPickerChange,
  collapsed,
  onToggleCollapse,
}: {
  selectorName: string
  display: 'standard' | 'columns' | 'tiles' | 'popup'
  onTestAll: (name: string) => void
  onSelect: (selectorName: string, proxyName: string) => void
  onTestSingle: (proxyName: string) => Promise<void>
  onClearFixed: (selectorName: string) => Promise<void>
  onFlushSmart: (selectorName: string) => Promise<void>
  activePickerSelector: string | null
  onPickerChange: (selectorName: string | null) => void
  collapsed: boolean
  onToggleCollapse: (name: string) => void
}) {
  const selector = useProxiesStore((s) => s.proxies[selectorName] as ProxyInfo | undefined)
  const isTesting = useSelectorsStore((s) => !!s.testingAll[selectorName])
  const selectedProxy = useProxiesStore((s) => {
    const currentName = (s.proxies[selectorName] as ProxyInfo | undefined)?.now
    return currentName ? (s.proxies[currentName] as ProxyInfo | undefined) : undefined
  })
  const smartNodesForGroup = useSelectorsStore((s) => s.smartNodes[selectorName])
  const [isFlushingSmart, setIsFlushingSmart] = useState(false)
  const [flushConfirmOpen, setFlushConfirmOpen] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [pickerAnimationReady, setPickerAnimationReady] = useState(false)
  const [pickerClosing, setPickerClosing] = useState(false)
  const [pickerMotionBoxes, setPickerMotionBoxes] = useState<{
    from: { left: number; top: number; width: number; height: number }
    to: { left: number; top: number; width: number; height: number }
  } | null>(null)
  const pickerAnchorRef = useRef<HTMLDivElement>(null)
  const pickerCardRef = useRef<HTMLDivElement>(null)
  const pickerHeaderRef = useRef<HTMLDivElement>(null)
  const pickerGridRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isTestingSelected = useSelectorsStore((s) => (!!selector?.now ? !!s.testingSingle[selector.now] : false))
  const isPickerOpen = activePickerSelector === selectorName

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const updateViewport = () => setIsMobileViewport(media.matches)
    media.addEventListener('change', updateViewport)
    return () => media.removeEventListener('change', updateViewport)
  }, [])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    if (!isMobileViewport || !isPickerOpen) {
      setPickerAnimationReady(false)
      return
    }
    setPickerAnimationReady(false)
    const frame = window.requestAnimationFrame(() => {
      const width = window.innerWidth - 24
      const card = pickerCardRef.current
      const originalWidth = card?.style.width
      if (card) {
        card.style.width = `${width}px`
        card.getBoundingClientRect()
      }

      const heightLimit = Math.max(240, Math.min(window.innerHeight - 24, window.innerHeight * 0.82))
      const headerHeight = pickerHeaderRef.current?.getBoundingClientRect().height ?? 72
      const grid = pickerGridRef.current
      const pickerNodes = grid?.querySelectorAll<HTMLElement>(':scope > [data-picker-node]')
      const firstNode = pickerNodes?.item(0)?.getBoundingClientRect()
      const lastNode = pickerNodes && pickerNodes.length > 0 ? pickerNodes.item(pickerNodes.length - 1).getBoundingClientRect() : null
      const gridContentHeight = grid && firstNode && lastNode
        ? lastNode.bottom - grid.getBoundingClientRect().top
        : (grid?.scrollHeight ?? 0)
      const contentHeight = Math.ceil(headerHeight + gridContentHeight + 36)
      const height = Math.min(contentHeight, heightLimit)
      if (card) card.style.width = originalWidth ?? ''
      setPickerMotionBoxes((current) =>
        current
          ? {
              ...current,
              to: { left: 12, top: Math.max(12, (window.innerHeight - height) / 2), width, height },
            }
          : current
      )
      setPickerAnimationReady(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isMobileViewport, isPickerOpen])

  if (!selector) return null

  const allProxies = selector.all ?? []
  const autoPolicy = AUTO_POLICY_TYPES.has(selector.type)
  const lockSelection = selector.type === 'LoadBalance'
  const isSmart = isSmartType(selector.type)
  const isTestingSmart = useSelectorsStore((s) => !!s.testingAll[selectorName])

  const hideUnavailable = useSettings((s) => s.hideUnavailableProxies)
  const hideCounter = useSettings((s) => s.hideUnavailableProxiesCounter)
  const sortOrder = useSettings((s) => s.proxySortOrder)
  const allProxiesMap = useProxiesStore((s) => s.proxies as Record<string, ProxyInfo | undefined>)

  const filteredSortedProxies = useMemo(() => {
    let result = allProxies
    if (hideUnavailable) {
      result = result.filter((name) => !hasNConsecutiveTimeouts(allProxiesMap[name], hideCounter))
    }
    if (isSmart && sortOrder === 'default' && smartNodesForGroup) {
      const hasWeights = result.some((name) => smartNodesForGroup[name] !== undefined)
      if (hasWeights) {
        const orderOf = (name: string) => smartNodesForGroup[name]?.order ?? Number.MAX_SAFE_INTEGER
        result = [...result].sort((a, b) => orderOf(a) - orderOf(b))
      }
    } else if (sortOrder !== 'default') {
      result = sortProxyNames(result, sortOrder, allProxiesMap)
    }
    return result
  }, [allProxies, hideUnavailable, hideCounter, sortOrder, allProxiesMap, isSmart, smartNodesForGroup])

  const smartNodeDelays = isSmart
    ? filteredSortedProxies
        .map((name) => {
          const proxy = allProxiesMap[name]
          const delay = proxy ? getLastDelay(proxy) : null
          return delay !== null && delay > 0 ? delay : null
        })
        .filter((delay): delay is number => delay !== null)
    : []
  const selectedDelay = selectedProxy
    ? getLastDelay(selectedProxy)
    : isSmart
      ? (getLastDelay(selector) ?? (smartNodeDelays.length ? Math.min(...smartNodeDelays) : null))
      : null
  const showSelectedDelay = selectedDelay !== null && selectedDelay > 0
  const selectedDigits = showSelectedDelay && selectedDelay ? String(selectedDelay).length : 0

  const pickerProxies = useMemo(() => {
    const query = searchQuery.trim()
    if (!query) return filteredSortedProxies
    const normalized = query.toLocaleLowerCase()
    return filteredSortedProxies.filter((name) => name.toLocaleLowerCase().includes(normalized))
  }, [filteredSortedProxies, searchQuery])

  async function handleFlushSmartConfirm() {
    setFlushConfirmOpen(false)
    if (isFlushingSmart) return
    blurActiveElement()
    setIsFlushingSmart(true)
    try {
      await onFlushSmart(selectorName)
    } finally {
      setIsFlushingSmart(false)
    }
  }

  const useMultiColumnCollapse = display === 'columns' || display === 'tiles'
  const proxyCardGrid = (
    <div className={cn('grid gap-2', display === 'columns' ? 'grid-cols-3' : 'grid-cols-2')}>
      {filteredSortedProxies.map((proxyName) => (
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
  )

  if (display === 'popup') {
    const selectedName = selectedProxy ? selector.now : isSmart ? 'Автовыбор' : 'Не выбрано'
    const isOpen = activePickerSelector === selectorName
    const onPickerOpenChange = (open: boolean) => {
      if (open) {
        setPickerClosing(false)
        const rect = pickerAnchorRef.current?.getBoundingClientRect()
        if (rect) {
          const from = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          setPickerMotionBoxes({ from, to: from })
        }
        onPickerChange(selectorName)
      } else if (activePickerSelector === selectorName) {
        if (isMobileViewport) setPickerClosing(true)
        else onPickerChange(null)
      }
    }
    const trigger = (
      <button
        type="button"
        aria-label={`Открыть селектор ${selectorName}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className={cn(
          'border-border bg-input-background hover:bg-input-background-hover! flex w-full min-w-0 flex-col gap-2 rounded-xl border px-2.5 pt-2 pb-2.5 text-left transition-colors hover:border-[#60a5fa]/60 sm:px-3 sm:pt-2.5 sm:pb-3',
          isOpen && 'border-[#60a5fa]!'
        )}
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-[15px] font-medium">{selectorName}</span>
          {selector.icon && (
            <img src={selector.icon} alt="" className="size-8 shrink-0 rounded-sm object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          )}
        </span>
        <span className="text-muted-foreground truncate text-[10px] uppercase tracking-wide">
          {selector.type} · {filteredSortedProxies.length}
          {allProxies.length !== filteredSortedProxies.length ? `/${allProxies.length}` : ''}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pr-9 text-[13px]">
          <IconCircleArrowRightFilled size={12} className="text-muted-foreground shrink-0" />
          {selectedProxy?.icon && (
            <img src={selectedProxy.icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
          )}
          <span className="min-w-0 flex-1 truncate">{selectedName}</span>
        </span>
      </button>
    )
    const pickerHeading = (
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
        <span className="truncate">{selectorName}</span>
        <IconCircleArrowRightFilled size={12} className="text-muted-foreground shrink-0" />
        {selectedProxy?.icon && (
          <img src={selectedProxy.icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        )}
        <span className="truncate">{selectedName}</span>
      </div>
    )
    const proxyCards = pickerProxies.map((proxyName) => (
      <div key={proxyName} data-picker-node>
        <ProxyCard
          proxyName={proxyName}
          selectorName={selectorName}
          autoPolicy={autoPolicy}
          lockSelection={lockSelection}
          onSelect={(groupName, selectedProxyName) => {
            onSelect(groupName, selectedProxyName)
            if (!isMobileViewport) onPickerChange(null)
          }}
          onTestSingle={onTestSingle}
        />
      </div>
    ))

    if (isMobileViewport) {
      return (
        <LazyMotion features={domAnimation}>
        <Dialog open={isOpen} onOpenChange={onPickerOpenChange}>
          <div className="relative isolate" ref={pickerAnchorRef}>
            <DialogTrigger render={trigger} />
            <div className="absolute right-2.5 bottom-2.5 z-10 flex items-center">
              {(selectedProxy && !NO_DELAY_TYPES.has(selectedProxy.type.toLowerCase())) || isSmart ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={selectedProxy ? `Проверить сервер ${selector.now}` : `Проверить серверы ${selectorName}`}
                        className={cn('flex min-w-7 items-center justify-end bg-transparent text-xs font-medium tabular-nums', delayColor(selectedDelay))}
                        disabled={selectedProxy && !NO_DELAY_TYPES.has(selectedProxy.type.toLowerCase()) ? isTestingSelected : isTestingSmart}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (selectedProxy && !NO_DELAY_TYPES.has(selectedProxy.type.toLowerCase()) && !isTestingSelected && selector.now) {
                            void onTestSingle(selector.now)
                          } else if (isSmart && !isTestingSmart) {
                            onTestAll(selectorName)
                          }
                        }}
                      >
                        {(selectedProxy && !NO_DELAY_TYPES.has(selectedProxy.type.toLowerCase()) ? isTestingSelected : isTestingSmart) ? (
                          <IconLoader2 size={13} className="animate-spin" />
                        ) : hasDelayHistory(selectedProxy) ? (
                          selectedDelay || <GraveIcon size={14} />
                        ) : isSmart && showSelectedDelay ? (
                          selectedDelay
                        ) : (
                          <IconBolt size={13} className="text-foreground" />
                        )}
                      </button>
                    }
                  />
                  <TooltipContent>{selectedProxy ? 'Проверить выбранный сервер' : 'Проверить серверы селектора'}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          <DialogContent
            showCloseButton={false}
            overlayClassName="!animate-none !duration-0"
            overlayRender={
              <m.div
                aria-hidden="true"
                className="fixed inset-0 isolate z-40 bg-[#020817]/80"
                onClick={() => onPickerOpenChange(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: pickerClosing ? 0 : 1 }}
                transition={{ duration: 0.25, ease: [0, 0, 0.2, 1] }}
              />
            }
            className="!fixed !inset-0 !h-[100dvh] !w-screen !max-w-none !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !bg-transparent !p-0 !ring-0 !animate-none !transition-none !duration-0"
            style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh', maxWidth: 'none', transform: 'none', display: 'block', pointerEvents: 'none' }}
          >
              <m.div
                ref={pickerCardRef}
                initial={pickerMotionBoxes?.from ?? { left: 12, top: 12, width: window.innerWidth - 24, height: 120 }}
                animate={
                  pickerClosing
                    ? (pickerMotionBoxes?.from ?? { left: 12, top: 12, width: window.innerWidth - 24, height: 120 })
                    : pickerAnimationReady
                      ? (pickerMotionBoxes?.to ?? { left: 12, top: 12, width: window.innerWidth - 24, height: 120 })
                      : (pickerMotionBoxes?.from ?? { left: 12, top: 12, width: window.innerWidth - 24, height: 120 })
                }
                transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                onAnimationComplete={() => {
                  if (!pickerClosing) return
                  if (activePickerSelector === selectorName) onPickerChange(null)
                }}
                style={{ position: 'absolute', overflow: 'hidden', pointerEvents: pickerClosing ? 'none' : 'auto' }}
                onClick={(event) => {
                  const target = event.target as HTMLElement
                  if (!searchOpen || target.closest('button, input, [data-picker-node]')) return
                  setSearchOpen(false)
                  setSearchQuery('')
                }}
                className="bg-input-background border-border text-foreground font-sans flex max-h-[calc(100dvh-1.5rem)] min-w-0 flex-col gap-2.5 overflow-hidden rounded-xl border p-3 shadow-xl"
              >
                <DialogHeader ref={pickerHeaderRef} className="gap-2">
                  <DialogTitle className="sr-only">Выбор сервера для {selectorName}</DialogTitle>
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {pickerHeading}
                      <div className="text-muted-foreground mt-2 flex min-w-0 items-center gap-1.5 text-xs">
                        <span className="shrink-0">Selector ({filteredSortedProxies.length})</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 shrink-0"
                          aria-label={searchOpen ? 'Закрыть поиск серверов' : 'Поиск серверов'}
                          aria-expanded={searchOpen}
                          onClick={() => {
                            if (searchOpen) setSearchQuery('')
                            setSearchOpen((open) => !open)
                          }}
                        >
                          {searchOpen ? <IconX size={14} /> : <IconSearch size={14} />}
                        </Button>
                      </div>
                    </div>
                    <div className="-mt-1 flex shrink-0 flex-col items-center gap-1">
                      {selector.icon && (
                        <img
                          src={selector.icon}
                          alt=""
                          className="size-8 rounded-sm object-contain"
                          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                        />
                      )}
                      <div className="flex items-center gap-1">
                        {isSmart && (
                          <Popover open={flushConfirmOpen} onOpenChange={setFlushConfirmOpen}>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <PopoverTrigger
                                    render={
                                      <Button
                                        variant="outline"
                                        size="icon-xs"
                                        className="!size-7"
                                        aria-label="Сбросить smart-веса"
                                        disabled={isFlushingSmart}
                                      >
                                        {isFlushingSmart ? <IconLoader2 size={13} className="animate-spin" /> : <IconScaleOff size={13} />}
                                      </Button>
                                    }
                                  />
                                }
                              />
                              {!flushConfirmOpen && <TooltipContent>Сбросить smart-веса</TooltipContent>}
                            </Tooltip>
                            <PopoverContent align="end">
                              <PopoverHeader>
                                <PopoverTitle>Вы уверены, что хотите сбросить smart-веса?</PopoverTitle>
                              </PopoverHeader>
                              <div className="flex justify-end gap-2">
                                <Button size="sm" variant="outline" onClick={() => setFlushConfirmOpen(false)}>
                                  Нет
                                </Button>
                                <Button size="sm" variant="destructive" onClick={() => void handleFlushSmartConfirm()}>
                                  Да
                                </Button>
                              </div>
                            </PopoverContent>
                          </Popover>
                        )}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="outline"
                              size={selectedDigits === 0 ? 'icon-xs' : 'sm'}
                              aria-label="Проверить все серверы селектора"
                              className={cn(
                                '!h-7',
                                selectedDigits > 0 && ['!min-w-7 justify-center !px-1 text-xs font-medium tabular-nums', delayColor(selectedDelay)]
                              )}
                              style={selectedDigits > 0 ? { width: `calc(${selectedDigits}ch + 0.75rem)` } : undefined}
                              disabled={isTesting}
                              onClick={() => onTestAll(selectorName)}
                            >
                              {isTesting ? (
                                <IconLoader2 size={13} className="animate-spin" />
                              ) : showSelectedDelay ? (
                                selectedDelay
                              ) : (
                                <IconBolt size={13} />
                              )}
                            </Button>
                          }
                        />
                        <TooltipContent>Проверить все серверы</TooltipContent>
                      </Tooltip>
                      </div>
                    </div>
                  </div>
                  {searchOpen && (
                    <div className="relative">
                      <Input
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Поиск серверов"
                        aria-label="Поиск серверов"
                        className="h-8 pr-8 font-sans text-foreground placeholder:text-muted-foreground"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                          aria-label="Очистить поиск"
                          onClick={() => setSearchQuery('')}
                        >
                          <IconX size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </DialogHeader>
                <m.div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: pickerAnimationReady && !pickerClosing ? 1 : 0 }}
                  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                >
                  <div ref={pickerGridRef} className="grid grid-cols-2 content-start gap-2 font-sans text-foreground">
                    {proxyCards.length > 0 ? proxyCards : <div className="text-muted-foreground col-span-full py-6 text-center text-sm">Ничего не найдено</div>}
                  </div>
                </m.div>
              </m.div>
          </DialogContent>
        </Dialog>
        </LazyMotion>
      )
    }

    return (
      <Popover open={isOpen} onOpenChange={onPickerOpenChange}>
        <PopoverTrigger render={trigger} />
        <PopoverContent
          align="center"
          sideOffset={4}
          className="border-border! bg-input-background! gap-2.5 p-3"
          style={{ width: 'min(46rem, calc(100vw - 1.5rem))', maxWidth: 'calc(100vw - 1.5rem)' }}
        >
          <PopoverHeader className="flex-row items-center justify-start gap-3">
            <PopoverTitle className="sr-only">Выбор сервера для {selectorName}</PopoverTitle>
            {pickerHeading}
          </PopoverHeader>
          <div className="max-h-[min(70dvh,36rem)] overflow-y-auto overscroll-contain pr-1">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{proxyCards}</div>
          </div>
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <div
      className={cn(
        'border-border bg-input-background rounded-xl border',
        useMultiColumnCollapse && collapsed ? 'px-4 pt-4 pb-3' : 'p-4'
      )}
    >
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
            {isSmart && (
              <Popover open={flushConfirmOpen} onOpenChange={setFlushConfirmOpen}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <PopoverTrigger
                        render={
                          <Button variant="outline" size="icon-sm" aria-label="Сбросить smart-веса" disabled={isFlushingSmart}>
                            {isFlushingSmart ? <IconLoader2 size={13} className="animate-spin" /> : <IconScaleOff size={13} />}
                          </Button>
                        }
                      />
                    }
                  />
                  {!flushConfirmOpen && <TooltipContent>Сбросить smart-веса</TooltipContent>}
                </Tooltip>
                <PopoverContent>
                  <PopoverHeader>
                    <PopoverTitle>Вы уверены, что хотите сбросить smart-веса?</PopoverTitle>
                  </PopoverHeader>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setFlushConfirmOpen(false)}>
                      Нет
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => void handleFlushSmartConfirm()}>
                      Да
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={collapsed ? 'Развернуть селектор' : 'Свернуть селектор'}
              onMouseDown={blurActiveElement}
              onClick={() => onToggleCollapse(selectorName)}
            >
              {collapsed ? <IconChevronDown size={13} /> : <IconChevronUp size={13} />}
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size={selectedDigits === 0 ? 'icon-sm' : 'sm'}
                    className={cn(
                      selectedDigits > 0 && ['min-w-8 justify-center px-0 text-xs font-medium tabular-nums', delayColor(selectedDelay)]
                    )}
                    style={selectedDigits > 0 ? { width: `calc(${selectedDigits}ch + 1rem)` } : undefined}
                    onClick={() => onTestAll(selectorName)}
                    disabled={isTesting}
                  >
                    {isTesting ? (
                      <IconLoader2 size={13} className="animate-spin" />
                    ) : showSelectedDelay ? (
                      selectedDelay
                    ) : (
                      <IconBolt size={13} />
                    )}
                  </Button>
                }
              />
              <TooltipContent>Замерить отклик</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <SelectorStatusRow
          selectorName={selectorName}
          label={`${selector.type} (${filteredSortedProxies.length}${allProxies.length !== filteredSortedProxies.length ? `/${allProxies.length}` : ''})`}
          fixedProxyName={autoPolicy ? selector.fixed : undefined}
          onClearFixed={autoPolicy && selector.fixed ? () => onClearFixed(selectorName) : undefined}
        />
      </div>

      {useMultiColumnCollapse ? (
        <>
          <div
            className={cn(
              'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
              collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            )}
          >
            <div className="min-h-0 overflow-hidden">{proxyCardGrid}</div>
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
                options={filteredSortedProxies}
                autoPolicy={autoPolicy}
                lockSelection={lockSelection}
                onSelect={onSelect}
                onTestSingle={onTestSingle}
                visible={collapsed}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-0">
          <div
            className={cn(
              'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
              collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className={cn('grid gap-2', display === 'standard' ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5' : 'grid-cols-2')}>
                {filteredSortedProxies.map((proxyName) => (
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
                options={filteredSortedProxies}
                autoPolicy={autoPolicy}
                lockSelection={lockSelection}
                onSelect={onSelect}
                onTestSingle={onTestSingle}
                visible={collapsed}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

/* ====================== ОСНОВНОЙ КОМПОНЕНТ ====================== */
export function SelectorsPanel({ clashApiPort, mode, clashApiSecret, clashApiUnix, showHiddenSelectors, onCollapsedStateChange }: Props) {
  const [display, setDisplay] = useState(readSelectorDisplay)
  useEffect(() => {
    const update = () => setDisplay(readSelectorDisplay())
    window.addEventListener(DISPLAY_EVENT, update)
    window.addEventListener('storage', update)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener(DISPLAY_EVENT, update)
      window.removeEventListener('storage', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  const loading = useProxiesStore((s) => s.loading)
  const error = useProxiesStore((s) => s.error)
  const pingTestUrl = useSettings((s) => s.pingTestUrl)
  const pingTestTimeout = useSettings((s) => s.pingTestTimeout)
  const [collapsedSelectors, setCollapsedSelectors] = useState<Record<string, boolean>>(() => readCollapsedSelectors())
  const [activePickerSelector, setActivePickerSelector] = useState<string | null>(null)

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

  const fetchSmartWeights = useCallback(async () => {
    try {
      const data = await clashFetch<{ weights?: Record<string, SmartNodeRank[]> }>(clashApiPort, 'group/weights', {
        secret: clashApiSecret,
        unix: clashApiUnix ?? null,
        retry: false,
      })
      const weights = data.weights
      if (!weights || typeof weights !== 'object') return
      const next: Record<string, Record<string, SmartNodeWeight>> = {}
      for (const [group, items] of Object.entries(weights)) {
        if (!Array.isArray(items) || items.length === 0) continue
        const map: Record<string, SmartNodeWeight> = {}
        items.forEach((item, index) => {
          if (!item?.Name) return
          map[item.Name] = {
            rank: item.Rank ?? '',
            weight: typeof item.Weight === 'number' ? item.Weight : 0,
            order: index,
          }
        })
        next[group] = map
      }
      useSelectorsStore.setState({ smartNodes: next })
    } catch {
      /* ядро без поддержки smart (нет GET /group/weights) */
    }
  }, [clashApiPort, clashApiSecret, clashApiUnix])

  const flushSmartWeights = useCallback(
    async (selectorName?: string) => {
      try {
        await clashFetch(clashApiPort, 'cache/smart/flush', {
          method: 'POST',
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
          retry: false,
        })
        await fetchSmartWeights()
        showToast(selectorName ? `Smart-веса для «${selectorName}» сброшены` : 'Smart-веса сброшены')
      } catch {
        showToast('Не удалось сбросить smart-веса', 'error')
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix, fetchSmartWeights]
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
        const newHistory = [...getProxyHistory(proxy), { time, delay }].slice(-10)
        next[name] = { ...proxy, history: newHistory, alive: delay > 0 }
        changed = true
      }
      return changed ? { proxies: next } : {}
    })
  }, [])

  const selectorNames = useProxiesStore(
    useShallow((s) => {
      const allSelectors = Object.values(s.proxies).filter((p: any) => {
        if (!SELECTOR_TYPES.has(p.type)) return false
        if (p.hidden && !showHiddenSelectors) return false
        return mode === 'global' ? p.name === 'GLOBAL' : p.name !== 'GLOBAL'
      }) as ProxyInfo[]
      const globalProxy = s.proxies['GLOBAL'] as ProxyInfo | undefined
      if (!globalProxy?.all) return allSelectors.map((p) => p.name)
      const globalOrder = globalProxy.all.filter((name) => SELECTOR_TYPES.has((s.proxies[name] as any)?.type))
      const orderMap = new Map(globalOrder.map((name, i) => [name, i]))
      return [...allSelectors].sort((a, b) => (orderMap.get(a.name) ?? Infinity) - (orderMap.get(b.name) ?? Infinity)).map((p) => p.name)
    })
  )

  const selectorColumnCount = display === 'columns' ? 2 : display === 'tiles' ? 3 : 1
  const selectorColumns = useMemo(() => {
    const columns = Array.from({ length: selectorColumnCount }, () => [] as string[])
    selectorNames.forEach((name, index) => columns[index % selectorColumnCount].push(name))
    return columns
  }, [selectorColumnCount, selectorNames])

  const renderSelector = (name: string) => (
    <SelectorRow
      key={name}
      selectorName={name}
      display={display}
      onTestAll={testAll}
      onSelect={selectProxy}
      onTestSingle={testSingle}
      onClearFixed={clearFixedSelection}
      onFlushSmart={flushSmartWeights}
      activePickerSelector={activePickerSelector}
      onPickerChange={setActivePickerSelector}
      collapsed={!!collapsedSelectors[name]}
      onToggleCollapse={toggleCollapse}
    />
  )

  const persistedCollapsedSelectors = useMemo(
    () => Object.fromEntries(selectorNames.map((name) => [name, collapsedSelectors[name] ?? false])),
    [selectorNames, collapsedSelectors]
  )

  const hasSmartSelector = useProxiesStore(
    useShallow((s) =>
      Object.values(s.proxies).some((p: any) => typeof p?.type === 'string' && isSmartType(p.type) && (showHiddenSelectors || !p.hidden))
    )
  )

  useEffect(() => {
    if (hasSmartSelector) void fetchSmartWeights()
  }, [hasSmartSelector, fetchSmartWeights])

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
    <TooltipProvider delayDuration={500}>
      <div className="absolute inset-4 scrollbar-thin overflow-y-auto">
        {display === 'columns' || display === 'tiles' ? (
          <div className="flex items-start gap-4">
            {selectorColumns.map((column, index) => (
              <div key={index} className="flex min-w-0 flex-1 basis-0 flex-col gap-4">
                {column.map(renderSelector)}
              </div>
            ))}
          </div>
        ) : (
          <div className={cn('min-w-0', display === 'popup' ? 'grid grid-cols-2 items-start content-start gap-2 sm:gap-4 xl:grid-cols-3' : 'flex flex-col gap-4')}>
            {selectorColumns[0].map(renderSelector)}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
