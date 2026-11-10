import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { IconAlertCircle, IconDeviceFloppy, IconInfoCircle, IconSearch, IconTrash, IconX } from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { isNode, isSeq, parseDocument, YAMLMap, type Document } from 'yaml'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall, clashFetch } from '../../../lib/api'
import { useAppContext, useDnsStatusStore, fetchDnsStatus } from '../../../lib/store'
import type { Config } from '../../../lib/types'

const SETUP_FILTER_STORAGE_KEY = 'dnsSetupFilter'
const FAKE_IP_WARNING_STORAGE_KEY = 'dnsFakeIpFilterWarningDismissed'

const DNS_QUERY_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'HTTPS', 'CAA', 'PTR', 'SOA'] as const
const DNS_QUERY_TYPE_ITEMS = Object.fromEntries(DNS_QUERY_TYPES.map((type) => [type, type]))

const DNS_RECORD_TYPE_NAMES: Record<number, string> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  35: 'NAPTR',
  43: 'DS',
  46: 'RRSIG',
  47: 'NSEC',
  48: 'DNSKEY',
  64: 'SVCB',
  65: 'HTTPS',
  257: 'CAA',
}

interface DnsQueryRecord {
  name?: string
  type?: number
  TTL?: number
  data?: string
}

interface DnsQueryResponse {
  Status?: number
  Answer?: DnsQueryRecord[]
  Authority?: DnsQueryRecord[]
  Additional?: DnsQueryRecord[]
}

function formatDnsRecordType(type?: number): string {
  if (type == null) return '—'
  return DNS_RECORD_TYPE_NAMES[type] ?? String(type)
}

function formatPortListener(listener: string): string {
  return listener
    .split(',')
    .map((name) => name.trim())
    .join(', ')
}

