import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { IconDatabase, IconEye, IconRefresh, IconStack2 } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, clashFetch } from '../../lib/api'
import { fetchClashProxies, useAppActions } from '../../lib/store'
import { cn } from '../../lib/utils'

const ruleContentCache = new Map<string, string>()
const DIALOG_CLOSE_ANIMATION_MS = 220

type ProvidersModalKind = 'rules' | 'proxies'

interface Props {
  open: boolean
  kind: ProvidersModalKind
  clashApiPort: string
  clashApiSecret: string | null
  clashApiUnix?: string | null
  onOpenChange: (open: boolean) => void
}

interface ProxySubscriptionInfo {
  Upload?: number
  Download?: number
  Total?: number
  Expire?: number
}

interface ProxyProvider {
  name: string
  type: string
  vehicleType: string
  proxies?: Array<unknown>
  updatedAt?: string
  subscriptionInfo?: ProxySubscriptionInfo
}

interface RuleProvider {
  name: string
  type: string
  vehicleType: string
  ruleCount?: number
  format?: string
  behavior?: string
  updatedAt?: string
}

const ALLOWED_PROXY_VEHICLE_TYPES = new Set(['HTTP', 'FILE', 'INLINE'])

const FORMAT_LABELS: Record<string, string> = {
  MrsRule: 'MRS',
  YamlRule: 'YAML',
  TextRule: 'TEXT',
}

function normalizeVehicleType(value?: string) {
  return value?.trim().toUpperCase() ?? ''
}

function formatVehicleType(value?: string) {
  const normalized = normalizeVehicleType(value)
  return normalized ? normalized[0] + normalized.slice(1).toLowerCase() : '—'
}

