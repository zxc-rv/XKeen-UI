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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconAlertCircle, IconCircleCheckFilled, IconCircleXFilled, IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { apiCall, clashFetch } from '../../../lib/api'
import { useAppContext } from '../../../lib/store'
import type { Config } from '../../../lib/types'

interface DnsStatus {
  dnsOverride: boolean
  dnsMihomo: boolean
  providerIgnored: boolean
}

interface DnsStatusResponse {
  success: boolean
  status?: DnsStatus
}

function StatusIndicator({ active }: { active: boolean }) {
  return active ? (
    <IconCircleCheckFilled size={16} className="text-emerald-400" />
  ) : (
    <IconCircleXFilled size={16} className="text-red-400" />
  )
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

const DEFAULT_DNS_CONFIG: DnsConfig = {
  enhancedMode: 'redir-host',
  fakeIpFilterMode: 'blacklist',
  fakeIpFilter: '+.lan',
  bootstrap: '77.88.8.8',
  nameserver: 'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query',
  nameserverPolicy: '',
  fallback: 'tls://8.8.4.4\ntls://1.1.1.1',
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
  const result: Record<string, string[]> = {}
  const lines = text.split('\n').map((l) => l.trim())
  let currentKey = ''
  for (const line of lines) {
    if (!line) continue
    if (line.endsWith(':') && !line.startsWith('-')) {
      currentKey = line.slice(0, -1).trim()
      if (currentKey) result[currentKey] = []
    } else if (currentKey && line.startsWith('-')) {
      const val = line.slice(1).trim()
      if (val) result[currentKey].push(val)
    }
  }
  return result
}

function buildDnsYaml(config: DnsConfig): string {
  const lines: string[] = []
  lines.push('dns:')
  lines.push('  enable: true')
  lines.push('  listen: 0.0.0.0:53')
  lines.push('  ipv6: true')
  lines.push('  enhanced-mode: ' + config.enhancedMode)

  if (config.enhancedMode === 'fake-ip') {
    lines.push('  fake-ip-filter-mode: ' + config.fakeIpFilterMode)
    const filters = parseList(config.fakeIpFilter)
    if (filters.length) {
      lines.push('  fake-ip-filter:')
      for (const f of filters) lines.push('    - ' + f)
    }
  }

  const bootstrap = parseList(config.bootstrap)
  if (bootstrap.length) {
    lines.push('  default-nameserver:')
    for (const b of bootstrap) lines.push('    - ' + b)
  }

  const policy = parseNameserverPolicy(config.nameserverPolicy)
  if (Object.keys(policy).length) {
    lines.push('  nameserver-policy:')
    for (const [key, servers] of Object.entries(policy)) {
      if (servers.length === 1) {
        lines.push(`    "${key}": ${servers[0]}`)
      } else if (servers.length > 1) {
        lines.push(`    "${key}":`)
        for (const s of servers) lines.push(`      - ${s}`)
      }
    }
  }

  const nameservers = parseList(config.nameserver)
  if (nameservers.length) {
    lines.push('  nameserver:')
    for (const n of nameservers) lines.push('    - ' + n)
  }

  const fallbacks = parseList(config.fallback)
  if (fallbacks.length) {
    lines.push('  fallback:')
    for (const f of fallbacks) lines.push('    - ' + f)
  }

  lines.push('  fallback-filter: { geoip: false }')

  return lines.join('\n')
}

function replaceDnsBlock(content: string, newBlock: string): string {
  const lines = content.split('\n')
  let dnsStart = -1
  let dnsEnd = lines.length

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('dns:') || lines[i].startsWith('dns :')) {
      dnsStart = i
      continue
    }
    if (dnsStart >= 0 && !lines[i].startsWith(' ') && !lines[i].startsWith('\t') && lines[i].trim() !== '') {
      dnsEnd = i
      break
    }
  }

  if (dnsStart >= 0) {
    lines.splice(dnsStart, dnsEnd - dnsStart, newBlock)
  } else {
    lines.push('')
    lines.push(newBlock)
  }

  return lines.join('\n')
}

