import { Button } from '@/components/ui/button'
import { ClearIcon } from '@/components/ui/clear-icon'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconActivity,
  IconArrowDown,
  IconArrowsSort,
  IconArrowUp,
  IconBan,
  IconCircleArrowRightFilled,
  IconFilter,
  IconLetterCase,
  IconLoader2,
  IconPlugX,
  IconX,
} from '@tabler/icons-react'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { CONNECTIONS_DISPLAY_EVENT, readConnectionsDisplay } from './ConnectionsDisplaySettings'
import { DISPLAY_EVENT } from './SelectorDisplaySettings'
import { apiCall, clashFetch } from '../../../lib/api'
import { getConnections, subscribeConnections, useNowStore, useProxiesStore, useSettings, useWsConnected } from '../../../lib/store'
interface ConnectionMetadata {
  network: string
  type: string
  sourceIP: string
  destinationIP: string
  sourcePort: string
  destinationPort: string
  inboundIP: string
  inboundPort: string
  inboundName: string
  host: string
  dnsMode: string
  uid: number
  process: string
  processPath: string
  remoteDestination: string
  sniffHost: string
  smartBlock?: string
  destinationGeoIP?: string
  destinationIPASN?: string
  sourceGeoIP?: string
  sourceIPASN?: string
  specialProxy?: string
  specialRules?: string
  inboundUser?: string
  dscp?: number
}

interface Connection {
  id: string
  metadata: ConnectionMetadata
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains: string[]
  rule: string
  rulePayload: string
  downloadSpeed?: number
  uploadSpeed?: number
}

function highlightConnectionJson(json: string): ReactNode[] {
  const tokenPattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g
  return json.split('\n').map((line, lineIndex) => {
    const parts: ReactNode[] = []
    let lastIndex = 0
    for (const match of line.matchAll(tokenPattern)) {
      const token = match[0]
      const index = match.index ?? 0
      if (index > lastIndex) parts.push(line.slice(lastIndex, index))
      const isKey = token.startsWith('"') && /^\s*:/.test(line.slice(index + token.length))
      const tokenClass = isKey
        ? 'text-foreground'
        : token.startsWith('"')
          ? 'text-[#13ce66]'
          : token === 'null'
            ? 'text-[#d55fde]'
            : 'text-[#1d8ce0]'
      parts.push(<span key={`${lineIndex}-${index}`} className={tokenClass}>{token}</span>)
      lastIndex = index + token.length
    }
    if (lastIndex < line.length) parts.push(line.slice(lastIndex))
    return <Fragment key={lineIndex}>{parts.length ? parts : line}</Fragment>
  })
}

type SortColumn = 'host' | 'protocol' | 'chains' | 'source' | 'start' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed' | null
type SortDirection = 'asc' | 'desc'

interface Props {
  clashApiPort: string
  clashApiSecret: string | null
  clashApiUnix?: string | null
}

interface DeviceListHost {
  ip?: string
  ip6?: string[]
  name?: string
  hostname?: string
}

interface DeviceListResponse {
  success?: boolean
  host?: DeviceListHost[]
}

// ─── Local store ───────────────────────────────────────────────────────────────

const toMap = (connections: Connection[]) => new Map(connections.map((c) => [c.id, c]))

const DIALOG_CLOSE_ANIMATION_MS = 220

type ConnectionsState = { map: Map<string, Connection>; closedMap: Map<string, Connection> }

const useConnectionsStore = create<ConnectionsState>(() => ({
  map: toMap(getConnections()),
  closedMap: new Map(),
}))

const SOURCE_NAME_MISS_RETRY_MS = 3000
const SOURCE_NAME_CACHE_CAP = 1000
const sourceNameCache = new Map<string, string | null>()
const sourceNameRetryAt = new Map<string, number>()
let sourceNameRetryTimer: ReturnType<typeof setTimeout> | null = null
let sourceNameRequest: Promise<void> | null = null
const useSourceNameStore = create<{ version: number }>(() => ({ version: 0 }))

function trimMap<K, V>(map: Map<K, V>, cap: number) {
  while (map.size > cap) {
    const firstKey = map.keys().next().value
    if (firstKey === undefined) break
    map.delete(firstKey)
  }
}
const MAX_CLOSED_CONNECTIONS = 1000

subscribeConnections((connections) => {
  const { map: prevMap, closedMap: prevClosed } = useConnectionsStore.getState()
  const normalizedConnections = connections.map((conn) => {
    const previous = prevMap.get(conn.id)
    return {
      ...conn,
      downloadSpeed: previous ? Math.max(0, conn.download - previous.download) : 0,
      uploadSpeed: previous ? Math.max(0, conn.upload - previous.upload) : 0,
    }
  })
  const newMap = toMap(normalizedConnections)
  let nextClosed = prevClosed
  for (const [id, conn] of prevMap) {
    if (!newMap.has(id) && !prevClosed.has(id)) {
      if (nextClosed === prevClosed) nextClosed = new Map(prevClosed)
      nextClosed.set(id, conn)
    }
  }
  if (nextClosed !== prevClosed && nextClosed.size > MAX_CLOSED_CONNECTIONS) {
    const excess = nextClosed.size - MAX_CLOSED_CONNECTIONS
    const iter = nextClosed.keys()
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value
      if (key === undefined) break
      nextClosed.delete(key)
    }
  }
  useConnectionsStore.setState({ map: newMap, closedMap: nextClosed })
})

const asnCache = new Map<string, string | null>()

function cleanDeviceIp(ip: unknown): string {
  return typeof ip === 'string' ? ip.trim() : ''
}

function isResolvableSourceIP(ip: string): boolean {
  return !!ip && ip !== '0.0.0.0' && ip !== '::'
}

function bumpSourceNameVersion() {
  useSourceNameStore.setState((s) => ({ version: s.version + 1 }))
}

function cacheSourceName(ip: string, name: string | null, retryAt?: number): boolean {
  const prevName = sourceNameCache.get(ip)
  const prevRetryAt = sourceNameRetryAt.get(ip)
  const hadCache = sourceNameCache.has(ip)

  if (hadCache) sourceNameCache.delete(ip)
  sourceNameCache.set(ip, name)
  if (name) sourceNameRetryAt.delete(ip)
  else if (retryAt) sourceNameRetryAt.set(ip, retryAt)
  else sourceNameRetryAt.delete(ip)

  trimMap(sourceNameCache, SOURCE_NAME_CACHE_CAP)
  trimMap(sourceNameRetryAt, SOURCE_NAME_CACHE_CAP)

  return !hadCache || prevName !== name || prevRetryAt !== sourceNameRetryAt.get(ip)
}

function cacheSourceNameMisses(sourceIps: string[], retryAt: number): boolean {
  let changed = false
  for (const ip of sourceIps) {
    if (isResolvableSourceIP(ip)) changed = cacheSourceName(ip, null, retryAt) || changed
  }
  return changed
}

function getActiveSourceIPs(): Set<string> {
  const ips = new Set<string>()
  for (const conn of useConnectionsStore.getState().map.values()) {
    const ip = conn.metadata.sourceIP
    if (isResolvableSourceIP(ip)) ips.add(ip)
  }
  return ips
}

function scheduleSourceNameRetry() {
  if (sourceNameRetryTimer) clearTimeout(sourceNameRetryTimer)

  const activeSourceIPs = getActiveSourceIPs()
  let nextRetryAt = Infinity
  const now = Date.now()
  for (const [ip, retryAt] of sourceNameRetryAt) {
    if (!activeSourceIPs.has(ip) || !sourceNameCache.has(ip) || sourceNameCache.get(ip) !== null) {
      sourceNameRetryAt.delete(ip)
      continue
    }
    nextRetryAt = Math.min(nextRetryAt, retryAt)
  }

  if (nextRetryAt !== Infinity) {
    sourceNameRetryTimer = setTimeout(
      () => {
        sourceNameRetryTimer = null
        bumpSourceNameVersion()
      },
      Math.max(0, nextRetryAt - now)
    )
  }
}

function shouldRefreshSourceName(ip: string, now = Date.now()): boolean {
  if (!isResolvableSourceIP(ip)) return false
  if (!sourceNameCache.has(ip)) return true
  return sourceNameCache.get(ip) === null && (sourceNameRetryAt.get(ip) ?? 0) <= now
}

