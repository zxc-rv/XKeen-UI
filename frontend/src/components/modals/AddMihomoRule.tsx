import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IconListDetails } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  addMihomoRule,
  inspectMihomoRuleConfig,
  MIHOMO_RULE_TYPES,
  normalizeMihomoRuleValues,
  type MihomoRuleOperation,
  type MihomoRuleType,
} from '../../lib/mihomo-rules'

interface Props {
  open: boolean
  content: string
  onOpenChange: (open: boolean) => void
  onInsert: (content: string) => void
  showToast: (message: string, type?: 'success' | 'error') => void
}

const OPERATION_LABELS: Record<MihomoRuleOperation, string> = {
  rules: 'Добавить правило в rules',
  'rule-set': 'Добавить RULE-SET (rule-provider)',
  'provider-import': 'Добавить provider по ссылке',
  inline: 'В payload inline-провайдера',
  payload: 'В payload текущего файла',
}

function formatRuleCount(count: number): string {
  const last = count % 10
  const lastTwo = count % 100
  const noun = last === 1 && lastTwo !== 11 ? 'правило' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'правила' : 'правил'
  return `${count} ${noun}`
}

function SelectorLabel({ name, icon }: { name: string; icon?: string }) {
  return <span className="inline-flex min-w-0 items-center gap-2">
    {icon && <img src={icon} alt="" className="size-4 shrink-0 rounded-sm object-contain" onError={event => { event.currentTarget.style.display = 'none' }} />}
    <span className="truncate">{name}</span>
  </span>
}

const TYPE_LABELS: Partial<Record<MihomoRuleType, string>> = {
  DOMAIN: 'Домен (DOMAIN)',
  'DOMAIN-SUFFIX': 'Домен и поддомены (DOMAIN-SUFFIX)',
  'DOMAIN-KEYWORD': 'Ключевое слово (DOMAIN-KEYWORD)',
  'DOMAIN-REGEX': 'Регулярное выражение (DOMAIN-REGEX)',
  'DOMAIN-WILDCARD': 'Шаблон домена (DOMAIN-WILDCARD)',
  GEOSITE: 'Категория геосайтов (GEOSITE)',
  'IP-CIDR': 'IPv4-сеть (IP-CIDR)',
  'IP-CIDR6': 'IPv6-сеть (IP-CIDR6)',
  'IP-SUFFIX': 'Суффикс IP (IP-SUFFIX)',
  GEOIP: 'Страна по IP (GEOIP)',
  'SRC-IP-CIDR': 'Исходная IP-сеть (SRC-IP-CIDR)',
  'DST-PORT': 'Порт назначения (DST-PORT)',
  'SRC-PORT': 'Порт источника (SRC-PORT)',
  'PROCESS-NAME': 'Имя процесса (PROCESS-NAME)',
  NETWORK: 'Тип сети (NETWORK)',
}

function getTypeOptions(operation: MihomoRuleOperation, behavior?: string): MihomoRuleType[] {
  if (operation === 'inline' && behavior === 'domain') return ['DOMAIN', 'DOMAIN-SUFFIX']
  if (operation === 'inline' && behavior === 'ipcidr') return ['IP-CIDR', 'IP-CIDR6']
  if (operation === 'inline' && behavior !== 'classical') return []
  return [...MIHOMO_RULE_TYPES]
}

function formatPreview(
  operation: MihomoRuleOperation,
  ruleType: MihomoRuleType,
  value: string,
  providerName: string,
  target: string,
  behavior?: string
) {
  if (operation === 'provider-import') return value.trim() || 'https://github.com/…/fastly@ipcidr.mrs'
  let inputs: string[]
  try {
    inputs = normalizeMihomoRuleValues(value || 'google.com', ruleType)
  } catch {
    inputs = value.split(/\r?\n/).filter(Boolean)
  }
  const route = target || 'Main'
  if (operation === 'rule-set') return `RULE-SET,${providerName || 'provider'},${route}`
  return inputs
    .map((input) => {
      if (operation === 'inline') {
        const payload =
          behavior === 'domain' && ruleType === 'DOMAIN-SUFFIX'
            ? `.${input.replace(/^\.+/, '')}`
            : behavior === 'domain'
              ? input.replace(/^\.+/, '')
              : behavior === 'ipcidr'
                ? input
                : `${ruleType},${input}`
        return `payload: ${payload}`
      }
      if (operation === 'payload') return `payload: ${ruleType},${input}`
      return `${ruleType},${input},${route}`
    })
    .join('\n')
}