function formatDateTime(value?: string | number) {
  if (!value) return '—'
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function pluralizeRu(value: number, [one, few, many]: [string, string, string]) {
  const mod10 = value % 10
  const mod100 = value % 100
  if (mod100 >= 11 && mod100 <= 19) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

function formatRelativeTime(value?: string | number) {
  if (!value) return '—'
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return '—'

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (diffSeconds > 0) return 'только что'
  const absSeconds = Math.abs(diffSeconds)
  if (absSeconds < 45) return 'только что'

  const units = [
    { seconds: 60, forms: ['мин', 'мин', 'мин'] as [string, string, string] },
    { seconds: 3600, forms: ['час', 'часа', 'часов'] as [string, string, string] },
    { seconds: 86400, forms: ['день', 'дня', 'дней'] as [string, string, string] },
    { seconds: 2592000, forms: ['месяц', 'месяца', 'месяцев'] as [string, string, string] },
    { seconds: 31536000, forms: ['год', 'года', 'лет'] as [string, string, string] },
  ]

  const unit = units.find((_, index) => absSeconds < (units[index + 1]?.seconds ?? Number.POSITIVE_INFINITY)) ?? units[units.length - 1]
  const amount = Math.max(1, Math.round(absSeconds / unit.seconds))
  const label = `${amount} ${pluralizeRu(amount, unit.forms)}`
  return `${label} назад`
}

function formatBytes(bytes?: number) {
  if (!Number.isFinite(bytes) || bytes === undefined || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function getTrafficSummary(info?: ProxySubscriptionInfo) {
  if (!info) return { total: '—', expire: '—' }
  const upload = info.Upload ?? 0
  const download = info.Download ?? 0
  const used = upload + download
  const total = info.Total ?? 0

  return {
    total: total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : used > 0 ? formatBytes(used) : '—',
    expire: info.Expire ? formatDateTime(info.Expire) : '—',
  }
}

function LoadingTable({ kind }: { kind: ProvidersModalKind }) {
  const cells = kind === 'proxies' ? 7 : 7
  return (
    <div className="space-y-2 p-1">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))` }}>
          {Array.from({ length: cells }, (_, j) => (
            <Skeleton key={j} className="h-10 rounded-md" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function ProvidersModal({ open, kind, clashApiPort, clashApiSecret, clashApiUnix, onOpenChange }: Props) {
  const { showToast } = useAppActions()
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updatingName, setUpdatingName] = useState('')
  const [viewingName, setViewingName] = useState('')
  const [viewContent, setViewContent] = useState<{ name: string; content: string } | null>(null)
  const [viewContentOpen, setViewContentOpen] = useState(false)
  const viewContentCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [proxyProviders, setProxyProviders] = useState<ProxyProvider[]>([])
  const [ruleProviders, setRuleProviders] = useState<RuleProvider[]>([])
  const title = kind === 'proxies' ? 'Провайдеры прокси' : 'Провайдеры правил'

  const clearViewContentCloseTimer = useCallback(() => {
    if (!viewContentCloseTimerRef.current) return
    clearTimeout(viewContentCloseTimerRef.current)
    viewContentCloseTimerRef.current = null
  }, [])

  useEffect(() => clearViewContentCloseTimer, [clearViewContentCloseTimer])

  const openViewContent = useCallback(
    (content: { name: string; content: string }) => {
      clearViewContentCloseTimer()
      setViewContent(content)
      setViewContentOpen(true)
    },
    [clearViewContentCloseTimer]
  )

  const closeViewContent = useCallback(() => {
    setViewContentOpen(false)
    clearViewContentCloseTimer()
    viewContentCloseTimerRef.current = setTimeout(() => {
      viewContentCloseTimerRef.current = null
      setViewContent(null)
    }, DIALOG_CLOSE_ANIMATION_MS)
  }, [clearViewContentCloseTimer])

  const loadProviders = useCallback(
    async (silent = false) => {
      if (!clashApiPort && !clashApiUnix) return
      if (silent) setReloading(true)
      else setLoading(true)

      try {
        if (kind === 'proxies') {
          const data = await clashFetch<{ providers?: Record<string, ProxyProvider> }>(clashApiPort, 'providers/proxies', {
            secret: clashApiSecret,
            unix: clashApiUnix ?? null,
          })
          setProxyProviders(
            Object.values(data.providers ?? {}).filter((provider) =>
              ALLOWED_PROXY_VEHICLE_TYPES.has(normalizeVehicleType(provider.vehicleType))
            )
          )
        } else {
          const data = await clashFetch<{ providers?: Record<string, RuleProvider> }>(clashApiPort, 'providers/rules', {
            secret: clashApiSecret,
            unix: clashApiUnix ?? null,
          })
          setRuleProviders(Object.values(data.providers ?? {}))
        }
      } catch {
        showToast(`Не удалось загрузить ${kind === 'proxies' ? 'провайдеры прокси' : 'провайдеры правил'}`, 'error')
      } finally {
        setLoading(false)
        setReloading(false)
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix, kind, showToast]
  )

  useEffect(() => {
    if (!open) return

    const timeoutId = setTimeout(() => void loadProviders(), 0)
    return () => clearTimeout(timeoutId)
  }, [open, loadProviders])

  const rows = useMemo(() => (kind === 'proxies' ? proxyProviders : ruleProviders), [kind, proxyProviders, ruleProviders])
  const httpProviderNames = useMemo(
    () => rows.filter((provider) => normalizeVehicleType(provider.vehicleType) === 'HTTP').map((provider) => provider.name),
    [rows]
  )

  async function updateProvider(name: string, vehicleType?: string) {
    if (normalizeVehicleType(vehicleType) !== 'HTTP') return
    setUpdatingName(name)
    try {
      await clashFetch(clashApiPort, `providers/${kind}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        secret: clashApiSecret,
        unix: clashApiUnix ?? null,
      })
      if (kind === 'proxies') {
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
      }
      await loadProviders(true)
      ruleContentCache.delete(name)
      showToast(`Провайдер ${name} обновлён`)
    } catch (e) {
      showToast(`Не удалось обновить ${name}: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`, 'error')
    } finally {
      setUpdatingName('')
    }
  }

  async function updateAllProviders() {
    if (!httpProviderNames.length) return
    setUpdatingAll(true)
    try {
      await Promise.all(
        httpProviderNames.map((name) =>
          clashFetch(clashApiPort, `providers/${kind}/${encodeURIComponent(name)}`, {
            method: 'PUT',
            secret: clashApiSecret,
            unix: clashApiUnix ?? null,
          })
        )
      )
      if (kind === 'proxies') {
        await fetchClashProxies(clashApiPort, clashApiSecret, true, clashApiUnix ?? null)
      }
      await loadProviders(true)
      showToast(kind === 'proxies' ? 'Провайдеры прокси обновлены' : 'Провайдеры правил обновлены')
    } catch (e) {
      showToast(`Ошибка обновления: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`, 'error')
    } finally {
      setUpdatingAll(false)
    }
  }

  async function viewProviderContent(provider: RuleProvider) {
    if (ruleContentCache.has(provider.name)) {
      openViewContent({ name: provider.name, content: ruleContentCache.get(provider.name)! })
      return
    }
    setViewingName(provider.name)
    try {
      const params = new URLSearchParams({ name: provider.name })
      if (provider.format) params.set('format', provider.format)
      if (provider.behavior) params.set('behavior', provider.behavior)
      if (provider.vehicleType) params.set('vehicleType', provider.vehicleType)
      const res = await apiCall<{ success: boolean; error?: string; content?: string }>('GET', `ruleset?${params.toString()}`)
      if (!res.success || res.content === undefined) throw new Error(res.error ?? 'Нет данных')
      ruleContentCache.set(provider.name, res.content)
      openViewContent({ name: provider.name, content: res.content })
    } catch (e) {
      showToast(`Не удалось загрузить содержимое: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`, 'error')
    } finally {
      setViewingName('')
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-full max-w-[95vw]! md:w-[min(80vw,850px)]">
          <div className="flex max-h-[88dvh] flex-col gap-4 overflow-hidden md:max-h-[55dvh]">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
                {kind === 'proxies' ? (
                  <IconDatabase size={22} className="text-chart-2" />
                ) : (
                  <IconStack2 size={22} className="text-chart-2" />
                )}
                {title}
              </DialogTitle>
            </DialogHeader>

            <div className="border-border bg-input-background min-h-0 flex-1 overflow-auto rounded-xl border [scrollbar-width:thin]">
              {loading ? (
                <div className="p-4">
                  <LoadingTable kind={kind} />
                </div>
              ) : rows.length === 0 ? (
                <Empty className="min-h-90 border-none">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      {kind === 'proxies' ? <IconDatabase className="size-8" /> : <IconStack2 className="size-8" />}
                    </EmptyMedia>
                    <EmptyTitle className="text-[16px] tracking-normal">Ничего не найдено</EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="ghost" size="sm" onClick={() => loadProviders()}>
                      <IconRefresh data-icon="inline-start" className="size-4" />
                      Повторить
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : kind === 'proxies' ? (
                <Table className="min-w-25 text-[13px]! [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Название</TableHead>
                      <TableHead>Тип</TableHead>
                      <TableHead>Трафик</TableHead>
                      <TableHead>Истекает</TableHead>
                      <TableHead>Обновлено</TableHead>
                      <TableHead className="w-28 text-right">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="hover:bg-transparent! hover:text-blue-400"
                          onClick={updateAllProviders}
                          disabled={loading || reloading || updatingAll || !httpProviderNames.length}
                        >
                          {updatingAll ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
                        </Button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {proxyProviders.map((provider) => {
                      const isHttp = normalizeVehicleType(provider.vehicleType) === 'HTTP'
                      const traffic = getTrafficSummary(provider.subscriptionInfo)
                      return (
                        <TableRow key={provider.name}>
                          <TableCell className="max-w-72">
                            <div className="flex items-center gap-2">
                              <div className="truncate font-medium">{provider.name}</div>
                              <Badge variant="ghost" className="rounded-full border-none bg-blue-500/10! px-2 text-xs text-blue-400!">
                                {provider.proxies?.length ?? 0}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="ghost"
                              className={cn(
                                'rounded-full border-none px-2 text-xs',
                                isHttp
                                  ? 'bg-green-500/10! text-green-400!'
                                  : normalizeVehicleType(provider.vehicleType) === 'FILE'
                                    ? 'bg-orange-500/10! text-orange-400!'
                                    : 'bg-blue-500/10! text-blue-400!'
                              )}
                            >
                              {formatVehicleType(provider.vehicleType)}
                            </Badge>
                          </TableCell>
                          <TableCell className="min-w-42 font-medium tabular-nums">{traffic.total}</TableCell>
                          <TableCell className="tabular-nums">{traffic.expire}</TableCell>
                          <TableCell className="tabular-nums" title={provider.updatedAt ? formatDateTime(provider.updatedAt) : undefined}>
                            {formatRelativeTime(provider.updatedAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            {isHttp ? (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="hover:bg-transparent! hover:text-blue-400"
                                onClick={() => updateProvider(provider.name, provider.vehicleType)}
                                disabled={!!updatingName}
                              >
                                {updatingName === provider.name ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              ) : (
                <Table className="min-w-100 text-[13px] [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Название</TableHead>
                      <TableHead>Формат</TableHead>
                      <TableHead>Поведение</TableHead>
                      <TableHead>Обновлено</TableHead>
                      <TableHead className="w-28 text-right">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="hover:bg-transparent! hover:text-blue-400"
                          onClick={updateAllProviders}
                          disabled={loading || reloading || updatingAll || !httpProviderNames.length}
                        >
                          {updatingAll ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
                        </Button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ruleProviders.map((provider, index) => {
                      const isHttp = normalizeVehicleType(provider.vehicleType) === 'HTTP'
                      const hasFormat = !!provider.format?.trim()
                      const showUpdatedAt = normalizeVehicleType(provider.vehicleType) !== 'INLINE'
                      return (
                        <TableRow key={provider.name}>
                          <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
                          <TableCell className="max-w-84">
                            <div className="flex items-center gap-2">
                              <div className="truncate font-medium">{provider.name}</div>
                              <Badge variant="ghost" className="rounded-full border-none bg-blue-500/10! px-2 text-xs text-blue-400!">
                                {provider.ruleCount ?? 0}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            {hasFormat ? (
                              <Badge variant="ghost" className="rounded-full border-none bg-blue-500/10! px-2 text-xs text-blue-400!">
                                {FORMAT_LABELS[provider.format ?? ''] ?? provider.format}
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant="ghost" className="rounded-full border-none bg-emerald-500/10! px-2 text-xs text-emerald-400!">
                              {provider.behavior ?? ''}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="tabular-nums"
                            title={showUpdatedAt && provider.updatedAt ? formatDateTime(provider.updatedAt) : undefined}
                          >
                            {showUpdatedAt ? formatRelativeTime(provider.updatedAt) : ''}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-0.5">
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="hover:bg-transparent! hover:text-blue-400"
                                onClick={() => viewProviderContent(provider)}
                                disabled={!!viewingName || !!updatingName}
                              >
                                {viewingName === provider.name ? <Spinner className="size-4" /> : <IconEye className="size-4" />}
                              </Button>
                              {isHttp ? (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="hover:bg-transparent! hover:text-blue-400"
                                  onClick={() => updateProvider(provider.name, provider.vehicleType)}
                                  disabled={!!updatingName}
                                >
                                  {updatingName === provider.name ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={viewContentOpen && !!viewContent}
        onOpenChange={(open) => {
          if (!open) closeViewContent()
        }}
      >
        <DialogContent className="w-full max-w-[95vw]! md:w-[min(80vw,700px)]">
          <div className="flex max-h-[88dvh] flex-col gap-4 overflow-hidden md:max-h-[55dvh]">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
                <IconEye size={20} className="text-chart-2" />
                {viewContent?.name}
                <Badge variant="ghost" className="rounded-full border-none bg-blue-500/10! px-2 text-xs text-blue-400!">
                  {viewContent?.content.split('\n').filter(Boolean).length ?? 0}
                </Badge>
              </DialogTitle>
            </DialogHeader>
            <div className="border-border bg-input-background min-h-0 flex-1 overflow-auto rounded-xl border [scrollbar-width:thin]">
              <pre className="p-4 font-mono text-xs leading-5 break-all whitespace-pre-wrap">{viewContent?.content}</pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