function setDnsEnableFalse(content: string): string {
  const lines = content.split('\n')
  let inDns = false
  for (let i = 0; i < lines.length; i++) {
    if (/^dns\s*:/.test(lines[i])) {
      inDns = true
      continue
    }
    if (inDns && /^\S/.test(lines[i]) && lines[i].trim() !== '') {
      break
    }
    if (inDns && /^\s+enable:\s*true\s*$/.test(lines[i])) {
      lines[i] = lines[i].replace('enable: true', 'enable: false')
      break
    }
  }
  return lines.join('\n')
}

export const DnsPanel = memo(function DnsPanel() {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, clashApiPort, clashApiSecret, clashApiUnix } = state

  const [dnsStatus, setDnsStatus] = useState<DnsStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isToggling, setIsToggling] = useState(false)
  const [clearOptionsOpen, setClearOptionsOpen] = useState(false)
  const [clearDns, setClearDns] = useState(true)
  const [addBr0Nameserver, setAddBr0Nameserver] = useState(true)
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableClean, setDisableClean] = useState(true)
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
    try {
      const data = await apiCall<DnsStatusResponse>('GET', 'dns')
      if (data.success && data.status) {
        setDnsStatus(data.status)
      }
    } catch {
      showToast('Ошибка получения статуса DNS', 'error')
    } finally {
      setIsLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

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
        entries.push(`${key}:`)
        if (Array.isArray(val)) {
          for (const item of val) entries.push(`  - ${item}`)
        } else if (typeof val === 'string') {
          entries.push(`  - ${val}`)
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

  const handleToggleDnsOverride = useCallback(async (value: boolean) => {
    setIsToggling(true)
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PATCH', 'dns/override')
      if (result.success) {
        await fetchStatus()
        showToast(value ? 'DNS Override включен' : 'DNS Override отключен')
      } else {
        showToast(`Ошибка: ${result.error}`, 'error')
      }
    } catch {
      showToast('Ошибка переключения DNS Override', 'error')
    } finally {
      setIsToggling(false)
    }
  }, [fetchStatus, showToast])

  const handleToggleDnsMihomo = useCallback(async (value: boolean) => {
    setIsToggling(true)
    try {
      const result = await apiCall<{ success: boolean; error?: string }>('PATCH', 'dns/mihomo')
      if (result.success) {
        await fetchStatus()
        await refreshConfigs()
        showToast(value ? 'DNS Mihomo включен' : 'DNS Mihomo отключен')
      } else {
        showToast(`Ошибка: ${result.error}`, 'error')
      }
    } catch {
      showToast('Ошибка переключения DNS Mihomo', 'error')
    } finally {
      setIsToggling(false)
    }
  }, [fetchStatus, showToast, refreshConfigs])

  const handleToggleEnable = useCallback((value: boolean) => {
    if (value) {
      setClearOptionsOpen(true)
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
        const updated = setDnsEnableFalse(content)
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

      const result = await apiCall<{ success: boolean; error?: string }>('DELETE', 'dns', { clean: disableClean })
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
  }, [fetchStatus, showToast, yamlConfig, clashApiPort, clashApiSecret, clashApiUnix, refreshConfigs, disableClean])

  const handleApplyClearOptions = useCallback(async () => {
    setClearOptionsOpen(false)
    setIsToggling(true)
    try {
      const yaml = buildDnsYaml(config)
      const result = await apiCall<{ success: boolean; error?: string }>('POST', 'dns', {
        dns_config: yaml,
        clear_dns: clearDns,
        add_br0_nameserver: addBr0Nameserver,
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
  }, [config, clearDns, addBr0Nameserver, fetchStatus, showToast, clashApiPort, clashApiSecret, clashApiUnix, refreshConfigs])

  const handleApply = useCallback(async () => {
    if (!yamlConfig) return
    setIsApplying(true)
    try {
      const content = yamlConfig.savedContent || yamlConfig.content
      const newDnsBlock = buildDnsYaml(config)
      const updated = replaceDnsBlock(content, newDnsBlock)

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
    } catch {
      showToast('Ошибка применения DNS', 'error')
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
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Статус DNS</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
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
                  <div className="flex items-center gap-2 text-sm">
                    <StatusIndicator active={dnsStatus?.dnsOverride ?? false} />
                    DNS Override
                  </div>
                  <Switch
                    checked={dnsStatus?.dnsOverride ?? false}
                    onCheckedChange={handleToggleDnsOverride}
                    disabled={isToggling || isLoading}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    <StatusIndicator active={dnsStatus?.dnsMihomo ?? false} />
                    DNS Mihomo
                  </div>
                  <Switch
                    checked={dnsStatus?.dnsMihomo ?? false}
                    onCheckedChange={handleToggleDnsMihomo}
                    disabled={isToggling || isLoading}
                  />
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
          </CardContent>
        </Card>

        {showMihomoSettings && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Mihomo DNS</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Redir-host - реальные IP в ответах. Медленнее, лучше совместимость, рекомендуется \nFake-ip - поддельные IP в ответах. Быстрее, не совместимо с исключениями/политиками XKeen, для продвинутых пользователей">
                  Enhanced Mode
                </DnsSettingLabel>
                <Select
                  value={config.enhancedMode}
                  items={{ 'fake-ip': 'fake-ip', 'redir-host': 'redir-host' }}
                  onValueChange={(v) => updateConfig({ enhancedMode: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="fake-ip">fake-ip</SelectItem>
                      <SelectItem value="redir-host">redir-host</SelectItem>
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
                      placeholder={'+.lan'}
                      className="min-h-20 font-mono text-xs"
                    />
                  </div>
                </>
              )}

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Основные DNS-резолверы. Поддерживаются: udp:// tcp:// https:// tls:// quic://. По одному на строку.">
                  Nameserver
                </DnsSettingLabel>
                <Textarea
                  value={config.nameserver}
                  onChange={(e) => updateConfig({ nameserver: e.target.value })}
                  placeholder={'https://1.1.1.1/dns-query\nhttps://8.8.8.8/dns-query'}
                  className="min-h-20 font-mono text-xs"
                />
              </div>

              <div className="grid gap-2">
                <DnsSettingLabel tooltip="Позволяет указать какие резолверы использовать для каких доменов. Поддерживается rule-set: и +. синтаксис.">
                  Nameserver Policy
                </DnsSettingLabel>
                <Textarea
                  value={config.nameserverPolicy}
                  onChange={(e) => updateConfig({ nameserverPolicy: e.target.value })}
                  placeholder={'rule-set:ru:\n  - https://77.88.8.8/dns-query'}
                  className="min-h-24 font-mono text-xs"
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
                  className="min-h-20 font-mono text-xs"
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
                  className="min-h-16 font-mono text-xs"
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
            </CardContent>
          </Card>
        )}
      </div>

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отключить управление DNS?</AlertDialogTitle>
            <AlertDialogDescription>
              Будет отключен Mihomo DNS и opkg dns-override.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Очистить настройки DNS в KeeneticOS</Label>
              <Switch checked={disableClean} onCheckedChange={setDisableClean} />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDisableOpen(false)}>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmDisable}>
              Отключить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearOptionsOpen} onOpenChange={setClearOptionsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Очистка DNS настроек</AlertDialogTitle>
            <AlertDialogDescription>
              Выберите, какие настройки необходимо очистить перед включением управления DNS.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Очистить настройки DNS в KeeneticOS</Label>
              <Switch checked={clearDns} onCheckedChange={setClearDns} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Добавить br0 адрес в резолверы KeeneticOS</Label>
              <Switch checked={addBr0Nameserver} onCheckedChange={setAddBr0Nameserver} />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setClearOptionsOpen(false)}>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={handleApplyClearOptions}>Продолжить</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
})