function collectRefreshableSourceIPs(state: ConnectionsState, enabled: boolean): string[] {
  if (!enabled) return []

  const ips = new Set<string>()
  const now = Date.now()
  for (const conn of state.map.values()) {
    const ip = conn.metadata.sourceIP
    if (shouldRefreshSourceName(ip, now)) ips.add(ip)
  }
  return Array.from(ips)
}

function getCachedSourceName(ip: string): string | null {
  return sourceNameCache.get(ip) ?? null
}

function useSourceName(ip: string, enabled: boolean): string | null {
  useSourceNameStore((s) => (enabled ? s.version : 0))
  return enabled && isResolvableSourceIP(ip) ? getCachedSourceName(ip) : null
}

async function refreshSourceNames(sourceIps: string[]) {
  const missingIps = Array.from(new Set(sourceIps.filter((ip) => shouldRefreshSourceName(ip))))
  if (missingIps.length === 0) return
  if (sourceNameRequest) {
    await sourceNameRequest
    return refreshSourceNames(sourceIps)
  }

  sourceNameRequest = (async () => {
    let changed = false
    try {
      const retryAt = Date.now() + SOURCE_NAME_MISS_RETRY_MS
      const data = await apiCall<DeviceListResponse>('GET', 'device-list')
      if (!data.success) {
        changed = cacheSourceNameMisses(missingIps, retryAt)
        return
      }

      const missingSet = new Set(missingIps)
      for (const host of data.host ?? []) {
        const name =
          (typeof host.name === 'string' ? host.name.trim() : '') || (typeof host.hostname === 'string' ? host.hostname.trim() : '')
        const ips = [host.ip, ...(Array.isArray(host.ip6) ? host.ip6 : [])]

        for (const rawIp of ips) {
          const ip = cleanDeviceIp(rawIp)
          if (!isResolvableSourceIP(ip)) continue
          const retryAtForMiss = !name ? (missingSet.has(ip) ? retryAt : sourceNameRetryAt.get(ip)) : undefined
          changed = cacheSourceName(ip, name || null, retryAtForMiss) || changed
          missingSet.delete(ip)
        }
      }

      changed = cacheSourceNameMisses(Array.from(missingSet), retryAt) || changed
    } catch {
      changed = cacheSourceNameMisses(missingIps, Date.now() + SOURCE_NAME_MISS_RETRY_MS) || changed
    } finally {
      scheduleSourceNameRetry()
      if (changed) bumpSourceNameVersion()
    }
  })().finally(() => {
    sourceNameRequest = null
  })

  await sourceNameRequest
}

