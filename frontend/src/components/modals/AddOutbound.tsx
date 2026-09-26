import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/ui/combobox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/utils'
import { IconCheck, IconCopy, IconLink, IconPlus, IconRefresh, IconReplace, IconX } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import {
  listMihomoProviders,
  listMihomoProxies,
  providerEntryName,
  proxyItemName,
  withProviderName,
  withProxyName,
} from '../../lib/mihomoReplace'
import { useAppContext, useModalContext } from '../../lib/store'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { SelectGroup } from '@/components/ui/select'

const USER_AGENTS = [
  'ClashMeta/1.19.30; mihomo/1.19.30',
  'ClashMetaForAndroid/2.11.33.Meta',
  'Happ/5.6.0/ios/2608171408651',
  'v2rayN/7.24.8',
  'v2rayNG/2.2.6'
]

function randomHwid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => n.toString(16).padStart(2, '0').toUpperCase()).join('')
}

function toYaml(obj: Record<string, any>, indent = 0): string {
  const padding = ' '.repeat(indent)
  return Object.entries(obj).reduce((result, [key, value]) => {
    if (value == null || value === '') return result
    if (Array.isArray(value))
      return value.length
        ? result + `${padding}${key}:\n` + value.map((item) => `${padding}  - ${item}`).join('\n') + '\n'
        : result
    if (typeof value === 'object') return result + `${padding}${key}:\n${toYaml(value, indent + 2)}`
    return result + `${padding}${key}: ${value}\n`
  }, '')
}

function highlightYaml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return `<span style="color:#565f89">${line}</span>`

      const kvMatch = line.match(/^(\s*)(-\s)?([a-zA-Z_][\w.-]*)(\s*:)(.*)?$/)
      if (kvMatch) {
        const [, indent, dash = '', key, colon, rest = ''] = kvMatch
        const marker = dash ? `<span style="color:#89ddff">${dash}</span>` : ''
        return `${indent}${marker}<span style="color:#7aa2f7">${key}</span>${colon}${highlightYamlValue(rest)}`
      }

      const listMatch = line.match(/^(\s*-\s)(.*)$/)
      if (listMatch) {
        const [, marker, rest] = listMatch
        return `<span style="color:#89ddff">${marker}</span>${highlightYamlValue(rest)}`
      }

      return line
    })
    .join('\n')
}

function highlightYamlValue(value: string): string {
  if (!value.trim()) return value
  const trimmed = value.trim()
  const commentIdx = value.search(/\s+#/)
  if (commentIdx !== -1) {
    const main = value.slice(0, commentIdx)
    const comment = value.slice(commentIdx)
    return highlightYamlValue(main) + `<span style="color:#565f89">${comment}</span>`
  }

  if (/^-?\d+\.?\d*$/.test(trimmed)) return value.replace(trimmed, `<span style="color:#ff9e64">${trimmed}</span>`)
  if (/^(true|false|null|~)$/.test(trimmed)) return value.replace(trimmed, `<span style="color:#bb9af7">${trimmed}</span>`)
  if (/^["']/.test(trimmed)) return value.replace(trimmed, `<span style="color:#9ece6a">${trimmed}</span>`)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return highlightInlineYaml(value)
  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('*') && !trimmed.startsWith('&'))
    return value.replace(trimmed, `<span style="color:#9ece6a">${trimmed}</span>`)

  return value
}

function highlightInlineYaml(value: string): string {
  let result = ''
  let i = 0
  while (i < value.length) {
    const char = value[i]
    if (char === '"' || char === "'") {
      const quote = char
      let end = i + 1
      while (end < value.length && value[end] !== quote) end++
      result += `<span style="color:#9ece6a">${value.slice(i, Math.min(end + 1, value.length))}</span>`
      i = end + 1
    } else {
      result += /[[\]{}]/.test(char) ? `<span style="color:#89ddff">${char}</span>` : char
      i++
    }
  }
  return result
}

function highlightJson(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([[\]{}])/g, '<span style="color:#89ddff">$1</span>')
    .replace(/"([^"]+)"(\s*:)/g, '<span style="color:#7aa2f7">"$1"</span>$2')
    .replace(/:\s*"([^"]*)"/g, ': <span style="color:#9ece6a">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#ff9e64">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span style="color:#bb9af7">$1</span>')
}

