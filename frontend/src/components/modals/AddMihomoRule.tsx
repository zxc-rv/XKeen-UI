import { ProviderLabel } from '../configuration/mihomo/ProviderLabel'
import { mihomoRuleColor } from '@/lib/mihomo-rule-color'
import { cn } from '@/lib/utils'
import { NetworkSelect } from '../configuration/mihomo/NetworkSelect'
import { useEffect, useMemo, useState } from 'react'
import { IconListDetails } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  addMihomoRule,
  inspectMihomoRuleConfig,
  normalizeMihomoRuleValues,
  serializeMihomoCondition,
  type MihomoConditionNode,
  type MihomoRuleType,
} from '@/lib/mihomo-rules'
import { SelectorLabel } from '../configuration/mihomo/SelectorLabel'
import { ConditionEditor, CONDITION_TYPES, emptyCondition } from '../configuration/mihomo/ConditionEditor'

interface Props {
  open: boolean
  content: string
  initialOperation?: 'rules' | 'inline' | 'payload'
  initialProviderName?: string
  initialTarget?: string
  initialGroupName?: string
  onOpenChange: (open: boolean) => void
  onInsert: (content: string) => void
  showToast: (message: string, type?: 'success' | 'error') => void
}

export function AddMihomoRuleDialog({
  open,
  content,
  initialOperation,
  initialProviderName,
  initialTarget,
  onOpenChange,
  onInsert,
  showToast,
}: Props) {
  const options = useMemo(() => inspectMihomoRuleConfig(content), [content])
  const [operation, setOperation] = useState<'rules' | 'inline' | 'payload'>('rules')
  const [type, setType] = useState('DOMAIN-SUFFIX')
  const [value, setValue] = useState('')
  const [providerName, setProviderName] = useState('')
  const [target, setTarget] = useState('')
  const [condition, setCondition] = useState<MihomoConditionNode>(emptyCondition('AND'))
  useEffect(() => {
    if (!open) return
    setOperation(initialOperation ?? 'rules')
    setProviderName(initialProviderName ?? '')
    setType('DOMAIN-SUFFIX')
    setValue('')
    setTarget(initialTarget === 'REJECT-DROP' ? '' : (initialTarget ?? ''))
    setCondition(emptyCondition('AND'))
  }, [open, initialOperation, initialProviderName, initialTarget])
  const inlineProviders = options.providers.filter((p) => p.type === 'inline')
  const selectedProvider = options.providers.find((p) => p.name === providerName)
  const behavior = operation === 'inline' ? selectedProvider?.behavior : 'classical'
  const types =
    operation === 'inline' && behavior === 'domain'
      ? ['DOMAIN-SUFFIX', 'DOMAIN']
      : operation === 'inline' && behavior === 'ipcidr'
        ? ['IP-CIDR', 'IP-CIDR6']
        : CONDITION_TYPES.filter((t) => operation === 'rules' || t !== 'RULE-SET')
  const targets = [...new Set(['DIRECT', 'REJECT', ...options.groups])].filter((t) => t !== 'REJECT-DROP')
  const logical = ['AND', 'OR', 'NOT'].includes(type)
  let error = options.error ?? ''
  let preview = ''
  let input = value
  try {
    if (logical) input = serializeMihomoCondition(condition).slice(type.length + 1)
    const values = type === 'RULE-SET' ? [providerName] : normalizeMihomoRuleValues(input, type as MihomoRuleType)
    if (type === 'RULE-SET' && !options.providers.some((p) => p.name === providerName)) throw new Error('Выберите rule-provider')
    if (operation === 'rules' && !target) throw new Error('Выберите маршрут')
    if (operation === 'inline' && (!selectedProvider || selectedProvider.type !== 'inline')) throw new Error('Выберите inline-провайдер')
    preview = values
      .map((item) => {
        if (operation === 'inline' && behavior === 'domain') return type === 'DOMAIN-SUFFIX' ? `.${item.replace(/^\.+/, '')}` : item
        if (operation === 'inline' && behavior === 'ipcidr') return item
        return `${type},${item}${operation === 'rules' ? `,${target}` : ''}`
      })
      .join('\n')
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Заполните правило'
  }
  const destinations = [
    ['rules', 'В rules'],
    ...(inlineProviders.length ? [['inline', 'В payload inline-провайдера']] : []),
    ...(options.hasRootPayload ? [['payload', 'В payload текущего файла']] : []),
  ]
  function changeType(next: string) {
    setType(next)
    if (['AND', 'OR', 'NOT'].includes(next)) setCondition(emptyCondition(next))
  }
  function submit() {
    if (error) return
    try {
      onInsert(
        addMihomoRule(content, {
          operation: operation === 'rules' && type === 'RULE-SET' ? 'rule-set' : operation,
          ruleType: type as MihomoRuleType,
          value: input,
          providerName,
          target,
        })
      )
      onOpenChange(false)
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Не удалось добавить правило', 'error')
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`w-full max-w-[95vw]! p-0! ${logical ? 'sm:max-w-3xl!' : 'sm:max-w-130!'}`}>
        <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-5 sm:p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8">
              <IconListDetails size={22} className="text-chart-2" />
              Конструктор правил
            </DialogTitle>
            <DialogDescription>Изменения добавляются в редактор. Для применения конфигурации нажмите «Применить».</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-2">
              <Label htmlFor="mihomo-rule-operation">Куда добавить</Label>
              <Select
                value={operation}
                items={Object.fromEntries(destinations)}
                onValueChange={(next) => {
                  setOperation(next as typeof operation)
                  changeType('DOMAIN-SUFFIX')
                  if (next === 'inline') {
                    const p = inlineProviders[0]
                    setProviderName(p?.name ?? '')
                    if (p?.behavior === 'ipcidr') changeType('IP-CIDR')
                  }
                }}
              >
                <SelectTrigger id="mihomo-rule-operation" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {destinations.map(([key, label]) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {operation === 'inline' && (
              <div className="grid gap-2">
                <Label htmlFor="mihomo-rule-provider">Rule-provider</Label>
                <Select
                  value={providerName}
                  onValueChange={(name) => {
                    setProviderName(name)
                    changeType(options.providers.find((p) => p.name === name)?.behavior === 'ipcidr' ? 'IP-CIDR' : 'DOMAIN-SUFFIX')
                  }}
                >
                  <SelectTrigger id="mihomo-rule-provider" className="w-full">
                    <SelectValue placeholder="Выберите провайдер">
                      {providerName ? <ProviderLabel name={providerName} /> : 'Выберите провайдер'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {inlineProviders.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          <ProviderLabel name={p.name} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
            {logical ? (
              <ConditionEditor
                node={condition}
                providers={options.providers.map((p) => p.name)}
                onChange={(node) => {
                  setCondition(node)
                  setType(node.type)
                  setValue(node.value ?? '')
                }}
              />
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="mihomo-rule-type">Тип правила</Label>
                  <Select value={type} onValueChange={changeType}>
                    <SelectTrigger id="mihomo-rule-type" className={cn('w-full', mihomoRuleColor(type, '', false))}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {types.map((t) => (
                          <SelectItem key={t} value={t} className={mihomoRuleColor(t, '', false)}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                {type === 'RULE-SET' ? (
                  <div className="grid gap-2">
                    <Label htmlFor="mihomo-rule-provider">Rule-provider</Label>
                    <Select value={providerName} onValueChange={setProviderName}>
                      <SelectTrigger id="mihomo-rule-provider" className="w-full">
                        <SelectValue placeholder="Выберите провайдер">
                          {providerName ? <ProviderLabel name={providerName} /> : 'Выберите провайдер'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {options.providers.map((p) => (
                            <SelectItem key={p.name} value={p.name}>
                              <ProviderLabel name={p.name} />
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="mihomo-rule-value">Значение</Label>
                    {type === 'NETWORK' ? (
                      <NetworkSelect id="mihomo-rule-value" value={value} onValueChange={setValue} />
                    ) : (
                      <>
                        <Textarea
                          id="mihomo-rule-value"
                          rows={1}
                          className="max-h-60 min-h-9! resize-y"
                          value={value}
                          onChange={(event) => setValue(event.target.value)}
                          placeholder={type.startsWith('IP-') ? '192.168.1.0/24' : 'google.com'}
                        />
                        <p className="text-muted-foreground text-xs">Одно значение на строку</p>{' '}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            {operation === 'rules' && (
              <div className="grid gap-2">
                <Label htmlFor="mihomo-rule-target">Селектор / маршрут</Label>
                <Select value={target} items={Object.fromEntries(targets.map((t) => [t, t]))} onValueChange={setTarget}>
                  <SelectTrigger id="mihomo-rule-target" className="w-full">
                    <SelectValue placeholder="Выберите селектор">
                      {target ? <SelectorLabel name={target} icon={options.groupIcons[target]} /> : 'Выберите селектор'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {targets.map((t) => (
                        <SelectItem key={t} value={t}>
                          <SelectorLabel name={t} icon={options.groupIcons[t]} />
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="bg-muted/40 rounded-lg border p-3">
              <p className="text-muted-foreground mb-1 text-xs">Предпросмотр</p>
              <pre className="overflow-x-auto text-xs break-all whitespace-pre-wrap">{preview || error}</pre>
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button disabled={!!error} onClick={submit}>
              Добавить правило
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