export function AddMihomoRuleDialog({ open, content, onOpenChange, onInsert, showToast }: Props) {
  const options = useMemo(() => inspectMihomoRuleConfig(content), [content])
  const [operation, setOperation] = useState<MihomoRuleOperation>('rules')
  const [ruleType, setRuleType] = useState<MihomoRuleType>('DOMAIN-SUFFIX')
  const [value, setValue] = useState('')
  const [providerName, setProviderName] = useState('')
  const [target, setTarget] = useState('')
  const valueRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const element = valueRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [value, operation, open])

  const inlineProviders = options.providers.filter((provider) => provider.type === 'inline')
  const selectedProvider = options.providers.find((provider) => provider.name === providerName)
  const typeOptions = getTypeOptions(operation, selectedProvider?.behavior)
  const targetOptions = ['DIRECT', 'REJECT', ...options.groups.filter(name => name !== 'DIRECT' && name !== 'REJECT')]
  const providerOptions = operation === 'inline' ? inlineProviders : options.providers
  const needsTarget = operation === 'rules' || operation === 'rule-set'
  const preview = formatPreview(operation, ruleType, value, providerName, target, selectedProvider?.behavior)

  function resetForm() {
    setOperation('rules')
    setRuleType('DOMAIN-SUFFIX')
    setValue('')
    setProviderName('')
    setTarget('')
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) resetForm()
    onOpenChange(nextOpen)
  }

  useEffect(() => {
    if (typeOptions.length > 0 && !typeOptions.includes(ruleType)) setRuleType(typeOptions[0])
  }, [ruleType, typeOptions])

  function submit() {
    try {
      onInsert(
        addMihomoRule(content, {
          operation,
          ruleType,
          value,
          providerName,
          target,
        })
      )
      handleOpenChange(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось добавить правило'
      showToast(message, 'error')
    }
  }

  const validSelection =
    !options.error &&
    (operation === 'provider-import'
      ? value.trim().length > 0
      : operation === 'rules'
        ? targetOptions.length > 0 && value.trim().length > 0
        : operation === 'inline'
          ? inlineProviders.length > 0 && !!selectedProvider && typeOptions.includes(ruleType) && value.trim().length > 0
          : operation === 'rule-set'
            ? options.providers.length > 0 && !!selectedProvider && targetOptions.length > 0
            : options.hasRootPayload && value.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-full max-w-[95vw]! p-0! sm:max-w-130!">
        <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-5 sm:p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8">
              <IconListDetails size={22} className="text-chart-2" />
              Добавить правило
            </DialogTitle>
            <DialogDescription>Правило будет вставлено в конфигурацию. Затем нажмите «Применить».</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            {options.error ? (
              <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm">
                Не удалось разобрать YAML: {options.error}
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="mihomo-rule-operation">Куда добавить</Label>
                  <Select
                    value={operation}
                    items={Object.fromEntries(
                      Object.entries(OPERATION_LABELS).filter(([key]) => {
                        if (key === 'inline') return inlineProviders.length > 0
                        if (key === 'rule-set') return options.providers.length > 0
                        if (key === 'payload') return options.hasRootPayload
                        return true
                      })
                    )}
                    onValueChange={(next) => {
                      setOperation(next as MihomoRuleOperation)
                      setRuleType('DOMAIN-SUFFIX')
                      if (next === 'inline' && inlineProviders[0]) setProviderName(inlineProviders[0].name)
                      else if (next === 'rule-set' && options.providers[0]) setProviderName(options.providers[0].name)
                    }}
                  >
                    <SelectTrigger id="mihomo-rule-operation" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(OPERATION_LABELS)
                          .filter(([key]) => {
                            if (key === 'inline') return inlineProviders.length > 0
                            if (key === 'rule-set') return options.providers.length > 0
                            if (key === 'payload') return options.hasRootPayload
                            return true
                          })
                          .map(([key, label]) => (
                            <SelectItem key={key} value={key}>
                              {label}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                {operation === 'inline' || operation === 'rule-set' ? (
                  <div className="grid gap-2">
                    <Label htmlFor="mihomo-rule-provider">Rule-provider</Label>
                    <Select
                      value={providerName}
                      items={Object.fromEntries(providerOptions.map((provider) => [provider.name, provider.name]))}
                      onValueChange={(next) => {
                        setProviderName(next)
                        setRuleType('DOMAIN-SUFFIX')
                      }}
                    >
                      <SelectTrigger id="mihomo-rule-provider" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {providerOptions.map((provider) => (
                            <SelectItem key={provider.name} value={provider.name}>
                              {provider.name}
                              {provider.behavior ? ` · ${provider.behavior}` : ''}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {operation === 'inline' && selectedProvider && (
                      <p className="text-muted-foreground text-xs">{formatRuleCount(selectedProvider.payloadCount)}</p>
                    )}
                  </div>
                ) : null}

                {operation === 'provider-import' && (
                  <div className="grid gap-2">
                    <Label htmlFor="provider-import">Ссылки или готовые записи rule-providers</Label>
                    <Textarea
                      id="provider-import"
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      placeholder="https://…/fastly@ipcidr.mrs"
                      className="min-h-32 font-mono text-xs"
                    />
                  </div>
                )}
                {operation !== 'rule-set' && operation !== 'provider-import' && (
                  <>
                    <div className="grid gap-2">
                      <Label htmlFor="mihomo-rule-type">Тип правила</Label>
                      <Select
                        value={ruleType}
                        items={Object.fromEntries(typeOptions.map((type) => [type, TYPE_LABELS[type] ?? type]))}
                        onValueChange={(next) => setRuleType(next as MihomoRuleType)}
                      >
                        <SelectTrigger id="mihomo-rule-type" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {typeOptions.map((type) => (
                              <SelectItem key={type} value={type}>
                                {TYPE_LABELS[type] ?? type}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="mihomo-rule-value">Значение</Label>
                      <Textarea
                        ref={valueRef}
                        rows={1}
                        className="min-h-9! resize-none overflow-y-auto max-md:placeholder:text-sm"
                        id="mihomo-rule-value"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        placeholder={ruleType.startsWith('IP-') ? '192.168.1.0/24' : 'google.com'}
                        autoComplete="off"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            if (validSelection) submit()
                          }
                        }}
                      />
                      <p className="text-muted-foreground text-xs">Один домен на строку</p>
                    </div>
                  </>
                )}

                {needsTarget && (
                  <div className="grid gap-2">
                    <Label htmlFor="mihomo-rule-target">Селектор / маршрут</Label>
                    <Select value={target} items={Object.fromEntries(targetOptions.map((item) => [item, item]))} onValueChange={setTarget}>
                      <SelectTrigger id="mihomo-rule-target" className="w-full">
                        <SelectValue placeholder="Выберите селектор">
                          {target ? <SelectorLabel name={target} icon={options.groupIcons[target]} /> : 'Выберите селектор'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {targetOptions.map((item) => (
                            <SelectItem key={item} value={item}>
                              <SelectorLabel name={item} icon={options.groupIcons[item]} />
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {options.groups.length === 0 && <p className="text-destructive text-xs">В конфигурации не найдены proxy-groups</p>}
                  </div>
                )}

                {operation === 'payload' && (
                  <p className="text-muted-foreground rounded-md border px-3 py-2 text-xs">
                    В payload добавляется условие без маршрута. Маршрут задаётся ссылкой RULE-SET в основном разделе rules.
                  </p>
                )}

                <div className="bg-muted/40 overflow-hidden rounded-lg border p-3">
                  <p className="text-muted-foreground mb-1 text-xs">Предпросмотр</p>
                  <pre className="text-foreground overflow-x-auto text-xs break-all whitespace-pre-wrap">{preview}</pre>
                </div>
              </>
            )}
          </div>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={!validSelection}>
              Добавить правило
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