function DnsSettingLabel({ children, tooltip }: { children: string; tooltip: string }) {
  const formattedTooltip = tooltip.replaceAll('\\n', '\n')
  const [open, setOpen] = useState(false)

  return (
    <div className="flex items-center gap-1">
      <Label className="text-xs">{children}</Label>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          render={<span className="text-muted-foreground inline-flex cursor-help" />}
          aria-label={`Подробнее: ${children}`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <IconInfoCircle size={14} />
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={8}
          className="max-w-xs whitespace-pre-line"
          onClick={() => {
            if (typeof window !== 'undefined' && window.innerWidth < 768) setOpen(false)
          }}
        >
          {formattedTooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

interface DnsConfig {
  enhancedMode: string
  fakeIpFilterMode: string
  fakeIpFilter: string
  bootstrap: string
  nameserver: string
  proxyServerNameserver: string
  nameserverPolicy: string
  fallback: string
}

export const DEFAULT_DNS_CONFIG: DnsConfig = {
  enhancedMode: 'redir-host',
  fakeIpFilterMode: 'blacklist',
  fakeIpFilter: '+.local',
  bootstrap: '77.88.8.8',
  nameserver: 'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query',
  proxyServerNameserver: 'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query',
  nameserverPolicy: '',
  fallback: 'tls://77.88.8.1\ntls://77.88.8.8',
}

const DEFAULT_DNS_LISTEN = '0.0.0.0:53'
const YAML_LINE_WIDTH = 200

function trimFlowSeqPadding(text: string): string {
  return text.replace(/\[[ \t]+/g, '[').replace(/[ \t]+\]/g, ']')
}

function parseList(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function parseNameserverPolicy(text: string): Record<string, string[]> {
  const trimmed = text.trim()
  if (!trimmed) return {}

  let parsed: unknown
  try {
    parsed = jsyaml.load(trimmed, { json: true })
  } catch {
    throw new Error('Ошибка валидации YAML. Проверьте корректность записи')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ошибка валидации YAML. Проверьте корректность записи')
  }

  const result: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      result[key] = value.map(String)
    } else if (value != null) {
      result[key] = [String(value)]
    }
  }
  return result
}

function getCommentBefore(doc: Document, path: string[]): string | undefined {
  const existing = doc.getIn(path, true)
  return isNode(existing) ? (existing.commentBefore ?? undefined) : undefined
}

function buildPolicyNode(doc: Document, text: string): YAMLMap {
  const policy = parseNameserverPolicy(text)
  const map = new YAMLMap()
  for (const [key, servers] of Object.entries(policy)) {
    if (servers.length === 1) {
      map.set(key, servers[0])
    } else if (servers.length > 1) {
      const seq = doc.createNode(servers)
      if (isSeq(seq)) seq.flow = true
      map.set(key, seq)
    }
  }
  return map
}

function setOrDeleteList(doc: Document, path: string[], items: string[]) {
  if (!items.length) {
    doc.deleteIn(path)
    return
  }
  const commentBefore = getCommentBefore(doc, path)
  const seq = doc.createNode(items)
  if (commentBefore !== undefined) seq.commentBefore = commentBefore
  doc.setIn(path, seq)
}

export function patchDnsConfig(content: string, config: DnsConfig): string {
  const doc = parseDocument(content)

  doc.setIn(['dns', 'enable'], true)
  doc.setIn(['dns', 'listen'], DEFAULT_DNS_LISTEN)
  doc.setIn(['dns', 'enhanced-mode'], config.enhancedMode)

  if (config.enhancedMode === 'fake-ip') {
    doc.setIn(['dns', 'fake-ip-filter-mode'], config.fakeIpFilterMode)
    setOrDeleteList(doc, ['dns', 'fake-ip-filter'], parseList(config.fakeIpFilter))
  }

  setOrDeleteList(doc, ['dns', 'default-nameserver'], parseList(config.bootstrap))

  const policyCommentBefore = getCommentBefore(doc, ['dns', 'nameserver-policy'])
  const policyNode = buildPolicyNode(doc, config.nameserverPolicy)
  if (policyCommentBefore !== undefined) policyNode.commentBefore = policyCommentBefore
  if (policyNode.items.length) doc.setIn(['dns', 'nameserver-policy'], policyNode)
  else doc.deleteIn(['dns', 'nameserver-policy'])

  setOrDeleteList(doc, ['dns', 'nameserver'], parseList(config.nameserver))
  setOrDeleteList(doc, ['dns', 'proxy-server-nameserver'], parseList(config.proxyServerNameserver))
  setOrDeleteList(doc, ['dns', 'fallback'], parseList(config.fallback))

  if (!doc.hasIn(['dns', 'fallback-filter'])) doc.setIn(['dns', 'fallback-filter'], { geoip: false })

  return trimFlowSeqPadding(doc.toString({ lineWidth: YAML_LINE_WIDTH }))
}

export function setDnsEnabled(content: string, enabled: boolean): string {
  const doc = parseDocument(content)
  doc.setIn(['dns', 'enable'], enabled)
  return trimFlowSeqPadding(doc.toString({ lineWidth: YAML_LINE_WIDTH }))
}

export function ensureDnsEnabled(content: string, config: DnsConfig): string {
  const doc = parseDocument(content)
  const hasDns = doc.hasIn(['dns'])

  if (!hasDns) {
    return patchDnsConfig(content, config)
  }

  doc.setIn(['dns', 'enable'], true)
  doc.setIn(['dns', 'listen'], DEFAULT_DNS_LISTEN)
  return trimFlowSeqPadding(doc.toString({ lineWidth: YAML_LINE_WIDTH }))
}

export const DnsPanel = memo(function DnsPanel() {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, clashApiPort, clashApiSecret, clashApiUnix } = state
  const dnsRefreshToken = useDnsStatusStore((s) => s.token)
  const dnsStatus = useDnsStatusStore((s) => s.status)
  const isLoading = useDnsStatusStore((s) => s.loading)

  const [isToggling, setIsToggling] = useState(false)
  const [enableDialogOpen, setEnableDialogOpen] = useState(false)
  const [setupFilter, setSetupFilter] = useState(() => localStorage.getItem(SETUP_FILTER_STORAGE_KEY) !== 'false')
  const [fakeIpWarningDismissed, setFakeIpWarningDismissed] = useState(() => localStorage.getItem(FAKE_IP_WARNING_STORAGE_KEY) === 'true')
  const [disableOpen, setDisableOpen] = useState(false)
  const [config, setConfig] = useState<DnsConfig>(DEFAULT_DNS_CONFIG)
  const [isApplying, setIsApplying] = useState(false)
  const [flushingCache, setFlushingCache] = useState<'fakeip' | 'dns' | null>(null)
  const [confirmFlush, setConfirmFlush] = useState<'fakeip' | 'dns' | null>(null)
  const [dnsQueryName, setDnsQueryName] = useState('')
  const [dnsQueryType, setDnsQueryType] = useState<string>('A')
  const [isQueryingDns, setIsQueryingDns] = useState(false)
  const [dnsQueryResult, setDnsQueryResult] = useState<DnsQueryResponse | null>(null)
  const [dnsQueryError, setDnsQueryError] = useState<string | null>(null)

  const yamlConfig = useMemo(() => configs.find((c: Config) => c.file.endsWith('/config.yaml')), [configs])

  const refreshConfigs = useCallback(async () => {
    const result = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs')
    if (result.success && result.configs) {
      dispatch({ type: 'SET_CONFIGS', configs: result.configs.map((c) => ({ ...c, savedContent: c.content, isDirty: false })) })
    }
  }, [dispatch])

  const isAllActive = useMemo(() => !!dnsStatus && dnsStatus.dnsOverride && dnsStatus.dnsMihomo, [dnsStatus])

  const showMihomoSettings = useMemo(() => !!dnsStatus && dnsStatus.dnsMihomo, [dnsStatus])

  const showFakeIpWarning =
    config.enhancedMode === 'fake-ip' &&
    config.fakeIpFilterMode !== 'whitelist' &&
    config.fakeIpFilterMode !== 'rule' &&
    !fakeIpWarningDismissed

  const portListener = dnsStatus?.portListener
  const isMihomoListeningPort = !!portListener?.toLowerCase().includes('mihomo')
  const portListenerLabel = dnsStatus ? formatPortListener(portListener ?? 'Нет слушателя') : 'Неизвестно'

  const fetchStatus = useCallback(async () => {
    try {
      await fetchDnsStatus()
    } catch {
      showToast('Ошибка получения статуса DNS', 'error')
    }
  }, [showToast])

  useEffect(() => {
    if (dnsRefreshToken === 0) return
    fetchStatus()
  }, [fetchStatus, dnsRefreshToken])

  useEffect(() => {
    if (!yamlConfig) return
    const content = yamlConfig.savedContent || yamlConfig.content

    let parsed: Record<string, unknown>
    try {
      parsed = jsyaml.load(content) as Record<string, unknown>
    } catch {
      return
    }

    const dns = parsed?.dns as Record<string, unknown> | undefined
    if (!dns) return

    const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
    const toLines = (v: unknown): string => {
      if (Array.isArray(v)) return v.join('\n')
      if (typeof v === 'string') return v
      return ''
    }

    const enhancedMode = toStr(dns['enhanced-mode']) || 'fake-ip'
    const fakeIpFilterMode = toStr(dns['fake-ip-filter-mode']) || 'blacklist'
    const fakeIpFilter = toLines(dns['fake-ip-filter'])
    const bootstrap = toLines(dns['default-nameserver'])
    const nameserver = toLines(dns['nameserver'])
    const proxyServerNameserver = toLines(dns['proxy-server-nameserver'])
    const fallback = toLines(dns['fallback'])

    let nameserverPolicy = ''
    const policy = dns['nameserver-policy'] as Record<string, unknown> | undefined
    if (policy) {
      const entries: string[] = []
      for (const [key, val] of Object.entries(policy)) {
        if (Array.isArray(val)) {
          if (val.length === 1) entries.push(`${key}: ${val[0]}`)
          else if (val.length > 1) entries.push(`${key}: [${val.join(', ')}]`)
        } else if (typeof val === 'string') {
          entries.push(`${key}: ${val}`)
        }
      }
      nameserverPolicy = entries.join('\n')
    }

    setConfig({
      enhancedMode,
      fakeIpFilterMode,
      fakeIpFilter,
      bootstrap,
      nameserver,
      proxyServerNameserver,
      nameserverPolicy,
      fallback,
    })
  }, [yamlConfig])

  const handleToggleEnable = useCallback((value: boolean) => {
    if (value) {
      setEnableDialogOpen(true)
      return
    }
    setDisableOpen(true)
  }, [])

  const handleConfirmDisable = useCallback(async () => {
    setDisableOpen(false)
    setIsToggling(true)
    try {
      if (yamlConfig) {
        const content = yamlConfig.savedContent || yamlConfig.content
        const updated = setDnsEnabled(content, false)
        const saveResult = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', {
          file: yamlConfig.file,
          content: updated,
        })
        if (!saveResult.success) {
          showToast(`Ошибка сохранения: ${saveResult.error}`, 'error')
          return
        }
        await clashFetch(clashApiPort ?? '', 'configs?force=true', {
          method: 'PUT',
          secret: clashApiSecret,
          unix: clashApiUnix,
          body: {},
        })
        await refreshConfigs()
      }

      // Порядок обязателен: сначала reload михомо (отпускает :53),
      // только потом DELETE dns (KeeneticOS забирает порт). Параллелить нельзя — bind упадёт.
      const result = await apiCall<{ success: boolean; error?: string }>('DELETE', 'dns', {})
      if (result.success) {
        showToast('Управление DNS отключено')
        await fetchStatus()
      } else {
        showToast(`Ошибка: ${result.error}`, 'error')
      }
    } catch {
      showToast('Ошибка отключения DNS', 'error')
    } finally {
      setIsToggling(false)
    }
  }, [fetchStatus, showToast, yamlConfig, clashApiPort, clashApiSecret, clashApiUnix, refreshConfigs])

  const handleConfirmEnable = useCallback(async () => {
    if (!yamlConfig) {
      showToast('Конфигурация ещё не загружена', 'error')
      return
    }
    setEnableDialogOpen(false)
    setIsToggling(true)
    try {
      const content = yamlConfig.savedContent || yamlConfig.content
      const configContent = ensureDnsEnabled(content, config)
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'dns', {
        config_content: configContent,
        setup_filter: setupFilter,
      })
      if (result.success) {
        await clashFetch(clashApiPort ?? '', 'configs?force=true', {
          method: 'PUT',
          secret: clashApiSecret,
          unix: clashApiUnix,
          body: {},
        })
        await refreshConfigs()
        showToast('Управление DNS включено')
        await fetchStatus()
      } else {
        showToast(`Ошибка: ${result.error}`, 'error')
      }
    } catch {
      showToast('Ошибка включения DNS', 'error')
    } finally {
      setIsToggling(false)
    }
  }, [config, yamlConfig, setupFilter, fetchStatus, showToast, clashApiPort, clashApiSecret, clashApiUnix, refreshConfigs])

  const handleApply = useCallback(async () => {
    if (!yamlConfig) return
    setIsApplying(true)
    try {
      const content = yamlConfig.savedContent || yamlConfig.content
      const updated = patchDnsConfig(content, config)

      const saveResult = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', {
        file: yamlConfig.file,
        content: updated,
      })
      if (!saveResult.success) {
        showToast(`Ошибка сохранения: ${saveResult.error}`, 'error')
        return
      }

      try {
        await clashFetch(clashApiPort ?? '', 'configs?force=true', {
          method: 'PUT',
          secret: clashApiSecret,
          unix: clashApiUnix,
          body: {},
        })
      } catch (mihomoError) {
        const rollbackResult = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', {
          file: yamlConfig.file,
          content,
        })
        await refreshConfigs()

        const mihomoMessage = mihomoError instanceof Error ? mihomoError.message : String(mihomoError)
        if (!rollbackResult.success) {
          throw new Error(`${mihomoMessage}. Не удалось откатить config.yaml: ${rollbackResult.error}`)
        }
        throw new Error(mihomoMessage)
      }

      await refreshConfigs()
      showToast('DNS настройки применены')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      showToast(`Ошибка применения: ${msg}`, 'error')
    } finally {
      setIsApplying(false)
    }
  }, [config, yamlConfig, showToast, clashApiPort, clashApiSecret, clashApiUnix, refreshConfigs])

  const updateConfig = useCallback((patch: Partial<DnsConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
  }, [])

  const handleFlushCache = useCallback(
    async (kind: 'fakeip' | 'dns') => {
      setFlushingCache(kind)
      try {
        await clashFetch(clashApiPort ?? '', kind === 'fakeip' ? 'cache/fakeip/flush' : 'cache/dns/flush', {
          method: 'POST',
          secret: clashApiSecret,
          unix: clashApiUnix ?? null,
          retry: false,
        })
        showToast(kind === 'fakeip' ? 'Кэш Fake-IP очищен' : 'Кэш DNS очищен')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        showToast(`Ошибка очистки кэша: ${msg}`, 'error')
      } finally {
        setFlushingCache(null)
      }
    },
    [clashApiPort, clashApiSecret, clashApiUnix, showToast]
  )

  const handleConfirmFlush = useCallback(
    (kind: 'fakeip' | 'dns') => {
      setConfirmFlush(null)
      void handleFlushCache(kind)
    },
    [handleFlushCache]
  )

  const handleDnsQuery = useCallback(async () => {
    const name = dnsQueryName.trim()
    if (!name) return

    setIsQueryingDns(true)
    setDnsQueryError(null)
    try {
      const data = await clashFetch<DnsQueryResponse>(
        clashApiPort ?? '',
        `dns/query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(dnsQueryType)}`,
        { secret: clashApiSecret, unix: clashApiUnix ?? null, retry: false }
      )
      setDnsQueryResult(data)
    } catch (e) {
      setDnsQueryResult(null)
      setDnsQueryError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsQueryingDns(false)
    }
  }, [dnsQueryName, dnsQueryType, clashApiPort, clashApiSecret, clashApiUnix])

  const dismissFakeIpWarning = useCallback(() => {
    setFakeIpWarningDismissed(true)
    localStorage.setItem(FAKE_IP_WARNING_STORAGE_KEY, 'true')
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 flex scrollbar-thin flex-col gap-4 overflow-y-auto">
        <fieldset className="border-border rounded-lg border px-4 pt-1.5 pb-4">
          <legend className="px-1 text-sm font-medium">Статус</legend>
          <div className="flex flex-col gap-3 pt-1">
            {dnsStatus && dnsStatus.hasProviderNameservers && (
              <Alert className="border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
                <IconAlertCircle className="size-4.5" />
                <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
                  Найдены активные DNS провайдера. Перед включением управления DNS рекомендуется включить галочку «игнорировать DNS
                  интернет-провайдера» в веб-конфигураторе Keenetic, в противном случае могут возникнуть утечки.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">DNS Override</Label>
                <Badge variant={dnsStatus?.dnsOverride ? 'emerald' : 'rose'}>{dnsStatus?.dnsOverride ? 'Активно' : 'Неактивно'}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">DNS Mihomo</Label>
                <Badge variant={dnsStatus?.dnsMihomo ? 'emerald' : 'rose'}>{dnsStatus?.dnsMihomo ? 'Активно' : 'Неактивно'}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Слушатель 53 порта</Label>
                <Badge variant={isMihomoListeningPort ? 'emerald' : 'rose'}>{portListenerLabel}</Badge>
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="dns-toggle" className="text-sm font-medium">
                    Включить управление DNS
                  </Label>
                  <p className="text-muted-foreground text-xs">Передача управления DNS от KeeneticOS к Mihomo</p>
                </div>
                <Switch id="dns-toggle" checked={isAllActive} onCheckedChange={handleToggleEnable} disabled={isToggling || isLoading} />
              </div>
            </div>
          </div>
        </fieldset>

        {showMihomoSettings && (
          <fieldset className="border-border rounded-lg border px-4 pt-1.5 pb-4">
            <legend className="px-1 text-sm font-medium">Диагностика</legend>
            <div className="flex flex-col gap-4 pt-1">
              <div className="grid gap-2">
                <Label className="text-xs">Очистка кэша</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <AlertDialog open={confirmFlush === 'fakeip'} onOpenChange={(open) => setConfirmFlush(open ? 'fakeip' : null)}>
                    <AlertDialogTrigger
                      render={
                        <Button variant="outline" disabled={flushingCache !== null}>
                          {flushingCache === 'fakeip' ? <Spinner /> : <IconTrash data-icon="inline-start" />}
                          Очистить кэш Fake-IP
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogMedia>
                          <IconTrash />
                        </AlertDialogMedia>
                        <AlertDialogTitle>Очистить кэш Fake-IP?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Таблица соответствия доменов и Fake-IP будет очищена.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setConfirmFlush(null)}>Отмена</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => handleConfirmFlush('fakeip')}>
                          Очистить
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <AlertDialog open={confirmFlush === 'dns'} onOpenChange={(open) => setConfirmFlush(open ? 'dns' : null)}>
                    <AlertDialogTrigger
                      render={
                        <Button variant="outline" disabled={flushingCache !== null}>
                          {flushingCache === 'dns' ? <Spinner /> : <IconTrash data-icon="inline-start" />}
                          Очистить кэш DNS
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogMedia>
                          <IconTrash />
                        </AlertDialogMedia>
                        <AlertDialogTitle>Очистить кэш DNS?</AlertDialogTitle>
                        <AlertDialogDescription>Все закэшированные DNS-ответы будут удалены.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setConfirmFlush(null)}>Отмена</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => handleConfirmFlush('dns')}>
                          Очистить
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>

              <Separator />

              <div className="grid gap-2">
                <Label htmlFor="dns-query-name" className="text-xs">
                  DNS запрос
                </Label>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void handleDnsQuery()
                  }}
                >
                  <InputGroup className="min-w-0 flex-1">
                    <InputGroupInput
                      id="dns-query-name"
                      value={dnsQueryName}
                      onChange={(e) => setDnsQueryName(e.target.value)}
                      placeholder="example.com"
                      className="tracking-wide"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        type="submit"
                        variant="default"
                        className="rounded-sm"
                        aria-label="Выполнить DNS запрос"
                        disabled={!dnsQueryName.trim() || isQueryingDns}
                      >
                        <span className="text-xs">Искать</span>
                        {isQueryingDns ? <Spinner /> : <IconSearch />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  <Select value={dnsQueryType} items={DNS_QUERY_TYPE_ITEMS} onValueChange={(v) => setDnsQueryType(v)}>
                    <SelectTrigger popper className="w-32 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectGroup>
                        {DNS_QUERY_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </form>

                {dnsQueryError && <p className="text-destructive text-xs break-all">{dnsQueryError}</p>}

                {dnsQueryResult && (
                  <div className="border-border overflow-hidden rounded-md border">
                    <div className="bg-muted/40 flex items-center justify-between gap-2 px-2.5 py-2">
                      <span className="text-xs font-medium">Ответ</span>
                      <Badge variant={dnsQueryResult.Status === 0 ? 'emerald' : 'rose'}>
                        {dnsQueryResult.Status === 0 ? 'NOERROR' : `Rcode ${dnsQueryResult.Status ?? '—'}`}
                      </Badge>
                    </div>
                    {dnsQueryResult.Answer?.length ? (
                      <Table className="text-sm">
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-8 w-14 px-2.5">Тип</TableHead>
                            <TableHead className="h-8 w-full px-2.5">Данные</TableHead>
                            <TableHead className="h-8 w-14 px-2.5 text-right">TTL</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {dnsQueryResult.Answer.map((record, index) => (
                            <TableRow key={`${record.name ?? ''}-${record.type ?? ''}-${index}`} className="hover:bg-transparent">
                              <TableCell className="px-2.5 py-1.5">
                                <Badge variant="outline" className="h-4.5 rounded-full px-1.5 text-xs font-normal tracking-wider">
                                  {formatDnsRecordType(record.type)}
                                </Badge>
                              </TableCell>
                              <TableCell className="w-full px-2.5 py-1.5 whitespace-normal">
                                <span className="break-all">{record.data ?? '—'}</span>
                                {record.name && <span className="text-muted-foreground mt-0.5 block truncate text-xs">{record.name}</span>}
                              </TableCell>
                              <TableCell className="text-muted-foreground px-2.5 py-1.5 text-right tabular-nums">
                                {record.TTL ?? '—'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <p className="text-muted-foreground px-2.5 py-2 text-xs">В ответе нет записей</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </fieldset>
        )}

        {showMihomoSettings && (
          <fieldset className="border-border rounded-lg border px-4 pt-1.5 pb-4">
            <legend className="px-1 text-sm font-medium">Настройки</legend>
            <div className="flex flex-col gap-4 pt-1">
              {showFakeIpWarning && (
                <Alert className="border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
                  <IconAlertCircle className="size-4.5" />
                  <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
                    Потенциально проблемная конфигурация DNS. Для режима <strong>fake-ip</strong> рекомендуется использовать режим фильтра{' '}
                    <strong>whitelist</strong> либо <strong>rule</strong>, в противном случае возникнут проблемы с трафиком, проходящим мимо
                    ядра Mihomo.{' '}
                    <a
                      href="https://wiki.metacubex.one/ru/config/dns/#fake-ip-filter-mode"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      Подробнее...
                    </a>
                  </AlertDescription>
                  <AlertAction>
                    <button
                      type="button"
                      onClick={dismissFakeIpWarning}
                      aria-label="Скрыть предупреждение"
                      className="rounded-md p-1 opacity-70 hover:opacity-100"
                    >
                      <IconX size={18} />
                    </button>
                  </AlertAction>
                </Alert>
              )}
              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Redir-host - реальные IP в ответах. Медленнее, лучше совместимость, рекомендуется \nFake-ip - поддельные IP в ответах. Быстрее, не совместимо с исключениями/политиками XKeen, для продвинутых пользователей">
                  Enhanced Mode
                </DnsSettingLabel>
                <Select
                  value={config.enhancedMode}
                  items={{ 'redir-host': 'redir-host', 'fake-ip': 'fake-ip' }}
                  onValueChange={(v) => updateConfig({ enhancedMode: v })}
                >
                  <SelectTrigger popper className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectGroup>
                      <SelectItem value="redir-host">redir-host</SelectItem>
                      <SelectItem value="fake-ip">fake-ip</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {config.enhancedMode === 'fake-ip' && (
                <>
                  <div className="grid gap-2">
                    <DnsSettingLabel
                      tooltip="Режим фильтрации Fake IP.
                      Whitelist - использовать fake-ip только для перечисленных доменов.
                      Blacklist - Использовать fake-ip для всего, кроме перечисленных доменов.
                      Rule - classical правила domain-suffix, domain-keyword и пр.
                      Для Whitelist и Blacklist поддерживается rule-set: и +. синтаксис"
                    >
                      Fake IP Filter Mode
                    </DnsSettingLabel>
                    <Select
                      value={config.fakeIpFilterMode}
                      items={{ blacklist: 'blacklist', whitelist: 'whitelist', rule: 'rule' }}
                      onValueChange={(v) => updateConfig({ fakeIpFilterMode: v })}
                    >
                      <SelectTrigger popper className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        <SelectGroup>
                          <SelectItem value="blacklist">blacklist</SelectItem>
                          <SelectItem value="whitelist">whitelist</SelectItem>
                          <SelectItem value="rule">rule</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <DnsSettingLabel tooltip="Список доменов для фильтрации fake-ip. По одному на строку.">Fake IP Filter</DnsSettingLabel>
                    <Textarea
                      value={config.fakeIpFilter}
                      onChange={(e) => updateConfig({ fakeIpFilter: e.target.value })}
                      placeholder={'+.local'}
                      className="min-h-15 text-sm! tracking-wide"
                    />
                  </div>
                </>
              )}

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Основные DNS-резолверы. Поддерживаются: udp:// tcp:// https:// tls:// quic://. По одному на строку.\nДля того чтобы направить запросы через определенное подключение, укажите #PROXY в конец ссылки, где 'PROXY' - название прокси/селектора. Примеры: \n tls://1.1.1.1#vless-reality\n Или:\n tls://1.1.1.1#Заблок. сервисы">
                  Nameserver
                </DnsSettingLabel>
                <Textarea
                  value={config.nameserver}
                  onChange={(e) => updateConfig({ nameserver: e.target.value })}
                  placeholder={'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query'}
                  className="min-h-15 text-sm! tracking-wide"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Позволяет указать какие резолверы использовать для каких доменов. Поддерживается rule-set: и +. синтаксис. Примеры: \nexample.com: tls://1.1.1.1\n+.ru: 77.88.8.8\nrule-set:example: [1.1.1.1, 8.8.8.8]">
                  Nameserver Policy
                </DnsSettingLabel>
                <Textarea
                  value={config.nameserverPolicy}
                  onChange={(e) => updateConfig({ nameserverPolicy: e.target.value })}
                  placeholder={'rule-set:category-ru@domain: [77.88.8.8, 195.208.5.1]'}
                  className="min-h-15 text-sm! tracking-wide"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="При проксировании всех DNS из поля Nameserver, если адрес выбранного подключения является доменным именем, его нужно разрешить через отдельные резолверы. Здесь можно указать через какие.">
                  Proxy Server Nameserver
                </DnsSettingLabel>
                <Textarea
                  value={config.proxyServerNameserver}
                  onChange={(e) => updateConfig({ proxyServerNameserver: e.target.value })}
                  placeholder={'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query'}
                  className="min-h-15 text-sm! tracking-wide"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Резервные DNS-резолверы. Используются, если разрешение через основные - безуспешно.">
                  Fallback
                </DnsSettingLabel>
                <Textarea
                  value={config.fallback}
                  onChange={(e) => updateConfig({ fallback: e.target.value })}
                  placeholder={'tls://1.1.1.1\ntls://8.8.8.8'}
                  className="min-h-15 text-sm! tracking-wide"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="DNS-резолверы для разрешения других резолверов, у которых в качестве адреса используется доменное имя. Допустимы только IP-адреса.">
                  Bootstrap DNS
                </DnsSettingLabel>
                <Textarea
                  value={config.bootstrap}
                  onChange={(e) => updateConfig({ bootstrap: e.target.value })}
                  placeholder={'77.88.8.8\n77.8.8.1'}
                  className="min-h-15 text-sm! tracking-wide"
                />
              </div>

              <Button className="w-full" onClick={handleApply} disabled={isApplying}>
                {isApplying ? <Spinner /> : <IconDeviceFloppy data-icon="inline-start" />}
                Применить
              </Button>
            </div>
          </fieldset>
        )}
      </div>

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отключить управление DNS?</AlertDialogTitle>
            <AlertDialogDescription>
              Mihomo DNS и opkg dns-override будут отключены, а управление передано обратно KeeneticOS.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDisableOpen(false)}>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDisable}>
              Отключить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={enableDialogOpen} onOpenChange={setEnableDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Включить управление DNS?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs whitespace-pre-line">
              Обратите внимание, что после включения этой функции DNS-разрешения в роутере будет целиком зависить от Mihomo и его
              конфигурации. В связи с этим перед остановкой сервиса необходимо отключить "Управление DNS", иначе доступ к интернету может
              пропасть.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Автонастройка интернет-фильтра</Label>
              <Switch
                checked={setupFilter}
                onCheckedChange={(checked) => {
                  setSetupFilter(checked)
                  localStorage.setItem(SETUP_FILTER_STORAGE_KEY, String(checked))
                }}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Будет выполнена очистка DoU, DoT и DoH резолверов и добавлен IPv4 адрес br0 интерфейса для перенаправления запросов в Mihomo
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setEnableDialogOpen(false)}>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmEnable}>Продолжить</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
})
