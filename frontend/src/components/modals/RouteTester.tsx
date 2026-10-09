import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { IconAlertTriangle, IconArrowRight, IconChevronDown, IconChevronUp, IconFileUpload, IconRoute, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, buildClashHeaders, capitalize, clashFetch } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

type Network = 'tcp' | 'udp'
type Core = 'mihomo' | 'xray'
type Outcome = 'matched' | 'default' | 'error'

interface RouteTestRule {
  index: number
  text: string
  detail: string | null
}

interface RouteTestBalancer {
  tag: string
  selector: string[]
}

interface RouteTestSkipped {
  index: number
  text: string
  reason: string
}

interface RouteTestResult {
  target: string
  kind: string
  outcome: Outcome
  outbound: string | null
  rule: RouteTestRule | null
  balancer: RouteTestBalancer | null
  resolvedIps: string[]
  dnsSource: 'mihomo' | 'doh' | null
  skipped: RouteTestSkipped[]
  error: string | null
}

interface RouteTestInitResponse {
  success: boolean
  error?: string
  core?: Core
  inboundTags?: string[]
}

interface RouteTestRunResponse {
  success: boolean
  error?: string
  core?: Core
  results?: RouteTestResult[]
  warnings?: string[]
}

interface ProxyLite {
  type?: string
  now?: string
}

const MAX_TARGETS = 500
const NO_INBOUND = '__none__'
const DNS_SOURCE_LABELS: Record<string, string> = { mihomo: 'mihomo', doh: 'DoH' }

const IPV4_REGEX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_REGEX =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/

function isValidIp(value: string): boolean {
  return IPV4_REGEX.test(value) || IPV6_REGEX.test(value)
}

function pluralizeTargets(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 19) return 'целей'
  if (mod10 === 1) return 'цель'
  if (mod10 >= 2 && mod10 <= 4) return 'цели'
  return 'целей'
}

function resolveProxyChain(proxies: Record<string, ProxyLite | undefined>, name: string): string[] {
  const chain = [name]
  const visited = new Set([name])
  let current = name
  for (;;) {
    const info = proxies[current]
    if (!info?.now || visited.has(info.now)) break
    chain.push(info.now)
    visited.add(info.now)
    current = info.now
  }
  return chain
}