function formatAsn(data: any): string | null {
  const asnObj = data?.asn && typeof data.asn === 'object' ? data.asn : null
  let asn = typeof asnObj?.asn === 'string' ? asnObj.asn.trim() : null
  let name = typeof asnObj?.name === 'string' ? asnObj.name.trim() : null
  if (!asn || !name) {
    const org = typeof data?.org === 'string' ? data.org.trim() : ''
    const match = org.match(/^AS(\d+)\s*(.*)?$/i)
    if (match) {
      if (!asn) asn = `AS${match[1]}`
      if (!name) name = match[2]?.trim() || null
    }
  }
  if (!asn) return null
  return name ? `${asn} (${name})` : asn
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getConnectionSortValue(conn: Connection, column: SortColumn, showSourceName = false): string {
  switch (column) {
    case 'host':
      return getConnectionHost(conn) || ''
    case 'protocol':
      return conn.metadata.network || ''
    case 'chains':
      return conn.chains?.[0] ?? ''
    case 'source':
      return getConnectionSourceLabel(conn, showSourceName ? getCachedSourceName(conn.metadata.sourceIP) : null)
    case 'start':
      return conn.start || ''
    case 'upload':
      return String(conn.upload).padStart(20, '0')
    case 'download':
      return String(conn.download).padStart(20, '0')
    case 'uploadSpeed':
      return String(conn.uploadSpeed ?? 0).padStart(20, '0')
    case 'downloadSpeed':
      return String(conn.downloadSpeed ?? 0).padStart(20, '0')
    default:
      return ''
  }
}

function getConnectionHost(conn: Connection): string {
  return conn.metadata.host || conn.metadata.sniffHost || conn.metadata.destinationIP || ''
}

function getConnectionHostLabel(conn: Connection): string {
  const host = getConnectionHost(conn)
  return conn.metadata.destinationPort ? `${host}:${conn.metadata.destinationPort}` : host
}

function matchesMobileConnectionFilter(conn: Connection, query: string, searchHiddenColumns: boolean, showSourceName: boolean): boolean {
  const source = getConnectionSourceLabel(conn, showSourceName ? getCachedSourceName(conn.metadata.sourceIP) : null)
  const visibleValues = [
    getConnectionHostLabel(conn),
    getConnectionProtocol(conn),
    conn.metadata.type,
    ...conn.chains,
    formatBytes(conn.download),
    formatBytes(conn.upload),
    formatBytes(conn.downloadSpeed ?? 0),
    formatBytes(conn.uploadSpeed ?? 0),
    timeAgo(conn.start),
  ]
  const hiddenValues = [
    conn.rule,
    conn.rulePayload,
    source,
    conn.metadata.sourceIP,
    conn.metadata.sourcePort,
    conn.metadata.host,
    conn.metadata.destinationIP,
    conn.metadata.destinationGeoIP ?? '',
    conn.metadata.destinationIPASN ?? '',
    conn.metadata.destinationPort,
    conn.metadata.inboundName,
    conn.metadata.inboundUser ?? '',
    conn.metadata.inboundIP,
    conn.metadata.inboundPort,
    conn.metadata.remoteDestination,
    conn.metadata.sniffHost,
    conn.metadata.sourceGeoIP ?? '',
    conn.metadata.sourceIPASN ?? '',
    conn.metadata.dnsMode,
    conn.metadata.specialProxy ?? '',
    conn.metadata.specialRules ?? '',
    conn.metadata.process,
    conn.metadata.processPath,
    String(conn.metadata.uid || ''),
  ]
  const values = [...visibleValues, ...(searchHiddenColumns ? hiddenValues : [])].filter(Boolean)
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  const regexes = tokens.map((token) => {
    try {
      return new RegExp(token, 'i')
    } catch {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(escaped, 'i')
    }
  })
  return regexes.every((regex) => values.some((value) => regex.test(value)))
}

function getConnectionProtocol(conn: Connection): string {
  return conn.metadata.network?.toUpperCase() || '—'
}

function getConnectionSourceLabel(conn: Connection, sourceName?: string | null): string {
  const source = sourceName || conn.metadata.sourceIP
  return conn.metadata.sourcePort ? `${source}:${conn.metadata.sourcePort}` : source
}

function getConnectionSourceDisplayLabel(conn: Connection, sourceName?: string | null): string {
  return sourceName || getConnectionSourceLabel(conn)
}

function getConnectionSourceCopyValue(conn: Connection, sourceName?: string | null): string {
  const source = getConnectionSourceLabel(conn)
  return sourceName ? `${sourceName} (${source})` : source
}

function getConnectionSourceHost(conn: Connection): string {
  return conn.metadata.sourceIP
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10,
    mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 19) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

function timeAgo(isoString: string): string {
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (diffSec < 5) return 'только что'
  if (diffSec < 60) return `${diffSec} ${pluralize(diffSec, 'сек', 'сек', 'сек')} назад`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} ${pluralize(diffMin, 'мин', 'мин', 'мин')} назад`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} ${pluralize(diffHour, 'час', 'часа', 'часов')} назад`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} ${pluralize(diffDay, 'день', 'дня', 'дней')} назад`
}

function SortIcon({ column, sortColumn, sortDirection }: { column: SortColumn; sortColumn: SortColumn; sortDirection: SortDirection }) {
  if (sortColumn !== column) return <IconArrowsSort size={13} className="opacity-30" />
  return sortDirection === 'asc' ? <IconArrowUp size={13} className="text-primary" /> : <IconArrowDown size={13} className="text-primary" />
}

function MetaRow({ label, value, force }: { label: string; value: ReactNode; force?: boolean }) {
  if (!force && (value === null || value === undefined || value === '')) return null
  return (
    <div className="border-border flex gap-2 border-b py-1.5 last:border-0">
      <span className="text-muted-foreground w-40 shrink-0 text-xs">{label}</span>
      <span className="text-xs break-all">{value}</span>
    </div>
  )
}

function ProxyIcon({ name, className }: { name: string; className?: string }) {
  const icon = useProxiesStore((s) => (s.proxies[name] as any)?.icon as string | undefined)
  if (!icon) return null
  return (
    <img
      src={icon}
      alt=""
      className={className ?? 'size-4.5 shrink-0 object-contain'}
      onError={(e) => {
        ;(e.target as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}

function ChainTooltip({ chains }: { chains: string[] }) {
  return (
    <TooltipContent side="top" className="p-2">
      <div className="flex items-center gap-1">
        {chains.map((chain, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <IconCircleArrowRightFilled size={11} className="text-muted-foreground shrink-0" />}
            <ProxyIcon name={chain} className="size-4 shrink-0 object-contain" />
            <span className="text-[13px]">{chain}</span>
          </span>
        ))}
      </div>
    </TooltipContent>
  )
}

// ─── TimeAgoCell ───────────────────────────────────────────────────────────────

function TimeAgoCell({ isoString }: { isoString: string }) {
  useNowStore((s) => s.tick)
  return <>{timeAgo(isoString)}</>
}

function TrafficCell({ connId }: { connId: string }) {
  const upload = useConnectionsStore((s) => s.map.get(connId)?.upload ?? 0)
  const download = useConnectionsStore((s) => s.map.get(connId)?.download ?? 0)
  return (
    <span className="flex items-center gap-2 whitespace-nowrap tabular-nums">
      <span>↑ {formatBytes(upload)}</span>
      <span>↓ {formatBytes(download)}</span>
    </span>
  )
}

// ─── Row ───────────────────────────────────────────────────────────────────────

const ConnectionRow = memo(function ConnectionRow({
  connId,
  onSelect,
  onClose,
  onBlock,
  onApplyFilter,
  showSourceName,
}: {
  connId: string
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
  onBlock: (id: string, e: React.MouseEvent) => void
  onApplyFilter: (value: string) => void
  showSourceName: boolean
}) {
  const sourceIp = useConnectionsStore((s) => s.map.get(connId)?.metadata.sourceIP ?? '')
  const sourceName = useSourceName(sourceIp, showSourceName)
  const displayKey = useConnectionsStore((s) => {
    const c = s.map.get(connId)
    if (!c) return null
    const host = getConnectionHost(c)
    return `${c.chains.join('|')}|${host}|${c.metadata.destinationPort}|${c.metadata.network}|${c.metadata.sourceIP}|${c.metadata.sourcePort}|${c.start}`
  })
  const smartBlockState = useConnectionsStore((s) => s.map.get(connId)?.metadata.smartBlock)
  const canSmartBlock = smartBlockState === 'normal'

  if (!displayKey) return null

  const conn = useConnectionsStore.getState().map.get(connId)!
  const host = getConnectionHost(conn)
  const hostLabel = getConnectionHostLabel(conn)
  const protocol = getConnectionProtocol(conn)
  const source = getConnectionSourceDisplayLabel(conn, sourceName)
  const sourceCopy = getConnectionSourceCopyValue(conn, sourceName)
  const sourceHost = getConnectionSourceHost(conn)
  const sourceFilter = sourceName || sourceHost
  const reversedChains = [...conn.chains].reverse()
  const first = reversedChains[0]
  const last = reversedChains.at(-1)
  const applyChainFilter = (value: string | undefined, e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (value) onApplyFilter(value)
  }

  return (
    <TableRow className="hover:bg-muted/50 cursor-pointer transition-colors" onClick={() => onSelect(conn)}>
      <TableCell className="max-w-120 pl-3 text-[13px] md:max-w-40">
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="flex w-fit max-w-full items-center gap-1 overflow-hidden text-left">
                {first && (
                  <button
                    type="button"
                    className="flex shrink-0 cursor-copy items-center gap-1 text-left hover:text-blue-400"
                    onClick={(e) => applyChainFilter(first, e)}
                  >
                    <ProxyIcon name={first} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                    <span className="block whitespace-nowrap">{first}</span>
                  </button>
                )}
                {reversedChains.length > 1 && (
                  <>
                    <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-copy items-center gap-1 overflow-hidden text-left hover:text-blue-400"
                      onClick={(e) => applyChainFilter(last, e)}
                    >
                      <ProxyIcon name={last!} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                      <span className="block truncate">{last}</span>
                    </button>
                  </>
                )}
              </div>
            }
          />
          <ChainTooltip chains={reversedChains} />
        </Tooltip>
      </TableCell>
      <TableCell className="max-w-72 text-[13px] md:max-w-48">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="flex w-fit max-w-full cursor-copy items-center overflow-hidden text-left hover:text-blue-400"
                onClick={(e) => {
                  e.stopPropagation()
                  onApplyFilter(host)
                }}
              >
                <span className="truncate">{host}</span>
                {conn.metadata.destinationPort && <span className="text-muted-foreground shrink-0">:{conn.metadata.destinationPort}</span>}
              </button>
            }
          />
          <TooltipContent side="top" className="text-[13px]" copyTextValue={hostLabel}>
            {hostLabel}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px]">
        {conn.metadata.network ? (
          <button
            type="button"
            className="cursor-copy hover:text-blue-400"
            onClick={(e) => {
              e.stopPropagation()
              onApplyFilter(conn.metadata.network)
            }}
          >
            {protocol}
          </button>
        ) : (
          protocol
        )}
      </TableCell>
      <TableCell className="text-muted-foreground max-w-64 text-[13px] md:max-w-47.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="block w-fit max-w-full cursor-copy truncate text-left hover:text-blue-400"
                onClick={(e) => {
                  e.stopPropagation()
                  onApplyFilter(sourceFilter)
                }}
              >
                {source}
              </button>
            }
          />
          <TooltipContent side="top" className="text-[13px]" copyTextValue={sourceCopy}>
            {sourceCopy}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px]">
        <TrafficCell connId={connId} />
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px] tabular-nums">
        <TimeAgoCell isoString={conn.start} />
      </TableCell>
      <TableCell>
        <span className="flex items-center justify-end">
          {canSmartBlock && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground size-5 hover:bg-transparent! hover:text-amber-400"
                    onClick={(e) => onBlock(conn.id, e)}
                  >
                    <IconBan className="size-3.5" />
                  </Button>
                }
              />
              <TooltipContent>Smart: заблокировать узел для этого хоста</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground size-5 hover:bg-transparent! hover:text-red-400"
                  onClick={(e) => onClose(conn.id, e)}
                >
                  <IconX className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>Закрыть соединение</TooltipContent>
          </Tooltip>
        </span>
      </TableCell>
    </TableRow>
  )
})

// ─── Closed Row ────────────────────────────────────────────────────────────────

const ClosedConnectionRow = memo(function ClosedConnectionRow({
  conn,
  onSelect,
  showSourceName,
}: {
  conn: Connection
  onSelect: (conn: Connection) => void
  showSourceName: boolean
}) {
  const sourceName = useSourceName(conn.metadata.sourceIP, showSourceName)
  const reversedChains = [...conn.chains].reverse()
  const first = reversedChains[0]
  const last = reversedChains.at(-1)
  const host = getConnectionHost(conn)
  const hostLabel = getConnectionHostLabel(conn)
  const protocol = getConnectionProtocol(conn)
  const source = getConnectionSourceDisplayLabel(conn, sourceName)
  const sourceCopy = getConnectionSourceCopyValue(conn, sourceName)

  return (
    <TableRow className="hover:bg-muted/50 h-9.75 cursor-pointer opacity-60 transition-colors" onClick={() => onSelect(conn)}>
      <TableCell className="max-w-120 pl-3 text-[13px] md:max-w-40">
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="flex w-fit max-w-full items-center gap-1 overflow-hidden text-left">
                {first && (
                  <span className="flex shrink-0 items-center gap-1">
                    <ProxyIcon name={first} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                    <span className="block whitespace-nowrap">{first}</span>
                  </span>
                )}
                {reversedChains.length > 1 && (
                  <>
                    <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                    <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                      <ProxyIcon name={last!} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                      <span className="block truncate">{last}</span>
                    </span>
                  </>
                )}
              </div>
            }
          />
          <ChainTooltip chains={reversedChains} />
        </Tooltip>
      </TableCell>
      <TableCell className="max-w-72 text-[13px] md:max-w-48">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex w-fit max-w-full items-center overflow-hidden">
                <span className="truncate">{host}</span>
                {conn.metadata.destinationPort && <span className="text-muted-foreground shrink-0">:{conn.metadata.destinationPort}</span>}
              </span>
            }
          />
          <TooltipContent side="top" className="text-[13px]" copyTextValue={hostLabel}>
            {hostLabel}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px]">{protocol}</TableCell>
      <TableCell className="text-muted-foreground max-w-64 text-[13px] md:max-w-47.5">
        <Tooltip>
          <TooltipTrigger render={<span className="block w-fit max-w-full truncate">{source}</span>} />
          <TooltipContent side="top" className="text-[13px]" copyTextValue={sourceCopy}>
            {sourceCopy}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px]">
        <span className="flex items-center gap-2 whitespace-nowrap tabular-nums">
          <span>↑ {formatBytes(conn.upload)}</span>
          <span>↓ {formatBytes(conn.download)}</span>
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px] tabular-nums">
        <TimeAgoCell isoString={conn.start} />
      </TableCell>
      <TableCell />
    </TableRow>
  )
})

const ConnectionDialogMeta = memo(function ConnectionDialogMeta({ conn, showSourceName, showExtended = false }: { conn: Connection; showSourceName: boolean; showExtended?: boolean }) {
  const reversedChains = [...conn.chains].reverse()
  const asnIp = conn.metadata.destinationIP?.trim() ?? ''
  const sourceName = useSourceName(conn.metadata.sourceIP, showSourceName)
  const [asnText, setAsnText] = useState<string | null>(() => (asnIp ? (asnCache.get(asnIp) ?? null) : null))
  const [asnLoading, setAsnLoading] = useState(() => !!asnIp && !asnCache.has(asnIp))

  useEffect(() => {
    if (!asnIp || asnCache.has(asnIp)) return

    let alive = true
    const timeoutId = setTimeout(() => {
      if (!alive) return
      alive = false
      setAsnLoading(false)
      setAsnText(null)
    }, 3000)

    fetch(`https://ipinfo.io/${encodeURIComponent(asnIp)}/json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        if (!alive) return
        const text = formatAsn(data)
        asnCache.set(asnIp, text)
        setAsnText(text)
      })
      .catch(() => {
        if (!alive) return
        asnCache.set(asnIp, null)
        setAsnText(null)
      })
      .finally(() => {
        if (!alive) return
        setAsnLoading(false)
        clearTimeout(timeoutId)
      })

    return () => {
      alive = false
      clearTimeout(timeoutId)
    }
  }, [asnIp])

  return (
    <>
      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Цепочка</p>
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {reversedChains.map((chain, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />}
            <span className="bg-muted text-foreground flex items-center gap-1 rounded-md px-2 py-0.5 text-xs">
              <ProxyIcon name={chain} className="size-3.5 shrink-0 object-contain" />
              {chain || '—'}
            </span>
          </span>
        ))}
      </div>

      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Правило</p>
      <div className="mb-4 text-xs">
        <span className="text-blue-400">{conn.rule}</span>
        {conn.rulePayload && <span className="text-muted-foreground ml-1">{conn.rulePayload}</span>}
      </div>

      <ConnectionDialogTraffic conn={conn} />

      {showExtended && (conn.metadata.destinationGeoIP || conn.metadata.destinationIPASN || conn.metadata.sourceGeoIP || conn.metadata.sourceIPASN) && (
        <>
          <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">GeoIP</p>
          <div className="border-border mb-4 rounded-lg border px-3">
            <MetaRow label="IP назначения" value={conn.metadata.destinationIP} />
            <MetaRow label="GeoIP назначения" value={conn.metadata.destinationGeoIP} />
            <MetaRow label="ASN назначения" value={conn.metadata.destinationIPASN} />
            <MetaRow label="GeoIP источника" value={conn.metadata.sourceGeoIP} />
            <MetaRow label="ASN источника" value={conn.metadata.sourceIPASN} />
          </div>
        </>
      )}

      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Метаданные</p>
      <div className="border-border rounded-lg border px-3">
        <MetaRow label="Протокол" value={conn.metadata.network?.toUpperCase()} />
        <MetaRow label="Тип" value={conn.metadata.type} />
        <MetaRow label="IP источника" value={`${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`} />
        {showSourceName && <MetaRow label="Имя источника" value={sourceName} />}
        <MetaRow label="IP назначения" value={`${conn.metadata.destinationIP}:${conn.metadata.destinationPort}`} />
        <MetaRow label="Хост назначения" value={conn.metadata.host} />
        <MetaRow label="Удалённый хост" value={conn.metadata.remoteDestination} />
        <MetaRow label="Sniff Host" value={conn.metadata.sniffHost} />
        <MetaRow label="DNS режим" value={conn.metadata.dnsMode} />
        <MetaRow label="Inbound" value={conn.metadata.inboundName} />
        {showExtended && <MetaRow label="Inbound user" value={conn.metadata.inboundUser} />}
        <MetaRow label="Inbound адрес" value={`${conn.metadata.inboundIP}:${conn.metadata.inboundPort}`} />
        <MetaRow label="Процесс" value={conn.metadata.process || conn.metadata.processPath} />
        <MetaRow label="UID" value={conn.metadata.uid || undefined} />
        {showExtended && <MetaRow label="DSCP" value={conn.metadata.dscp} />}
        {showExtended && <MetaRow label="Special proxy" value={conn.metadata.specialProxy} />}
        {showExtended && <MetaRow label="Special rules" value={conn.metadata.specialRules} />}
        <MetaRow label="Начало" value={new Date(conn.start).toLocaleString()} />
        {asnIp && (
          <MetaRow
            label="ASN"
            value={
              asnLoading ? (
                <span className="text-muted-foreground inline-flex items-center gap-2">
                  <IconLoader2 size={14} className="animate-spin" />
                </span>
              ) : (
                (asnText ?? '—')
              )
            }
            force
          />
        )}
      </div>
    </>
  )
})