function highlightCode(code: string): string {
  return code.trimStart().startsWith('{') ? highlightJson(code) : highlightYaml(code)
}

const SUPPORTED_PROTOCOLS = ['ss://', 'vless://', 'vmess://', 'hysteria2://', 'hy2://', 'http://', 'https://', 'trojan://']

interface SubscriptionForm {
  name: string
  url: string
  interval: number
  hcEnable: boolean
  hcUrl: string
  hcInterval: number
  hcExpectedStatus: number
  headerEnable: boolean
  userAgent: string
  hwid: string
  filterEnable: boolean
  filter: string
  excludeFilter: string
  excludeType: string
}

function generateSubYaml(form: SubscriptionForm): string {
  const sub: Record<string, any> = {
    type: 'http',
    url: form.url,
    interval: form.interval,
    override: { udp: true },
  }

  if (form.hcEnable) {
    sub['health-check'] = {
      enable: true,
      url: form.hcUrl,
      interval: form.hcInterval,
      'expected-status': form.hcExpectedStatus,
    }
  }

  if (form.headerEnable) {
    sub.header = {
      'User-Agent': `["${form.userAgent}"]`,
      'x-hwid': `["${form.hwid}"]`,
    }
  }

  if (form.filterEnable) {
    if (form.filter) sub.filter = form.filter
    if (form.excludeFilter) sub['exclude-filter'] = form.excludeFilter
    if (form.excludeType) sub['exclude-type'] = form.excludeType
  }

  return toYaml({ [form.name.trim()]: sub }, 2).trimEnd() + '\n'
}

function createDefaultForm(url: string, existingConfig: string): SubscriptionForm {
  let idx = 1
  while (existingConfig.includes(`subscription_${idx}`)) idx++
  return {
    name: `subscription_${idx}`,
    url,
    interval: 43200,
    hcEnable: true,
    hcUrl: 'https://www.gstatic.com/generate_204',
    hcInterval: 300,
    hcExpectedStatus: 204,
    headerEnable: true,
    userAgent: USER_AGENTS[0],
    hwid: randomHwid(),
    filterEnable: false,
    filter: '',
    excludeFilter: '',
    excludeType: '',
  }
}

interface ReplacePanelProps {
  label: string
  items: string[]
  value: string | null
  onValueChange: (v: string | null) => void
  placeholder: string
  emptyHint: string
  renameRefs: boolean
  onRenameRefsChange: (v: boolean) => void
  description: string | null
  extraHint: string | null
  confirmDisabled: boolean
  onConfirm: () => void
}

function ReplacePanel({
  label,
  items,
  value,
  onValueChange,
  placeholder,
  emptyHint,
  renameRefs,
  onRenameRefsChange,
  description,
  extraHint,
  confirmDisabled,
  onConfirm,
}: ReplacePanelProps) {
  return (
    <div className="border-border bg-muted/10 flex w-full shrink-0 flex-col gap-3 border-t p-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">{label}</Label>
        <Combobox
          items={items}
          value={value}
          itemToStringLabel={(item) => item}
          itemToStringValue={(item) => item}
          onValueChange={onValueChange}
          autoHighlight
        >
          <ComboboxInput fullWidth placeholder={placeholder} disabled={items.length === 0} />
          <ComboboxContent>
            <ComboboxEmpty>Ничего не найдено</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {items.length === 0 && <p className="text-muted-foreground text-xs">{emptyHint}</p>}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <Label className="text-xs">Переименовать ссылки во всём конфиге</Label>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
          {extraHint && <p className="text-destructive text-xs">{extraHint}</p>}
        </div>
        <Switch size="sm" checked={renameRefs} onCheckedChange={onRenameRefsChange} />
      </div>

      <Button size="sm" className="w-full" disabled={confirmDisabled} onClick={onConfirm}>
        Заменить
      </Button>
    </div>
  )
}

interface Props {
  onGenerate: (uri: string, excludeName?: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, type: string, position: 'start' | 'end') => void
  onReplace: (kind: 'proxy' | 'provider', content: string, oldName: string, renameRefs: boolean) => void
}