function ResultRow({
  result,
  chain,
  expanded,
  onToggle,
}: {
  result: RouteTestResult
  chain?: string[]
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetails = result.skipped.length > 0 || !!result.error

  return (
    <div className="border-border bg-card rounded-lg border p-3 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium tracking-wider" title={result.target}>
            {result.target}
          </span>
        </div>
        <Badge
          variant={result.outcome === 'matched' ? 'emerald' : result.outcome === 'default' ? 'sky' : 'destructive'}
          className="shrink-0 rounded-full"
        >
          {result.outcome === 'error' ? 'Ошибка' : (result.outbound ?? '—')}
        </Badge>
      </div>

      {chain && chain.length > 1 && (
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1 text-xs">
          {chain.map((name, i) => (
            <span key={`${name}-${i}`} className="flex items-center gap-1">
              {i > 0 && <IconArrowRight size={11} className="shrink-0" />}
              <span className="truncate">{name}</span>
            </span>
          ))}
        </div>
      )}

      {result.outcome !== 'error' && (
        <div
          className="text-muted-foreground mt-1.5 truncate text-xs"
          title={result.rule ? `${result.rule.text}${result.rule.detail ? ` — ${result.rule.detail}` : ''}` : undefined}
        >
          {result.rule ? (
            <>
              <span className="text-foreground/80">#{result.rule.index}</span> {result.rule.text}
              {result.rule.detail && <span className="opacity-75"> — {result.rule.detail}</span>}
            </>
          ) : (
            'по умолчанию'
          )}
        </div>
      )}

      {result.balancer && (
        <div className="text-muted-foreground mt-1 text-xs">
          Балансировщик <span className="text-foreground font-medium">{result.balancer.tag}</span>
          {result.balancer.selector.length > 0 && <>: {result.balancer.selector.join(', ')}</>}
        </div>
      )}

      {result.resolvedIps.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span>{result.resolvedIps.join(', ')}</span>
          {result.dnsSource && (
            <Badge variant="outline" className="h-4.5 rounded-sm px-1.5 text-[10px]">
              {DNS_SOURCE_LABELS[result.dnsSource] ?? result.dnsSource}
            </Badge>
          )}
        </div>
      )}

      {hasDetails && (
        <div className="mt-1.5">
          <button type="button" onClick={onToggle} className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
            <IconChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
            {result.error ? 'Ошибка — подробнее' : `Пропущено правил: ${result.skipped.length}`}
          </button>
          {expanded && (
            <div className="border-border mt-1.5 space-y-1 border-l-2 pl-2.5 text-xs">
              {result.error && <div className="text-destructive">{result.error}</div>}
              {result.skipped.map((s) => (
                <div key={s.index} className="text-muted-foreground">
                  <span className="text-foreground">#{s.index}</span> {s.text} — {s.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function RouteTesterModal() {
  const { state, showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const { clashApiPort, clashApiSecret, clashApiUnix } = state

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showRouteTestModal', show: false })

  const [loadingInit, setLoadingInit] = useState(true)
  const [core, setCore] = useState<Core | null>(null)
  const [inboundTags, setInboundTags] = useState<string[]>([])

  const [input, setInput] = useState('')
  const [port, setPort] = useState('443')
  const [network, setNetwork] = useState<Network>('tcp')
  const [sourceIp, setSourceIp] = useState('')
  const [inboundTag, setInboundTag] = useState(NO_INBOUND)

  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RouteTestResult[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [chains, setChains] = useState<Record<string, string[]>>({})
  const [filter, setFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)

  useEffect(() => {
    if (!modals.showRouteTestModal) return
    let cancelled = false
    setLoadingInit(true)
    apiCall<RouteTestInitResponse>('GET', 'route-test')
      .then((data) => {
        if (cancelled) return
        if (data.success) {
          setCore(data.core ?? null)
          const tags = data.inboundTags ?? []
          setInboundTags(tags)
          setInboundTag((prev) => (prev !== NO_INBOUND ? prev : (tags.find((tag) => tag !== 'api') ?? NO_INBOUND)))
        } else {
          showToast(data.error || 'Не удалось получить данные ядра', 'error')
        }
      })
      .catch(() => {
        if (!cancelled) showToast('Не удалось получить данные ядра', 'error')
      })
      .finally(() => {
        if (!cancelled) setLoadingInit(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modals.showRouteTestModal])

  // Abort the in-flight run (and thus stop it from writing stale state) when the modal closes or unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [modals.showRouteTestModal])

  const targets = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const raw of input.split('\n')) {
      const line = raw.trim()
      if (!line || seen.has(line)) continue
      seen.add(line)
      list.push(line)
    }
    return list
  }, [input])

  const overLimit = targets.length > MAX_TARGETS
  const portNum = Number(port)
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535

  function bumpPort(delta: number) {
    const base = Number.isFinite(portNum) ? Math.trunc(portNum) : 1
    setPort(String(Math.min(65535, Math.max(1, base + delta))))
  }
  const sourceIpTrimmed = sourceIp.trim()
  const sourceIpValid = !sourceIpTrimmed || isValidIp(sourceIpTrimmed)
  const canRun = targets.length > 0 && !overLimit && portValid && sourceIpValid && !running

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setInput((prev) => {
        const base = prev.replace(/\n+$/, '')
        return base ? `${base}\n${text}` : text
      })
    }
    reader.onerror = () => showToast('Не удалось прочитать файл', 'error')
    reader.readAsText(file)
  }

  const run = useCallback(async () => {
    if (!canRun) return
    const runId = ++runIdRef.current
    setRunning(true)
    setResults(null)
    setWarnings([])
    setChains({})
    setFilter(null)
    setExpanded(new Set())
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/route-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildClashHeaders(clashApiPort, clashApiSecret, clashApiUnix) },
        body: JSON.stringify({
          targets,
          port: portNum,
          network,
          sourceIp: sourceIpTrimmed || null,
          inboundTag: inboundTag === NO_INBOUND ? null : inboundTag,
        }),
        signal: controller.signal,
      })
      // axum extractor rejections (e.g. bad JSON, invalid query) return a plain-text body, not JSON —
      // read as text first so a failed parse still yields a readable message instead of a raw SyntaxError.
      const bodyText = await res.text()
      let data: RouteTestRunResponse | null = null
      try {
        data = bodyText ? (JSON.parse(bodyText) as RouteTestRunResponse) : null
      } catch {
        data = null
      }
      if (runIdRef.current !== runId) return
      if (!res.ok || !data || !data.success) {
        const statusLine = `${res.status} ${res.statusText}`.trim()
        const fallback = bodyText.trim() ? `${statusLine}: ${bodyText.trim().slice(0, 300)}` : statusLine
        showToast(data?.error || `Ошибка проверки маршрута — ${fallback}`, 'error')
        return
      }
      setResults(data.results ?? [])
      setWarnings(data.warnings ?? [])
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      if (runIdRef.current !== runId) return
      showToast(e instanceof Error ? e.message : 'Ошибка проверки маршрута', 'error')
    } finally {
      if (runIdRef.current === runId) {
        abortRef.current = null
        setRunning(false)
      }
    }
  }, [canRun, targets, portNum, network, sourceIpTrimmed, inboundTag, clashApiPort, clashApiSecret, clashApiUnix, showToast])

  function cancelRun() {
    abortRef.current?.abort()
  }

  // Resolve mihomo's live proxy-group chain (e.g. Discord -> Auto -> Финляндия) for the outbounds
  // that came back from the run. One bulk GET /clash/proxies, then walk `.now` locally — no
  // per-name lookups, which used to 404 for proxy-provider members and spam the log.
  useEffect(() => {
    if (!modals.showRouteTestModal || !results || core !== 'mihomo' || !(clashApiPort || clashApiUnix)) return
    const uniqueOutbounds = Array.from(new Set(results.filter((r) => r.outbound).map((r) => r.outbound as string)))
    if (uniqueOutbounds.length === 0) return
    let cancelled = false
    ;(async () => {
      let data: { proxies?: Record<string, ProxyLite> } | null = null
      try {
        data = await clashFetch<{ proxies?: Record<string, ProxyLite> }>(clashApiPort ?? '', 'proxies', {
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
          retry: false,
        })
      } catch {
        data = null
      }
      if (cancelled) return
      const proxies = data?.proxies ?? {}
      const next: Record<string, string[]> = {}
      for (const name of uniqueOutbounds) {
        const chain = resolveProxyChain(proxies, name)
        if (chain.length > 1) next[name] = chain
      }
      setChains(next)
    })()
    return () => {
      cancelled = true
    }
  }, [results, core, clashApiPort, clashApiSecret, clashApiUnix, modals.showRouteTestModal])

  const chipEntries = useMemo(() => {
    if (!results) return []
    const counts = new Map<string, number>()
    let errorCount = 0
    for (const r of results) {
      if (r.outcome === 'error') {
        errorCount += 1
        continue
      }
      const key = r.outbound ?? '—'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const entries = Array.from(counts.entries())
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count)
    if (errorCount > 0) entries.push({ key: '__error__', label: 'Ошибки', count: errorCount })
    return entries
  }, [results])

  const filteredResults = useMemo(() => {
    if (!results) return []
    if (!filter) return results
    if (filter === '__error__') return results.filter((r) => r.outcome === 'error')
    return results.filter((r) => r.outcome !== 'error' && (r.outbound ?? '—') === filter)
  }, [results, filter])

  function toggleExpanded(target: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  return (
    <Dialog open={modals.showRouteTestModal} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{ maxHeight: '95vh', maxWidth: '46rem', width: 'calc(100vw - 2rem)' }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconRoute size={24} className="text-chart-2" />
            Проверка маршрута
          </DialogTitle>
          <DialogDescription>
            {loadingInit ? (
              'Загрузка данных ядра...'
            ) : core ? (
              <>
                Активное ядро: <span className="text-chart-2 font-semibold">{capitalize(core)}</span>
              </>
            ) : (
              'Не удалось определить активное ядро'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  if (canRun) run()
                }
              }}
              placeholder={'По одному адресу на строку, например:\nyoutube.com\n1.1.1.1\nwww.google.com'}
              aria-label="Список целей для проверки маршрута"
              className="max-h-72 min-h-24 resize-y text-[13px]!"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={cn('text-muted-foreground text-xs', overLimit && 'text-destructive')}>
                {targets.length} {pluralizeTargets(targets.length)}
                {overLimit && ' — не более 500 целей за раз'}
              </span>
              <div>
                <input ref={fileInputRef} type="file" accept=".txt,.list,.csv,text/plain" className="hidden" onChange={handleFilePick} />
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <IconFileUpload data-icon="inline-start" /> Загрузить .txt
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="route-test-port" className="text-muted-foreground text-xs tracking-wide">
                Порт
              </Label>
              <InputGroup className={cn('h-9 w-24', !portValid && 'border-destructive')}>
                <InputGroupInput
                  id="route-test-port"
                  type="number"
                  min={1}
                  max={65535}
                  inputMode="numeric"
                  className="[appearance:textfield] text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                />
                <InputGroupAddon align="inline-end" className="flex flex-col gap-0">
                  <InputGroupButton
                    aria-label="Увеличить порт"
                    className="text-muted-foreground hover:text-foreground h-[calc(50%-0.5px)]! min-h-0! px-1 text-[9px]"
                    onClick={() => bumpPort(1)}
                  >
                    <IconChevronUp />
                  </InputGroupButton>
                  <InputGroupButton
                    aria-label="Уменьшить порт"
                    className="text-muted-foreground hover:text-foreground h-[calc(50%-0.5px)]! min-h-0! px-1 text-[9px]"
                    onClick={() => bumpPort(-1)}
                  >
                    <IconChevronDown />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs tracking-wide">Сеть</span>
              <ButtonGroup>
                <Button type="button" variant={network === 'tcp' ? 'default' : 'outline'} onClick={() => setNetwork('tcp')}>
                  TCP
                </Button>
                <Button type="button" variant={network === 'udp' ? 'default' : 'outline'} onClick={() => setNetwork('udp')}>
                  UDP
                </Button>
              </ButtonGroup>
            </div>
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor="route-test-source-ip" className="text-muted-foreground text-xs tracking-wide">
                IP источника (необязательно)
              </Label>
              <Input
                id="route-test-source-ip"
                value={sourceIp}
                onChange={(e) => setSourceIp(e.target.value)}
                placeholder="192.168.1.2"
                className={cn(!sourceIpValid && 'border-destructive')}
              />
            </div>
            {core === 'xray' && (
              <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                <Label className="text-muted-foreground text-xs tracking-wide">Inbound</Label>
                <Select
                  value={inboundTag}
                  items={{ [NO_INBOUND]: 'Не задан', ...Object.fromEntries(inboundTags.map((tag) => [tag, tag])) }}
                  onValueChange={setInboundTag}
                >
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NO_INBOUND}>Не задан</SelectItem>
                      {inboundTags.map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          {tag}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={run} disabled={!canRun} className="h-9 flex-1">
              {running ? (
                <>
                  <Spinner className="mr-1.5 size-4" /> Проверка...
                </>
              ) : (
                'Проверить'
              )}
            </Button>
            {running && (
              <Button type="button" variant="outline" size="icon" onClick={cancelRun} className="h-9 w-9 shrink-0">
                <IconX className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {(warnings.length > 0 || results) && (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
            {warnings.length > 0 && (
              <Alert variant="destructive" className="shrink-0 px-3 py-2.5">
                <IconAlertTriangle className="size-4" />
                <AlertTitle className="text-xs">Предупреждения</AlertTitle>
                <AlertDescription className="text-xs">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {results && results.length > 0 && (
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {chipEntries.map((entry) => (
                  <Badge
                    key={entry.key}
                    variant={filter === entry.key ? 'default' : 'outline'}
                    className="cursor-pointer rounded-full"
                    onClick={() => setFilter((prev) => (prev === entry.key ? null : entry.key))}
                  >
                    {entry.label} <span className="tabular-nums opacity-75">{entry.count}</span>
                  </Badge>
                ))}
              </div>
            )}

            {results && (
              <div className="border-border bg-input-background min-h-0 flex-1 scrollbar-thin space-y-2 overflow-y-auto rounded-xl border p-2">
                {results.length === 0 ? (
                  <div className="text-muted-foreground flex h-20 items-center justify-center text-xs">Нет результатов</div>
                ) : (
                  filteredResults.map((r) => (
                    <ResultRow
                      key={r.target}
                      result={r}
                      chain={r.outbound ? chains[r.outbound] : undefined}
                      expanded={expanded.has(r.target)}
                      onToggle={() => toggleExpanded(r.target)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )}

        <p className="text-muted-foreground shrink-0 pt-1 text-center text-xs">
          В зависимости от конфигурации DNS/sniffer могут быть неточности
        </p>
      </DialogContent>
    </Dialog>
  )
}