function ConnectionDialogTraffic({ conn }: { conn: Connection }) {
  return (
    <>
      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Трафик</p>
      <div className="mb-4 flex gap-4 text-xs">
        <span>↑ {formatBytes(conn.upload)}</span>
        <span>↓ {formatBytes(conn.download)}</span>
      </div>
    </>
  )
}

const ConnectionDialogTitle = memo(function ConnectionDialogTitle({ conn }: { conn: Connection }) {
  const title = getConnectionHost(conn) || 'Соединение'
  return <DialogTitle className="truncate pr-8 text-base">{title}</DialogTitle>
})

const ConnectionDialog = memo(function ConnectionDialog({
  open,
  connId,
  onClose,
  onCloseConnection,
  showSourceName,
  zashboardMode,
}: {
  open: boolean
  connId: string | null
  onClose: () => void
  onCloseConnection: (id: string) => Promise<void>
  showSourceName: boolean
  zashboardMode: boolean
}) {
  const liveConn = useConnectionsStore((s) => (connId ? (s.map.get(connId) ?? null) : null))
  const frozenConn = useConnectionsStore((s) => (connId ? (s.closedMap.get(connId) ?? null) : null))
  const displayConn = liveConn ?? frozenConn
  const isClosed = !!connId && !liveConn
  const renderedConn = displayConn
  const [detailsTab, setDetailsTab] = useState<'overview' | 'raw'>('overview')
  const rawJsonLines = useMemo(() => renderedConn ? highlightConnectionJson(JSON.stringify(renderedConn, null, 2)) : null, [renderedConn])

  useEffect(() => setDetailsTab('overview'), [connId])

  return (
    <Dialog open={open && !!connId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={`flex max-h-[80dvh]! max-w-lg! flex-col overflow-hidden ${zashboardMode ? 'max-h-[88dvh]! max-w-[calc(100vw-1.5rem)]!' : ''}`}>
        <DialogHeader className="shrink-0">{renderedConn && <ConnectionDialogTitle conn={renderedConn} />}</DialogHeader>

        {zashboardMode ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <Select value={detailsTab} items={{ overview: 'Обзор', raw: 'Raw' }} onValueChange={(value) => setDetailsTab(value as 'overview' | 'raw')}>
              <SelectTrigger aria-label="Раздел сведений о соединении" className="h-9 w-[132px] shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" sideOffset={4}>
                <SelectGroup>
                  <SelectItem value="overview">Обзор</SelectItem>
                  <SelectItem value="raw">Raw</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {detailsTab === 'overview' ? (
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {renderedConn && <ConnectionDialogMeta conn={renderedConn} showSourceName={showSourceName} showExtended />}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              {renderedConn && (
                <pre className="text-muted-foreground whitespace-pre-wrap break-all rounded-lg border p-3 font-mono text-xs">
                  {rawJsonLines?.map((line, index) => <div key={index}>{line}</div>)}
                </pre>
              )}
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
            {renderedConn && <ConnectionDialogMeta conn={renderedConn} showSourceName={showSourceName} />}
          </div>
        )}

        {renderedConn && (
          <div>
            <Button
              variant="destructive"
              className="w-full"
              disabled={isClosed || !connId}
              onClick={() => connId && onCloseConnection(connId)}
            >
              <IconX size={14} /> {isClosed ? 'Соединение закрыто' : 'Закрыть соединение'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
})

// ─── Header Subcomponents ─────────────────────────────────────────────────────

// ─── Tabs ──────────────────────────────────────────────────────────────────────

const ConnectionsTabs = memo(function ConnectionsTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: 'active' | 'closed'
  onTabChange: (tab: 'active' | 'closed') => void
}) {
  const activeCount = useConnectionsStore((s) => s.map.size)
  const closedCount = useConnectionsStore((s) => s.closedMap.size)
  const triggerStyles = 'data-[state=active]:bg-background! data-[state=active]:text-foreground! data-[state=active]:shadow-sm!'

  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as 'active' | 'closed')}>
      <TabsList>
        <TabsTrigger value="active" className={triggerStyles}>
          <IconActivity />
          <span className="text-xs tabular-nums">{activeCount}</span>
        </TabsTrigger>
        <TabsTrigger value="closed" className={triggerStyles}>
          <IconPlugX />
          <span className="text-xs tabular-nums">{closedCount}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
})

const CloseAllBtn = memo(function CloseAllBtn({ onCloseAll, disabled }: { onCloseAll: () => void; disabled?: boolean }) {
  const totalCount = useConnectionsStore((s) => s.map.size)
  return (
    <Button
      variant="destructive"
      className="text-[13px] max-md:size-9 max-md:px-0 max-md:pr-0! max-md:pl-0!"
      onClick={onCloseAll}
      disabled={disabled ?? totalCount === 0}
    >
      <IconPlugX className="md:hidden" />
      <IconPlugX data-icon="inline-start" className="hidden md:block" />
      <span className="hidden md:inline">Закрыть все</span>
    </Button>
  )
})

// ─── Header ────────────────────────────────────────────────────────────────────

const ConnectionsHeader = memo(function ConnectionsHeader({
  filter,
  activeTab,
  onTabChange,
  onFilterChange,
  onClearFilter,
  onCloseAll,
  caseSensitive,
  onToggleCaseSensitive,
}: {
  filter: string
  activeTab: 'active' | 'closed'
  onTabChange: (tab: 'active' | 'closed') => void
  onFilterChange: (v: string) => void
  onClearFilter: () => void
  onCloseAll: () => void
  caseSensitive: boolean
  onToggleCaseSensitive: () => void
}) {
  return (
    <div className="border-border flex shrink-0 items-center gap-2 border-b p-3">
      <ConnectionsTabs activeTab={activeTab} onTabChange={onTabChange} />

      <InputGroup>
        <InputGroupInput value={filter} onChange={(e) => onFilterChange(e.target.value)} placeholder="Фильтр" />
        <InputGroupAddon>
          <IconFilter />
        </InputGroupAddon>
        <InputGroupAddon align="inline-end" className="gap-0">
          {filter && (
            <InputGroupButton size="icon-xs" className="text-muted-foreground hover:text-destructive hover:bg-transparent!" onClick={onClearFilter}>
              <ClearIcon className="size-3.25" />
            </InputGroupButton>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton className={caseSensitive ? 'bg-accent' : ''} onClick={onToggleCaseSensitive}>
                  <IconLetterCase size={16} />
                </InputGroupButton>
              }
            />
            <TooltipContent side="bottom">Учитывать регистр</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>

      {activeTab === 'active' && <CloseAllBtn onCloseAll={onCloseAll} />}
    </div>
  )
})

// ─── Table head ────────────────────────────────────────────────────────────────

const columns: { key: SortColumn; label: string; className: string }[] = [
  { key: 'chains', label: 'Цепочка', className: 'w-[50%] pl-3 md:w-[35%]' },
  { key: 'host', label: 'Хост', className: 'w-[24%] md:w-[31%]' },
  { key: 'protocol', label: 'Тип', className: 'w-[4%]' },
  { key: 'source', label: 'Источник', className: 'w-[14%] max-w-[220px] md:w-[10%] md:max-w-[190px]' },
  { key: 'upload', label: 'Трафик', className: 'w-[10%]' },
  { key: 'start', label: 'Время', className: 'w-[10%]' },
]

const ConnectionsTableHead = memo(function ConnectionsTableHead({
  sortColumn,
  sortDirection,
  onSort,
}: {
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSort: (col: SortColumn) => void
}) {
  return (
    <TableHeader>
      <TableRow>
        {columns.map((col) => {
          const isTraffic = col.key === 'upload'
          const trafficActive = isTraffic && (sortColumn === 'upload' || sortColumn === 'download')
          const effectiveKey = isTraffic ? (sortColumn === 'download' ? 'download' : 'upload') : col.key
          const label = isTraffic ? (trafficActive ? (sortColumn === 'upload' ? '↑ Отдано' : '↓ Скачано') : 'Трафик') : col.label
          return (
            <TableHead
              key={col.label}
              className={`select-none ${col.className} ${col.key ? 'cursor-pointer' : ''}`}
              onClick={() => col.key && onSort(col.key)}
            >
              <span className="flex items-center gap-1">
                {label}
                {col.key && <SortIcon column={effectiveKey} sortColumn={sortColumn} sortDirection={sortDirection} />}
              </span>
            </TableHead>
          )
        })}
        <TableHead className="w-12" />
      </TableRow>
    </TableHeader>
  )
})

// ─── Body ──────────────────────────────────────────────────────────────────────

const ConnectionsBody = memo(function ConnectionsBody({
  filter,
  sortColumn,
  sortDirection,
  onSelect,
  onClose,
  onBlock,
  onApplyFilter,
  showSourceName,
  caseSensitive,
}: {
  filter: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
  onBlock: (id: string, e: React.MouseEvent) => void
  onApplyFilter: (value: string) => void
  showSourceName: boolean
  caseSensitive: boolean
}) {
  const connected = useWsConnected()
  useSourceNameStore((s) => (showSourceName ? s.version : 0))

  const filteredIds = useConnectionsStore(
    useShallow((s) => {
      const connections = Array.from(s.map.values())
      const query = filter.trim()
      let result = connections.filter((conn) => !conn.chains.some((c) => c.toLowerCase() === 'dns-out'))

      if (query) {
        const match = (v: string) => (caseSensitive ? v.includes(query) : v.toLowerCase().includes(query.toLowerCase()))
        result = result.filter((conn) => {
          const hostLabel = getConnectionHostLabel(conn)
          const sourceLabel = getConnectionSourceLabel(conn, showSourceName ? getCachedSourceName(conn.metadata.sourceIP) : null)
          return (
            conn.chains.some((c) => match(c)) ||
            match(hostLabel) ||
            match(conn.metadata.host) ||
            match(conn.metadata.destinationIP) ||
            match(conn.metadata.network) ||
            match(getConnectionProtocol(conn)) ||
            match(sourceLabel) ||
            match(conn.metadata.sourceIP) ||
            match(conn.rule) ||
            match(conn.rulePayload)
          )
        })
      }

      if (sortColumn) {
        result = [...result].sort((a, b) => {
          const valueA = getConnectionSortValue(a, sortColumn, showSourceName)
          const valueB = getConnectionSortValue(b, sortColumn, showSourceName)
          return sortDirection === 'asc' ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA)
        })
      }

      return result.map((c) => c.id)
    })
  )

  return (
    <TableBody>
      {filteredIds.length === 0 ? (
        <TableRow>
          <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
            {!connected ? 'Подключение...' : filter ? 'Нет совпадений' : 'Нет активных соединений'}
          </TableCell>
        </TableRow>
      ) : (
        filteredIds.map((id) => (
          <ConnectionRow
            key={id}
            connId={id}
            onSelect={onSelect}
            onClose={onClose}
            onBlock={onBlock}
            onApplyFilter={onApplyFilter}
            showSourceName={showSourceName}
          />
        ))
      )}
    </TableBody>
  )
})

const ClosedConnectionsBody = memo(function ClosedConnectionsBody({
  filter,
  sortColumn,
  sortDirection,
  onSelect,
  showSourceName,
  caseSensitive,
}: {
  filter: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSelect: (conn: Connection) => void
  showSourceName: boolean
  caseSensitive: boolean
}) {
  useSourceNameStore((s) => (showSourceName ? s.version : 0))
  const filteredConns = useConnectionsStore(
    useShallow((s) => {
      const connections = Array.from(s.closedMap.values())
      const query = filter.trim()
      let result = connections.filter((conn) => !conn.chains.some((c) => c.toLowerCase() === 'dns-out'))
      if (query) {
        const match = (v: string) => (caseSensitive ? v.includes(query) : v.toLowerCase().includes(query.toLowerCase()))
        result = result.filter((conn) => {
          const hostLabel = getConnectionHostLabel(conn)
          const sourceLabel = getConnectionSourceLabel(conn, showSourceName ? getCachedSourceName(conn.metadata.sourceIP) : null)
          return (
            conn.chains.some((c) => match(c)) ||
            match(hostLabel) ||
            match(conn.metadata.host) ||
            match(conn.metadata.destinationIP) ||
            match(conn.metadata.network) ||
            match(getConnectionProtocol(conn)) ||
            match(sourceLabel) ||
            match(conn.metadata.sourceIP) ||
            match(conn.rule) ||
            match(conn.rulePayload)
          )
        })
      }
      if (sortColumn) {
        result = [...result].sort((a, b) => {
          const valueA = getConnectionSortValue(a, sortColumn, showSourceName)
          const valueB = getConnectionSortValue(b, sortColumn, showSourceName)
          return sortDirection === 'asc' ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA)
        })
      }
      return result
    })
  )

  return (
    <TableBody>
      {filteredConns.length === 0 ? (
        <TableRow>
          <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
            {filter ? 'Нет совпадений' : 'Нет закрытых соединений'}
          </TableCell>
        </TableRow>
      ) : (
        filteredConns.map((conn) => <ClosedConnectionRow key={conn.id} conn={conn} onSelect={onSelect} showSourceName={showSourceName} />)
      )}
    </TableBody>
  )
})

const MobileConnectionCard = memo(function MobileConnectionCard({
  conn,
  closed,
  onSelect,
  onClose,
  onBlock,
  onApplyFilter,
}: {
  conn: Connection
  closed: boolean
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
  onBlock: (id: string, e: React.MouseEvent) => void
  onApplyFilter: (value: string) => void
}) {
  const reversedChains = [...conn.chains].reverse()
  const displayedChains = reversedChains.length > 2 ? [reversedChains[0], reversedChains[reversedChains.length - 1]] : reversedChains
  const host = getConnectionHostLabel(conn) || '—'
  const smartBlockState = useConnectionsStore((s) => s.map.get(conn.id)?.metadata.smartBlock)
  const canSmartBlock = !closed && smartBlockState === 'normal'
  return (
    <article
      tabIndex={0}
      aria-label={`Соединение ${host}`}
      className={`border-border bg-input-background hover:bg-muted/40 focus-visible:ring-ring flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none ${closed ? 'opacity-60' : ''}`}
      onClick={() => onSelect(conn)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(conn)
        }
      }}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{host}</span>
        <div className="flex shrink-0 items-center gap-1">
          {canSmartBlock && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground size-7 hover:bg-transparent! hover:text-amber-400"
                    aria-label="Smart: заблокировать узел для этого хоста"
                    onClick={(e) => onBlock(conn.id, e)}
                  >
                    <IconBan size={15} />
                  </Button>
                }
              />
              <TooltipContent>Smart: заблокировать узел для этого хоста</TooltipContent>
            </Tooltip>
          )}
          {!closed && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-7 hover:bg-destructive/10 hover:text-destructive"
              aria-label="Закрыть соединение"
              onClick={(e) => onClose(conn.id, e)}
            >
              <IconX size={15} />
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0 truncate text-xs">{conn.metadata.type || '—'} | {getConnectionProtocol(conn)}</span>
        <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs tabular-nums">
          <span className="text-emerald-400">↓ {formatBytes(conn.download)}</span>
          <span className="text-sky-400">↑ {formatBytes(conn.upload)}</span>
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs">
                {displayedChains.map((chain, i) => (
                  <span key={`${chain}-${i}`} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <IconCircleArrowRightFilled size={12} className="text-muted-foreground shrink-0" />}
                    <button
                      type="button"
                      className="flex min-w-0 cursor-copy items-center gap-1 text-left hover:text-blue-400"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onApplyFilter(chain)
                      }}
                    >
                      <ProxyIcon name={chain} className="size-4 shrink-0 object-contain" />
                      <span className="min-w-0 truncate">{chain}</span>
                    </button>
                  </span>
                ))}
                {!reversedChains.length && <span className="text-muted-foreground">DIRECT</span>}
              </div>
            }
          />
          <ChainTooltip chains={reversedChains} />
        </Tooltip>
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          <TimeAgoCell isoString={conn.start} />
        </span>
      </div>
    </article>
  )
})