export function ImportModal({ onGenerate, onAddToConfig, onReplace }: Props) {
  const { showToast, state } = useAppContext({ includeConfigs: true })
  const { modals, dispatch } = useModalContext()
  const [uri, setUri] = useState('')
  const [result, setResult] = useState<{ content: string; type: string; protocol: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [subForm, setSubForm] = useState<SubscriptionForm | null>(null)
  const [subTab, setSubTab] = useState('form')
  const [isCustomUA, setIsCustomUA] = useState(false)
  const [customUA, setCustomUA] = useState('')
  const [generated, setGenerated] = useState(false)
  const [resultUri, setResultUri] = useState<string | null>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null)
  const [renameRefs, setRenameRefs] = useState(true)
  const [subDefaultName, setSubDefaultName] = useState<string | null>(null)
  const [providerNameAutoSet, setProviderNameAutoSet] = useState(false)

  const isValidUri = SUPPORTED_PROTOCOLS.some((p) => {
    if (state.currentCore !== 'mihomo' && (p === 'http://' || p === 'https://')) return false
    return uri.toLowerCase().startsWith(p)
  })

  function close() {
    dispatch({ type: 'SHOW_MODAL', modal: 'showImportModal', show: false })
    setTimeout(() => {
      setUri('')
      setResult(null)
      setResultUri(null)
      setSubForm(null)
      setSubDefaultName(null)
      setIsCustomUA(false)
      setCustomUA('')
      setGenerated(false)
      setReplaceOpen(false)
      setReplaceTarget(null)
      setRenameRefs(true)
      setProviderNameAutoSet(false)
    }, 300)
  }

  function generate() {
    if (!uri.trim()) return
    const trimmed = uri.trim()
    setReplaceOpen(false)
    setReplaceTarget(null)
    setRenameRefs(true)
    setProviderNameAutoSet(false)

    if (/^https?:\/\//i.test(trimmed)) {
      const existingContent = state.configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')?.content ?? ''
      const form = createDefaultForm(trimmed, existingContent)
      setSubForm(form)
      setSubDefaultName(form.name)
      setResult({ content: '', type: 'proxy-provider', protocol: 'HTTP' })
      setResultUri(null)
      setSubTab('form')
      setGenerated(true)
      return
    }

    try {
      const generated = onGenerate(trimmed)
      if (generated) {
        const protocol = trimmed.match(/^([a-zA-Z0-9+\-.]+):\/\//)?.[1]?.toUpperCase() ?? ''
        setResult({ ...generated, protocol })
        setResultUri(trimmed)
        setSubForm(null)
        setSubDefaultName(null)
      } else {
        setResult(null)
        setResultUri(null)
        setSubForm(null)
        setSubDefaultName(null)
      }
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  function regenerateResult(excludeName?: string) {
    if (!resultUri) return
    try {
      const next = onGenerate(resultUri, excludeName)
      if (next) setResult((prev) => ({ ...next, protocol: prev?.protocol ?? '' }))
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  function toggleReplace() {
    const next = !replaceOpen
    setReplaceOpen(next)
    if (next) return
    if (replaceTarget) {
      setReplaceTarget(null)
      if (isMihomoProxyFlow) regenerateResult()
    }
    if (isMihomoProviderFlow && providerNameAutoSet && subDefaultName) {
      updateSubField('name', subDefaultName)
      setProviderNameAutoSet(false)
    }
  }

  function selectReplaceTarget(target: string | null) {
    setReplaceTarget(target)
    if (isMihomoProxyFlow) {
      regenerateResult(target ?? undefined)
      return
    }
    if (isMihomoProviderFlow && subForm && target && (providerNameAutoSet || subForm.name === subDefaultName)) {
      updateSubField('name', target)
      setProviderNameAutoSet(true)
    }
  }

  function confirmReplace() {
    if (isMihomoProxyFlow) {
      if (!result || !replaceTarget || (renameRefs && !newProxyName)) return
      onReplace('proxy', previewContent, replaceTarget, renameRefs)
      close()
      return
    }
    if (isMihomoProviderFlow) {
      if (!subForm || !replaceTarget || providerReplaceDisabled) return
      onReplace('provider', finalProviderContent, replaceTarget, renameRefs)
      close()
    }
  }

  function updateSubField<K extends keyof SubscriptionForm>(key: K, value: SubscriptionForm[K]) {
    setSubForm((prev) => (prev ? { ...prev, [key]: value } : null))
  }

  function regenerateHwid() {
    updateSubField('hwid', randomHwid())
  }

  function addSubToConfig(position: 'start' | 'end') {
    if (!subForm) return
    const content = generateSubYaml(subForm)
    onAddToConfig(content, 'proxy-provider', position)
    close()
  }

  async function copySub() {
    if (!subForm) return
    const ok = await copyText(finalProviderContent)
    if (!ok) {
      showToast('Ошибка копирования', 'error')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function copy() {
    if (!result) return
    const ok = await copyText(result.content)
    if (!ok) {
      showToast('Ошибка копирования', 'error')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function addToConfig(position: 'start' | 'end') {
    if (!result) return
    onAddToConfig(result.content, result.type, position)
    close()
  }

  const showSubForm = generated && subForm && result
  const isMihomoProxyFlow = state.currentCore === 'mihomo' && result?.type === 'proxy'
  const isMihomoProviderFlow = state.currentCore === 'mihomo' && Boolean(showSubForm)
  const configYamlContent = state.configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')?.content ?? ''
  const mihomoProxies = useMemo(
    () => (isMihomoProxyFlow ? listMihomoProxies(configYamlContent) : []),
    [isMihomoProxyFlow, configYamlContent]
  )
  const providerNames = useMemo(
    () => (isMihomoProviderFlow ? listMihomoProviders(configYamlContent) : []),
    [isMihomoProviderFlow, configYamlContent]
  )
  const newProxyName = result ? proxyItemName(result.content) : null
  const previewContent =
    result && replaceTarget ? (renameRefs ? result.content : withProxyName(result.content, replaceTarget)) : (result?.content ?? '')

  const providerEntry = isMihomoProviderFlow && subForm ? generateSubYaml(subForm) : ''
  const newProviderName = providerEntry ? providerEntryName(providerEntry) : null
  const finalProviderContent =
    providerEntry && replaceTarget ? (renameRefs ? providerEntry : withProviderName(providerEntry, replaceTarget)) : providerEntry
  const trimmedSubName = subForm?.name.trim() ?? ''
  const providerNameConflict = Boolean(
    isMihomoProviderFlow &&
    renameRefs &&
    replaceTarget !== null &&
    subForm !== null &&
    trimmedSubName !== replaceTarget &&
    providerNames.includes(trimmedSubName)
  )
  const providerReplaceDisabled = !replaceTarget || newProviderName === null || providerNameConflict || !trimmedSubName

  return (
    <TooltipProvider delayDuration={500}>
      <Dialog open={modals.showImportModal} onOpenChange={(open) => !open && close()}>
        <DialogContent className="flex max-h-[90dvh] w-auto! max-w-[min(90vw,900px)]! min-w-[min(90vw,480px)]! flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pb-1">
            <DialogTitle className="flex items-center gap-2 pb-2">
              <IconLink size={24} className="text-chart-2" /> Добавить подключение
            </DialogTitle>
            <DialogDescription>
              Вставьте ссылку в формате protocol://{state.currentCore === 'mihomo' && ' или https://'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            {showSubForm && (
              <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
                <Tabs value={subTab} onValueChange={setSubTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="border-border bg-muted/30 flex w-full shrink-0 items-center justify-between border-b px-3 py-1">
                    <TabsList variant="line" className="h-8">
                      <TabsTrigger value="form" className="text-sm">Настройки</TabsTrigger>
                      <TabsTrigger value="raw" className="text-sm">YAML</TabsTrigger>
                    </TabsList>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" onClick={generated ? copySub : copy}>
                            {copied ? <IconCheck className="text-green-500" /> : <IconCopy className="size-4.5" />}
                          </Button>
                        }
                      />
                      <TooltipContent side="left">Скопировать</TooltipContent>
                    </Tooltip>
                  </div>

                  <TabsContent value="form" className="min-h-0 flex-1 overflow-auto p-4">
                    <div className="flex flex-col gap-4">
                      <fieldset className="border-border rounded-lg border px-4 pb-4 pt-1.5">
                        <legend className="text-sm font-medium px-1">Основное</legend>
                        <div className="flex flex-col gap-3 pt-1">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="grid gap-1.5">
                              <Label className="text-xs">Название провайдера</Label>
                              <Input
                                value={subForm.name}
                                onChange={(e) => {
                                  updateSubField('name', e.target.value)
                                  setProviderNameAutoSet(false)
                                }}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="grid gap-1.5">
                              <Label className="text-xs">Интервал автообновления</Label>
                              <InputGroup className="h-8">
                                <InputGroupInput
                                  type="number"
                                  min={60}
                                  inputMode="numeric"
                                  className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none text-xs"
                                  value={subForm.interval}
                                  onChange={(e) => updateSubField('interval', +e.target.value)}
                                />
                                <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
                                  сек
                                </InputGroupAddon>
                              </InputGroup>
                            </div>
                          </div>

                          <div className="grid gap-1.5">
                            <Label className="text-xs">URL</Label>
                            <Input
                              value={subForm.url}
                              onChange={(e) => updateSubField('url', e.target.value)}
                              className="h-8 text-xs"
                            />
                          </div>

                        </div>
                      </fieldset>

                      <fieldset className="border-border rounded-lg border px-4 pb-4 pt-1.5">
                        <legend className="text-sm font-medium px-1 flex items-center gap-2">
                          Проверка работоспособности
                          <Switch
                            size="sm"
                            checked={subForm.hcEnable}
                            onCheckedChange={(v) => updateSubField('hcEnable', v)}
                          />
                        </legend>
                        {subForm.hcEnable && (
                          <div className="grid grid-cols-3 gap-2 pt-1">
                            <div className="col-span-3 grid gap-1.5">
                              <Label className="text-xs">URL проверки</Label>
                              <Input
                                value={subForm.hcUrl}
                                onChange={(e) => updateSubField('hcUrl', e.target.value)}
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="grid gap-1.5">
                              <Label className="text-xs">Интервал проверок</Label>
                              <InputGroup className="h-8">
                                <InputGroupInput
                                  type="number"
                                  min={30}
                                  inputMode="numeric"
                                  className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none text-xs"
                                  value={subForm.hcInterval}
                                  onChange={(e) => updateSubField('hcInterval', +e.target.value)}
                                />
                                <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
                                  сек
                                </InputGroupAddon>
                              </InputGroup>
                            </div>
                            <div className="col-span-2 grid gap-1.5">
                              <Label className="text-xs">Ожидаемый код HTTP-ответа</Label>
                              <Input
                                type="number"
                                min={100}
                                max={599}
                                inputMode="numeric"
                                className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none h-8 text-xs"
                                value={subForm.hcExpectedStatus}
                                onChange={(e) => updateSubField('hcExpectedStatus', +e.target.value)}
                              />
                            </div>
                          </div>
                        )}
                      </fieldset>

                      <fieldset className="border-border rounded-lg border px-4 pb-4 pt-1.5">
                        <legend className="text-sm font-medium px-1 flex items-center gap-2">
                          Заголовки
                          <Switch
                            size="sm"
                            checked={subForm.headerEnable}
                            onCheckedChange={(v) => updateSubField('headerEnable', v)}
                          />
                        </legend>
                        {subForm.headerEnable && (
                          <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                            <div className="grid gap-1.5">
                              <Label className="text-xs">User-Agent</Label>
                              <Select value={isCustomUA ? '__custom__' : subForm.userAgent} onValueChange={(v) => {
                                if (v === '__custom__') {
                                  setIsCustomUA(true)
                                  updateSubField('userAgent', customUA || '')
                                } else {
                                  setIsCustomUA(false)
                                  updateSubField('userAgent', v)
                                }
                              }}>
                                <SelectTrigger size="sm" className="h-8 w-full text-xs">
                                  {isCustomUA ? <span className="text-xs text-muted-foreground">Свой...</span> : <SelectValue />}
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {USER_AGENTS.map((ua) => (
                                      <SelectItem key={ua} value={ua}>
                                        <span className="text-xs">{ua}</span>
                                      </SelectItem>
                                    ))}
                                    <SelectItem value="__custom__">
                                      <span className="text-xs text-muted-foreground">Свой...</span>
                                    </SelectItem>
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              {isCustomUA && (
                                <Input
                                  value={customUA}
                                  onChange={(e) => {
                                    setCustomUA(e.target.value)
                                    updateSubField('userAgent', e.target.value)
                                  }}
                                  placeholder="Введите User-Agent"
                                  className="h-8 text-xs"
                                />
                              )}
                            </div>
                            <div className="grid gap-1.5">
                              <div className="flex items-center gap-1">
                                <Label className="text-xs">x-hwid</Label>
                                <Button variant="ghost" size="icon-xs" onClick={regenerateHwid} className="size-4">
                                  <IconRefresh className="size-3" />
                                </Button>
                              </div>
                              <Input
                                value={subForm.hwid}
                                onChange={(e) => updateSubField('hwid', e.target.value)}
                                className="h-8 font-mono text-xs"
                              />
                              {isCustomUA && <div className="h-8" />}
                            </div>
                          </div>
                        )}
                      </fieldset>

                      <fieldset className="border-border rounded-lg border px-4 pb-4 pt-1.5">
                        <legend className="text-sm font-medium px-1 flex items-center gap-2">
                          Фильтр подключений
                          <Switch
                            size="sm"
                            checked={subForm.filterEnable}
                            onCheckedChange={(v) => updateSubField('filterEnable', v)}
                          />
                        </legend>
                        {subForm.filterEnable && (
                          <div className="grid gap-2 pt-1">
                            <div className="grid gap-1.5">
                              <Label className="text-xs">По названию (включить)</Label>
                              <InputGroup className="h-8">
                                <InputGroupInput
                                  value={subForm.filter}
                                  onChange={(e) => updateSubField('filter', e.target.value)}
                                  placeholder='my-good-proxy'
                                  className="text-xs"
                                />
                                <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
                                  REGEX
                                </InputGroupAddon>
                              </InputGroup>
                            </div>
                            <div className="grid gap-1.5">
                              <Label className="text-xs">По названию (исключить)</Label>
                              <InputGroup className="h-8">
                                <InputGroupInput
                                  value={subForm.excludeFilter}
                                  onChange={(e) => updateSubField('excludeFilter', e.target.value)}
                                  placeholder="my-bad-proxy"
                                  className="text-xs"
                                />
                                <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
                                  REGEX
                                </InputGroupAddon>
                              </InputGroup>
                            </div>
                            <div className="grid gap-1.5">
                              <Label className="text-xs">По типу (исключить)</Label>
                              <Input
                                value={subForm.excludeType}
                                onChange={(e) => updateSubField('excludeType', e.target.value)}
                                placeholder="trojan|vmess"
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                        )}
                      </fieldset>
                    </div>
                  </TabsContent>

                  <TabsContent value="raw" className="bg-input-background min-h-0 flex-1 overflow-auto">
                    <pre
                      className="m-0 p-3 font-mono text-[13px] tracking-tight"
                      dangerouslySetInnerHTML={{
                        __html: highlightCode(subForm ? finalProviderContent : ''),
                      }}
                    />
                  </TabsContent>
                </Tabs>

                <div className="border-border bg-muted/10 flex w-full shrink-0 gap-2 border-t p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={replaceOpen}
                    className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs max-sm:[&_svg]:hidden sm:px-2.5"
                    onClick={() => addSubToConfig('start')}
                  >
                    <IconPlus /> <span className="truncate">В начало</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={replaceOpen}
                    className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs max-sm:[&_svg]:hidden sm:px-2.5"
                    onClick={() => addSubToConfig('end')}
                  >
                    <IconPlus /> <span className="truncate">В конец</span>
                  </Button>
                  {isMihomoProviderFlow && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs max-sm:[&_svg]:hidden sm:px-2.5"
                      onClick={toggleReplace}
                    >
                      <IconReplace /> <span className="truncate">Заменить</span>
                    </Button>
                  )}
                </div>

                {isMihomoProviderFlow && replaceOpen && (
                  <ReplacePanel
                    label="Провайдер для замены"
                    items={providerNames}
                    value={replaceTarget}
                    onValueChange={selectReplaceTarget}
                    placeholder="Выберите провайдера"
                    emptyHint="Массив proxy-providers в конфиге не найден"
                    renameRefs={renameRefs}
                    onRenameRefsChange={setRenameRefs}
                    description={
                      replaceTarget
                        ? renameRefs
                          ? newProviderName
                            ? `Ссылки на «${replaceTarget}» в proxy-groups (use) станут «${newProviderName}»`
                            : null
                          : `Новый провайдер получит имя «${replaceTarget}», ссылки не изменятся`
                        : null
                    }
                    extraHint={
                      replaceTarget
                        ? newProviderName === null
                          ? 'Не удалось определить имя провайдера'
                          : providerNameConflict
                            ? `Имя «${trimmedSubName}» уже используется`
                            : null
                        : null
                    }
                    confirmDisabled={providerReplaceDisabled}
                    onConfirm={confirmReplace}
                  />
                )}
              </div>
            )}

            {result && !generated && (
              <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
                <div className="border-border bg-muted/30 flex w-full shrink-0 items-center justify-between border-b px-3 py-1">
                  <Badge className="bg-blue-500/10! px-2 pt-2.25 pb-2.5 text-[10px] tracking-wider text-blue-400">{result.protocol}</Badge>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" onClick={copy}>
                          {copied ? <IconCheck className="text-green-500" /> : <IconCopy className="size-4.5" />}
                        </Button>
                      }
                    />
                    <TooltipContent side="left">Скопировать</TooltipContent>
                  </Tooltip>
                </div>

                <div className="bg-input-background min-h-0 flex-1 overflow-auto">
                  <pre
                    className="m-0 p-3 font-mono text-[13px] tracking-tight"
                    dangerouslySetInnerHTML={{
                      __html: highlightCode(previewContent),
                    }}
                  />
                </div>

                <div className="border-border bg-muted/10 flex w-full shrink-0 gap-2 border-t p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={replaceOpen}
                    className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs max-sm:[&_svg]:hidden sm:px-2.5"
                    onClick={() => addToConfig('start')}
                  >
                    <IconPlus /> <span className="truncate">В начало</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={replaceOpen}
                    className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs max-sm:[&_svg]:hidden sm:px-2.5"
                    onClick={() => addToConfig('end')}
                  >
                    <IconPlus /> <span className="truncate">В конец</span>
                  </Button>
                  {isMihomoProxyFlow && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-w-0 flex-1 shrink gap-1.5 px-1.5 text-xs max-sm:[&_svg]:hidden sm:px-2.5"
                      onClick={toggleReplace}
                    >
                      <IconReplace /> <span className="truncate">Заменить</span>
                    </Button>
                  )}
                </div>

                {isMihomoProxyFlow && replaceOpen && (
                  <ReplacePanel
                    label="Прокси для замены"
                    items={mihomoProxies}
                    value={replaceTarget}
                    onValueChange={selectReplaceTarget}
                    placeholder="Выберите прокси"
                    emptyHint="Массив proxies в конфиге не найден"
                    renameRefs={renameRefs}
                    onRenameRefsChange={setRenameRefs}
                    description={
                      replaceTarget
                        ? renameRefs
                          ? newProxyName
                            ? `Ссылки на «${replaceTarget}» в группах, правилах, dialer-proxy и DNS станут «${newProxyName}»`
                            : 'Не удалось определить имя нового прокси'
                          : `Новый прокси получит имя «${replaceTarget}», ссылки не изменятся`
                        : null
                    }
                    extraHint={null}
                    confirmDisabled={!replaceTarget || (renameRefs && !newProxyName)}
                    onConfirm={confirmReplace}
                  />
                )}
              </div>
            )}

            <div className="mt-auto flex shrink-0 flex-col gap-3 pt-1">
              <InputGroup>
                <InputGroupInput
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && isValidUri && generate()}
                  placeholder="vless://..."
                  className={uri ? 'pr-7' : ''}
                />
                <InputGroupAddon align="inline-end">
                  {uri && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        setUri('')
                        setResult(null)
                        setResultUri(null)
                        setSubForm(null)
                        setSubDefaultName(null)
                        setReplaceOpen(false)
                        setReplaceTarget(null)
                        setRenameRefs(true)
                        setProviderNameAutoSet(false)
                      }}
                      className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                    >
                      <IconX size={13} />
                    </Button>
                  )}
                </InputGroupAddon>
              </InputGroup>

              <Button onClick={generate} disabled={!isValidUri} className="w-full">
                Сгенерировать
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
