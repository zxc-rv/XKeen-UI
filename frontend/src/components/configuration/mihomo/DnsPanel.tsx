import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { IconAlertCircle, IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { isNode, isSeq, parseDocument, YAMLMap, type Document } from 'yaml'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall, clashFetch } from '../../../lib/api'
import { useAppContext, useDnsStatusStore, setDnsStatus, setDnsStatusLoading } from '../../../lib/store'
import type { Config } from '../../../lib/types'

import type { DnsStatus } from '../../../lib/store'

interface DnsStatusResponse {
  success: boolean
  status?: DnsStatus
}

function DnsSettingLabel({ children, tooltip }: { children: string; tooltip: string }) {
  const formattedTooltip = tooltip.replaceAll('\\n', '\n')

  return (
    <div className="flex items-center gap-1">
      <Label className="text-xs">{children}</Label>
      <Tooltip>
        <TooltipTrigger render={<span className="text-muted-foreground inline-flex cursor-help" />} aria-label={`Подробнее: ${children}`}>
          <IconInfoCircle size={14} />
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-xs whitespace-pre-line">
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
  nameserverPolicy: string
  fallback: string
}

export const DEFAULT_DNS_CONFIG: DnsConfig = {
  enhancedMode: 'redir-host',
  fakeIpFilterMode: 'blacklist',
  fakeIpFilter: '+.local',
  bootstrap: '77.88.8.8',
  nameserver: 'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query',
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
    return {}
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

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
  } else {
    doc.deleteIn(['dns', 'fake-ip-filter-mode'])
    doc.deleteIn(['dns', 'fake-ip-filter'])
  }

  setOrDeleteList(doc, ['dns', 'default-nameserver'], parseList(config.bootstrap))

  const policyCommentBefore = getCommentBefore(doc, ['dns', 'nameserver-policy'])
  const policyNode = buildPolicyNode(doc, config.nameserverPolicy)
  if (policyCommentBefore !== undefined) policyNode.commentBefore = policyCommentBefore
  if (policyNode.items.length) doc.setIn(['dns', 'nameserver-policy'], policyNode)
  else doc.deleteIn(['dns', 'nameserver-policy'])

  setOrDeleteList(doc, ['dns', 'nameserver'], parseList(config.nameserver))
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
  const [setupFilter, setSetupFilter] = useState(true)
  const [disableOpen, setDisableOpen] = useState(false)
  const [config, setConfig] = useState<DnsConfig>(DEFAULT_DNS_CONFIG)
  const [isApplying, setIsApplying] = useState(false)

  const yamlConfig = useMemo(() => configs.find((c: Config) => c.file.endsWith('/config.yaml')), [configs])

  const refreshConfigs = useCallback(async () => {
    const result = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs')
    if (result.success && result.configs) {
      dispatch({ type: 'SET_CONFIGS', configs: result.configs.map((c) => ({ ...c, savedContent: c.content, isDirty: false })) })
    }
  }, [dispatch])

  const isAllActive = useMemo(
    () => !!dnsStatus && dnsStatus.dnsOverride && dnsStatus.dnsMihomo,
    [dnsStatus]
  )

  const showMihomoSettings = useMemo(
    () => !!dnsStatus && dnsStatus.dnsMihomo,
    [dnsStatus]
  )

  const fetchStatus = useCallback(async () => {
    setDnsStatusLoading(true)
    try {
      const data = await apiCall<DnsStatusResponse>('GET', 'dns')
      if (data.success && data.status) {
        setDnsStatus(data.status)
      }
    } catch {
      showToast('Ошибка получения статуса DNS', 'error')
    } finally {
      setDnsStatusLoading(false)
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
        await clashFetch(clashApiPort ?? '', 'configs', {
          method: 'PUT',
          secret: clashApiSecret,
          unix: clashApiUnix,
          body: {},
        })
        await refreshConfigs()
      }

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
        await clashFetch(clashApiPort ?? '', 'configs', {
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

      await clashFetch(clashApiPort ?? '', 'configs', {
        method: 'PUT',
        secret: clashApiSecret,
        unix: clashApiUnix,
        body: {},
      })
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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col gap-4 p-4">
        <fieldset className="border-border rounded-lg border px-4 pb-4 pt-1.5">
          <legend className="text-sm font-medium px-1">Статус DNS</legend>
          <div className="flex flex-col gap-3 pt-1">
            {!isLoading && dnsStatus && !dnsStatus.providerIgnored && (
              <Alert className="border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
                <IconAlertCircle className="size-4.5" />
                <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
                  Игнорирование DNS провайдера не определено. Могут возникнуть утечки.
                </AlertDescription>
              </Alert>
            )}
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Загрузка...
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">DNS Override</Label>
                  <Badge variant={dnsStatus?.dnsOverride ? 'emerald' : 'rose'}>
                    {dnsStatus?.dnsOverride ? 'Активно' : 'Неактивно'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">DNS Mihomo</Label>
                  <Badge variant={dnsStatus?.dnsMihomo ? 'emerald' : 'rose'}>
                    {dnsStatus?.dnsMihomo ? 'Активно' : 'Неактивно'}
                  </Badge>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="dns-toggle" className="text-sm font-medium">
                      Включить управление DNS
                    </Label>
                    <p className="text-muted-foreground text-xs">
                      Передача управления DNS от KeeneticOS к Mihomo
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isToggling && <Spinner className="text-muted-foreground" />}
                    <Switch
                      id="dns-toggle"
                      checked={isAllActive}
                      onCheckedChange={handleToggleEnable}
                      disabled={isToggling || isLoading}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </fieldset>

        {showMihomoSettings && (
          <fieldset className="border-border rounded-lg border px-4 pb-4 pt-1.5">
            <legend className="text-sm font-medium px-1">Mihomo DNS</legend>
            <div className="flex flex-col gap-4 pt-1">
              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Redir-host - реальные IP в ответах. Медленнее, лучше совместимость, рекомендуется \nFake-ip - поддельные IP в ответах. Быстрее, не совместимо с исключениями/политиками XKeen, для продвинутых пользователей">
                  Enhanced Mode
                </DnsSettingLabel>
                <Select
                  value={config.enhancedMode}
                  items={{ 'redir-host': 'redir-host', 'fake-ip': 'fake-ip' }}
                  onValueChange={(v) => updateConfig({ enhancedMode: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
                    <DnsSettingLabel tooltip="Режим фильтрации Fake IP.
                      Whitelist - использовать fake-ip только для перечисленных доменов. 
                      Blacklist - Использовать fake-ip для всего, кроме перечисленных доменов.
                      Rule - classical правила domain-suffix, domain-keyword и пр.
                      Для Whitelist и Blacklist поддерживается rule-set: и +. синтаксис">
                      Fake IP Filter Mode
                    </DnsSettingLabel>
                    <Select
                      value={config.fakeIpFilterMode}
                      items={{ blacklist: 'blacklist', whitelist: 'whitelist', rule: 'rule' }}
                      onValueChange={(v) => updateConfig({ fakeIpFilterMode: v })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="blacklist">blacklist</SelectItem>
                          <SelectItem value="whitelist">whitelist</SelectItem>
                          <SelectItem value="rule">rule</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <DnsSettingLabel tooltip="Список доменов для фильтрации fake-ip. По одному на строку.">
                      Fake IP Filter
                    </DnsSettingLabel>
                    <Textarea
                      value={config.fakeIpFilter}
                      onChange={(e) => updateConfig({ fakeIpFilter: e.target.value })}
                      placeholder={'+.local'}
                      className="min-h-15 tracking-wide text-sm!"
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
                  className="min-h-15 tracking-wide text-sm!"
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
                  className="min-h-15 tracking-wide text-sm!"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Резервные DNS-резолверы. Используются, если разрешение через основные - безуспешно.">
                  Fallback
                </DnsSettingLabel>
                <Textarea
                  value={config.fallback}
                  onChange={(e) => updateConfig({ fallback: e.target.value })}
                  placeholder={'tls://8.8.4.4\ntls://1.1.1.1'}
                  className="min-h-15 tracking-wide text-sm!"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="DNS-резолвер для разрешения других резолверов, у которых в качестве адреса используется доменное имя. Допустимы только IP-адреса.">
                  Bootstrap DNS
                </DnsSettingLabel>
                <Textarea
                  value={config.bootstrap}
                  onChange={(e) => updateConfig({ bootstrap: e.target.value })}
                  placeholder={'77.88.8.8\n77.8.8.1'}
                  className="min-h-15 tracking-wide text-sm!"
                />
              </div>

              <Button
                className="w-full"
                onClick={handleApply}
                disabled={isApplying}
              >
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
              Будет отключен Mihomo DNS, dns-override и при необходимости перенастроен интернет-фильтр.
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
            <AlertDialogDescription>
              Передача управление DNS от KeeneticOS к Mihomo
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Автонастройка интернет-фильтра</Label>
              <Switch checked={setupFilter} onCheckedChange={setSetupFilter} />
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