const MobileConnectionsView = memo(function MobileConnectionsView({
  filter,
  activeTab,
  sortColumn,
  sortDirection,
  onFilterChange,
  onTabChange,
  onSortChange,
  onSelect,
  onClose,
  onBlock,
  sourceIPFilter,
  onSourceIPFilterChange,
  searchHiddenColumns,
  onToggleSearchHiddenColumns,
  onCloseVisible,
  showSourceName,
  quickFilterEnabled,
  onToggleQuickFilter,
}: {
  filter: string
  activeTab: 'active' | 'closed' | 'all'
  sortColumn: SortColumn
  sortDirection: SortDirection
  onFilterChange: (value: string) => void
  onTabChange: (tab: 'active' | 'closed' | 'all') => void
  onSortChange: (column: SortColumn, direction: SortDirection) => void
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
  onBlock: (id: string, e: React.MouseEvent) => void
  onCloseVisible: (ids: string[]) => void
  sourceIPFilter: string | null
  onSourceIPFilterChange: (ip: string | null) => void
  searchHiddenColumns: boolean
  onToggleSearchHiddenColumns: () => void
  showSourceName: boolean
  quickFilterEnabled: boolean
  onToggleQuickFilter: () => void
}) {
  useSourceNameStore((s) => (showSourceName ? s.version : 0))
  const connected = useWsConnected()
  const [visibleLimit, setVisibleLimit] = useState(50)
  const liveMaps = useConnectionsStore(useShallow((s) => ({ active: s.map, closed: s.closedMap })))
  const liveSets = useMemo(() => ({ active: Array.from(liveMaps.active.values()), closed: Array.from(liveMaps.closed.values()) }), [liveMaps.active, liveMaps.closed])
  useEffect(() => setVisibleLimit(50), [filter, activeTab, sortColumn, sortDirection, sourceIPFilter, searchHiddenColumns])
  const sourceSets = liveSets
  const sourceIPs = useMemo(() => Array.from(new Set([...sourceSets.active, ...sourceSets.closed].map((conn) => conn.metadata.sourceIP).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [sourceSets])
  const connections = useMemo(() => {
      let result: { conn: Connection; closed: boolean }[] = []
      if (activeTab !== 'closed') result.push(...sourceSets.active.map((conn) => ({ conn, closed: false })))
      if (activeTab !== 'active') result.push(...sourceSets.closed.filter((conn) => !sourceSets.active.some((active) => active.id === conn.id)).map((conn) => ({ conn, closed: true })))
      result = result.filter(({ conn }) => !conn.chains.some((c) => c.toLowerCase() === 'dns-out'))
      if (sourceIPFilter) result = result.filter(({ conn }) => conn.metadata.sourceIP === sourceIPFilter)
      if (quickFilterEnabled) result = result.filter(({ conn }) => !matchesMobileConnectionFilter(conn, 'direct|dns-out', true, showSourceName))
      const query = filter.trim()
      if (query) {
        result = result.filter(({ conn }) => matchesMobileConnectionFilter(conn, query, searchHiddenColumns, showSourceName))
      }
      if (sortColumn) {
        result = [...result].sort((a, b) => {
          const aValue = getConnectionSortValue(a.conn, sortColumn, showSourceName)
          const bValue = getConnectionSortValue(b.conn, sortColumn, showSourceName)
          const compared = aValue.localeCompare(bValue, undefined, { numeric: true }) || a.conn.id.localeCompare(b.conn.id)
          return sortDirection === 'asc' ? compared : -compared
        })
      }
      return result
  }, [sourceSets, activeTab, sourceIPFilter, quickFilterEnabled, filter, searchHiddenColumns, showSourceName, sortColumn, sortDirection])
  const activeCount = sourceSets.active.length
  const closedCount = sourceSets.closed.filter((conn) => !sourceSets.active.some((active) => active.id === conn.id)).length
  const triggerStyles = 'data-[state=active]:bg-background! data-[state=active]:text-foreground! data-[state=active]:shadow-sm!'
  const sortOptions = [
    ['start', 'desc', 'Время ↓'], ['start', 'asc', 'Время ↑'],
    ['host', 'desc', 'Хост ↓'], ['host', 'asc', 'Хост ↑'],
    ['protocol', 'desc', 'Тип ↓'], ['protocol', 'asc', 'Тип ↑'],
    ['chains', 'desc', 'Цепочка ↓'], ['chains', 'asc', 'Цепочка ↑'],
    ['source', 'desc', 'Источник ↓'], ['source', 'asc', 'Источник ↑'],
    ['upload', 'desc', 'Отправлено ↓'], ['upload', 'asc', 'Отправлено ↑'],
    ['download', 'desc', 'Получено ↓'], ['download', 'asc', 'Получено ↑'],
    ['uploadSpeed', 'desc', 'Скорость отдачи ↓'], ['uploadSpeed', 'asc', 'Скорость отдачи ↑'],
    ['downloadSpeed', 'desc', 'Скорость загрузки ↓'], ['downloadSpeed', 'asc', 'Скорость загрузки ↑'],
  ] as const satisfies readonly [Exclude<SortColumn, null>, SortDirection, string][]
  const sortItems = Object.fromEntries(sortOptions.map(([column, direction, label]) => [`${column}:${direction}`, label]))

  return (
    <div className="border-border bg-input-background absolute inset-4 flex min-h-0 flex-col overflow-hidden rounded-xl border md:hidden">
      <div className="border-border bg-input-background flex shrink-0 flex-col gap-2 border-b p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Tabs value={activeTab === 'all' ? 'active' : activeTab} onValueChange={(v) => onTabChange(v as 'active' | 'closed')}>
            <TabsList className="h-9 shrink-0">
              <TabsTrigger aria-label={`Активные соединения: ${activeCount}`} value="active" className={triggerStyles}>
                <IconActivity size={16} />
                <span className="text-xs tabular-nums">{activeCount}</span>
              </TabsTrigger>
              <TabsTrigger aria-label={`Закрытые соединения: ${closedCount}`} value="closed" className={triggerStyles}>
                <IconPlugX size={16} />
                <span className="text-xs tabular-nums">{closedCount}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <InputGroup className="min-w-0 flex-1">
            <DropdownMenu>
              <DropdownMenuTrigger render={<InputGroupButton size="icon-sm" aria-label="Дополнительные фильтры"><IconFilter /></InputGroupButton>} />
              <DropdownMenuContent align="start" sideOffset={4} className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Источник IP</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuRadioGroup value={sourceIPFilter ?? 'all'} onValueChange={(value) => onSourceIPFilterChange(value === 'all' ? null : value)}>
                  <DropdownMenuRadioItem value="all">Все источники</DropdownMenuRadioItem>
                  {sourceIPs.map((ip) => <DropdownMenuRadioItem key={ip} value={ip}>{showSourceName ? getCachedSourceName(ip) || ip : ip}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={quickFilterEnabled} onCheckedChange={onToggleQuickFilter}>Скрыть DIRECT и DNS</DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <InputGroupInput value={filter} onChange={(e) => onFilterChange(e.target.value)} placeholder="Фильтр" />
            <InputGroupAddon align="inline-end" className="gap-0">
              {filter && <InputGroupButton size="icon-xs" className="text-muted-foreground hover:text-destructive hover:bg-transparent!" aria-label="Очистить фильтр" onClick={() => onFilterChange('')}><ClearIcon className="size-3.25" /></InputGroupButton>}
              <InputGroupButton aria-pressed={searchHiddenColumns} className={searchHiddenColumns ? 'bg-accent' : ''} aria-label="Искать по скрытым полям" title={searchHiddenColumns ? 'Поиск по всем полям' : 'Искать по скрытым полям'} onClick={onToggleSearchHiddenColumns}><IconLetterCase size={16} /></InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Select
            value={`${sortColumn ?? 'host'}:${sortDirection}`}
            items={sortItems}
            onValueChange={(value) => {
              const [column, direction] = value.split(':')
              onSortChange(column as SortColumn, direction as SortDirection)
            }}
          >
            <SelectTrigger className="h-9 min-w-0 flex-1"><SelectValue /></SelectTrigger>
            <SelectContent align="start" sideOffset={4}>
              <SelectGroup>
                {sortOptions.map(([column, direction, label]) => (
                  <SelectItem key={`${column}:${direction}`} value={`${column}:${direction}`}>{label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {activeTab !== 'closed' && (
            <Button variant="destructive" className="h-9 shrink-0 px-2.5 text-xs" disabled={!connections.some((item) => !item.closed)} onClick={() => onCloseVisible(connections.filter((item) => !item.closed).map((item) => item.conn.id))}>
              <IconPlugX size={16} />
              Закрыть все
            </Button>
          )}
        </div>
      </div>
      <div className="bg-background min-h-0 flex-1 overflow-y-auto p-2.5">
        {connections.length ? (
          <div className="flex flex-col gap-2">
            {connections.slice(0, visibleLimit).map(({ conn, closed }) => <MobileConnectionCard key={`${closed ? 'closed' : 'active'}-${conn.id}`} conn={conn} closed={closed} onSelect={onSelect} onClose={onClose} onBlock={onBlock} onApplyFilter={onFilterChange} />)}
            {visibleLimit < connections.length && (
              <Button variant="outline" size="sm" className="w-full" onClick={() => setVisibleLimit((limit) => limit + 50)}>
                Показать ещё {Math.min(50, connections.length - visibleLimit)} из {connections.length - visibleLimit}
              </Button>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground py-10 text-center text-sm">{!connected ? 'Подключение…' : filter ? 'Нет совпадений' : 'Нет соединений'}</div>
        )}
      </div>
    </div>
  )
})

// ─── Main panel ────────────────────────────────────────────────────────────────

export function ConnectionsPanel({ clashApiPort, clashApiSecret, clashApiUnix }: Props) {
  const [filter, setFilter] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('start')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [mobileFilter, setMobileFilter] = useState('')
  const [mobileSortColumn, setMobileSortColumn] = useState<SortColumn>('start')
  const [mobileSortDirection, setMobileSortDirection] = useState<SortDirection>('desc')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'active' | 'closed'>('active')
  const [mobileTab, setMobileTab] = useState<'active' | 'closed' | 'all'>('active')
  const [mobileSourceIPFilter, setMobileSourceIPFilter] = useState<string | null>(null)
  const [mobileSearchHiddenColumns, setMobileSearchHiddenColumns] = useState(false)
  const [mobileQuickFilterEnabled, setMobileQuickFilterEnabled] = useState(() => localStorage.getItem('mihomo-connection-quick-filter') === 'true')
  const [connectionsDisplay, setConnectionsDisplay] = useState(readConnectionsDisplay)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const dialogCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [caseSensitive, setCaseSensitive] = useState(() => localStorage.getItem('conn_filter_cs') === 'true')
  const toggleCaseSensitive = useCallback(() => {
    setCaseSensitive((prev) => {
      const next = !prev
      localStorage.setItem('conn_filter_cs', String(next))
      return next
    })
  }, [])
  const showSourceName = useSettings((s) => s.showSourceName)
  const sourceNameRefreshTick = useSourceNameStore((s) => (showSourceName ? s.version : 0))
  const unresolvedSourceIPs = useConnectionsStore(useShallow((s) => collectRefreshableSourceIPs(s, showSourceName)))

  const clearDialogCloseTimer = useCallback(() => {
    if (!dialogCloseTimerRef.current) return
    clearTimeout(dialogCloseTimerRef.current)
    dialogCloseTimerRef.current = null
  }, [])

  useEffect(() => clearDialogCloseTimer, [clearDialogCloseTimer])

  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    clearDialogCloseTimer()
    dialogCloseTimerRef.current = setTimeout(() => {
      dialogCloseTimerRef.current = null
      setSelectedId(null)
    }, DIALOG_CLOSE_ANIMATION_MS)
  }, [clearDialogCloseTimer])

  useEffect(() => {
    const sourceIps = collectRefreshableSourceIPs(useConnectionsStore.getState(), showSourceName)
    if (sourceIps.length > 0) void refreshSourceNames(sourceIps)
  }, [showSourceName, sourceNameRefreshTick, unresolvedSourceIPs])

  const toggleSort = useCallback((column: SortColumn) => {
    setSortColumn((prev) => {
      if (column === 'upload' && prev === 'upload') {
        setSortDirection('desc')
        return 'download'
      }
      if (column === 'upload' && prev === 'download') {
        setSortDirection('desc')
        return 'upload'
      }
      if (prev === column) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDirection('desc')
      return column
    })
  }, [])

  const closeAll = useCallback(async () => {
    await clashFetch(clashApiPort, 'connections', { method: 'DELETE', secret: clashApiSecret, unix: clashApiUnix ?? null })
    setSelectedId(null)
  }, [clashApiPort, clashApiSecret, clashApiUnix])

  const closeVisibleConnections = useCallback(async (ids: string[]) => {
    const active = useConnectionsStore.getState().map
    const targets = Array.from(new Set(ids)).filter((id) => active.has(id))
    if (!targets.length) return
    if (targets.length === active.size) {
      await closeAll()
    } else {
      await Promise.all(targets.map((id) => clashFetch(clashApiPort, `connections/${id}`, { method: 'DELETE', secret: clashApiSecret, unix: clashApiUnix ?? null })))
      if (selectedId && targets.includes(selectedId)) closeDialog()
    }
  }, [clashApiPort, clashApiSecret, clashApiUnix, closeAll, selectedId, closeDialog])

  const clearFilter = useCallback(() => setFilter(''), [])
  const handleApplyFilter = useCallback((value: string) => setFilter(value), [])

  const handleCloseConnection = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation()
      await clashFetch(clashApiPort, `connections/${id}`, { method: 'DELETE', secret: clashApiSecret, unix: clashApiUnix ?? null })
      if (selectedId === id) closeDialog()
    },
    [clashApiPort, clashApiSecret, clashApiUnix, closeDialog, selectedId]
  )

  const handleBlockConnection = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation()
      try {
        await clashFetch(clashApiPort, `connections/smart/${id}`, {
          method: 'DELETE',
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
          retry: false,
        })
      } catch {
        /* ядро без поддержки smart */
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix]
  )

  const handleSelectConnection = useCallback(
    (conn: Connection) => {
      clearDialogCloseTimer()
      setSelectedId(conn.id)
      setDialogOpen(true)
    },
    [clearDialogCloseTimer]
  )

  const handleCloseDialog = closeDialog

  const handleCloseDialogConnection = useCallback(
    async (id: string) => {
      await handleCloseConnection(id)
      closeDialog()
    },
    [closeDialog, handleCloseConnection]
  )

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const updateViewport = () => {
      setIsMobile(media.matches)
    }
    media.addEventListener('change', updateViewport)
    const updateDisplay = () => setConnectionsDisplay(readConnectionsDisplay())
    window.addEventListener(CONNECTIONS_DISPLAY_EVENT, updateDisplay)
    window.addEventListener('storage', updateDisplay)
    window.addEventListener(DISPLAY_EVENT, updateDisplay)
    return () => {
      media.removeEventListener('change', updateViewport)
      window.removeEventListener(CONNECTIONS_DISPLAY_EVENT, updateDisplay)
      window.removeEventListener('storage', updateDisplay)
      window.removeEventListener(DISPLAY_EVENT, updateDisplay)
    }
  }, [])

  const showMobileZashboard = isMobile && connectionsDisplay === 'zashboard'
  const handleMobileSortChange = useCallback((column: SortColumn, direction: SortDirection) => {
    setMobileSortColumn(column)
    setMobileSortDirection(direction)
  }, [])
  const toggleMobileSearchHiddenColumns = useCallback(() => setMobileSearchHiddenColumns((enabled) => !enabled), [])
  const toggleMobileQuickFilter = useCallback(() => {
    setMobileQuickFilterEnabled((enabled) => {
      const next = !enabled
      localStorage.setItem('mihomo-connection-quick-filter', String(next))
      return next
    })
  }, [])

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={0}>
      <div className={`border-border bg-input-background absolute inset-4 flex flex-col overflow-hidden rounded-xl border ${showMobileZashboard ? 'hidden md:flex' : ''}`}>
        <ConnectionsHeader
          filter={filter}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onFilterChange={setFilter}
          onClearFilter={clearFilter}
          onCloseAll={closeAll}
          caseSensitive={caseSensitive}
          onToggleCaseSensitive={toggleCaseSensitive}
        />
        <div className="flex-1 scrollbar-thin overflow-auto">
          <Table className="min-w-240 md:min-w-190">
            <ConnectionsTableHead sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
            {activeTab === 'active' ? (
              <ConnectionsBody
                filter={filter}
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSelect={handleSelectConnection}
                onClose={handleCloseConnection}
                onBlock={handleBlockConnection}
                onApplyFilter={handleApplyFilter}
                showSourceName={showSourceName}
                caseSensitive={caseSensitive}
              />
            ) : (
              <ClosedConnectionsBody
                filter={filter}
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSelect={handleSelectConnection}
                showSourceName={showSourceName}
                caseSensitive={caseSensitive}
              />
            )}
          </Table>
        </div>
      </div>
      {showMobileZashboard && (
        <MobileConnectionsView
          filter={mobileFilter}
          activeTab={mobileTab}
          sortColumn={mobileSortColumn}
          sortDirection={mobileSortDirection}
          onFilterChange={setMobileFilter}
          onTabChange={setMobileTab}
          onSortChange={handleMobileSortChange}
          onSelect={handleSelectConnection}
          onClose={handleCloseConnection}
          onBlock={handleBlockConnection}
          sourceIPFilter={mobileSourceIPFilter}
          onSourceIPFilterChange={setMobileSourceIPFilter}
          searchHiddenColumns={mobileSearchHiddenColumns}
          onToggleSearchHiddenColumns={toggleMobileSearchHiddenColumns}
          onCloseVisible={closeVisibleConnections}
          quickFilterEnabled={mobileQuickFilterEnabled}
          onToggleQuickFilter={toggleMobileQuickFilter}
          showSourceName={showSourceName}
        />
      )}
      <ConnectionDialog
        open={dialogOpen}
        connId={selectedId}
        onClose={handleCloseDialog}
        onCloseConnection={handleCloseDialogConnection}
        showSourceName={showSourceName}
        zashboardMode={showMobileZashboard}
      />
    </TooltipProvider>
  )
}
