import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconCheck, IconGripVertical, IconPencil, IconPlus, IconX } from '@tabler/icons-react'
import { forwardRef, memo, useCallback, useEffect, useRef, useState } from 'react'
import { apiCall } from '../../../lib/api'
import { useAppActions, useCoreRuntimeState, useSettings } from '../../../lib/store'
import type { Config } from '../../../lib/types'
import { cn, stripJsonComments } from '../../../lib/utils'
import type { CodeMirrorRef } from '../CodeMirror'

const RULE_FIELDS = {
  domain: {
    type: 'array' as const,
    placeholder: 'youtube.com, geosite:youtube',
  },
  ip: { type: 'array' as const, placeholder: '1.1.1.1/32, geoip:cloudflare' },
  port: { type: 'string' as const, placeholder: '80, 443, 1000-2000' },
  sourceIP: { type: 'array' as const, placeholder: '192.168.1.2' },
  sourcePort: { type: 'string' as const, placeholder: '80, 443' },
  network: {
    type: 'buttons' as const,
    options: ['tcp', 'udp'],
    isString: true,
  },
  inboundTag: { type: 'buttons' as const },
  protocol: {
    type: 'buttons' as const,
    options: ['http', 'tls', 'quic', 'bittorrent'],
  },
}

type FieldName = keyof typeof RULE_FIELDS
type Rule = Record<string, any>

function parseRules(content: string): Rule[] {
  try {
    const json = JSON.parse(stripJsonComments(content))
    if (json?.routing?.rules && Array.isArray(json.routing.rules)) return JSON.parse(JSON.stringify(json.routing.rules))
  } catch {
    /* */
  }
  return []
}

function getBadges(value: any): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.trim())
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (typeof value === 'number') return [String(value)]
  return []
}

function validatePort(v: string): boolean {
  if (/^\d+$/.test(v)) {
    const n = parseInt(v)
    return n >= 1 && n <= 65535
  }
  if (/^\d+-\d+$/.test(v)) {
    const [a, b] = v.split('-').map(Number)
    return a >= 1 && b <= 65535 && a < b
  }
  return false
}

interface AvailableTags {
  outbounds: string[]
  inbounds: string[]
  balancers: string[]
}

interface Props {
  editorRef: React.RefObject<CodeMirrorRef | null>
  configs: Config[]
  activeConfigIndex: number
}

export function GuiRouting({ editorRef, configs, activeConfigIndex }: Props) {
  const { showToast, dispatch } = useAppActions()
  const { serviceStatus, currentCore } = useCoreRuntimeState()
  const autoApply = useSettings((s) => s.autoApply)
  const [rules, setRules] = useState<Rule[]>([])
  const [available, setAvailable] = useState<AvailableTags>({
    outbounds: [],
    inbounds: [],
    balancers: [],
  })
  const configsRef = useRef(configs)
  const activeConfigIndexRef = useRef(activeConfigIndex)
  const autoApplyRef = useRef(autoApply)
  const serviceStatusRef = useRef(serviceStatus)
  const currentCoreRef = useRef(currentCore)
  const rulesRef = useRef<Rule[]>([])
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const cardRefHandlersRef = useRef<Record<number, (el: HTMLDivElement | null) => void>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)

  const getCardRef = useCallback((index: number) => {
    if (!cardRefHandlersRef.current[index]) {
      cardRefHandlersRef.current[index] = (el: HTMLDivElement | null) => {
        cardRefs.current[index] = el
      }
    }
    return cardRefHandlersRef.current[index]
  }, [])

  function loadAvailable() {
    let outbounds: string[] = [],
      inbounds: string[] = [],
      balancers: string[] = []
    try {
      const c = configs.find((x) => x.file.toLowerCase().includes('outbound'))
      if (c) {
        const j = JSON.parse(stripJsonComments(c.content))
        outbounds = j.outbounds?.filter((o: any) => o.tag).map((o: any) => o.tag) ?? []
      }
    } catch {
      /* */
    }
    try {
      const c = configs.find((x) => x.file.toLowerCase().includes('inbound'))
      if (c) {
        const j = JSON.parse(stripJsonComments(c.content))
        inbounds = j.inbounds?.filter((i: any) => i.tag).map((i: any) => i.tag) ?? []
      }
    } catch {
      /* */
    }
    try {
      const content = configs[activeConfigIndex]?.content ?? editorRef.current?.getValue() ?? ''
      const j = JSON.parse(stripJsonComments(content))
      balancers = j.routing?.balancers?.filter((b: any) => b.tag).map((b: any) => b.tag) ?? []
    } catch {
      /* */
    }
    setAvailable({
      outbounds: [...new Set(outbounds)],
      inbounds: [...new Set(inbounds)],
      balancers: [...new Set(balancers)],
    })
  }

  useEffect(() => {
    const content = configs[activeConfigIndex]?.content ?? editorRef.current?.getValue() ?? ''
    const parsed = parseRules(content)
    rulesRef.current = parsed
    setRules(parsed)
    loadAvailable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfigIndex])

  useEffect(() => {
    configsRef.current = configs
    activeConfigIndexRef.current = activeConfigIndex
  }, [configs, activeConfigIndex])

  useEffect(() => {
    autoApplyRef.current = autoApply
  }, [autoApply])

  useEffect(() => {
    serviceStatusRef.current = serviceStatus
    currentCoreRef.current = currentCore
  }, [serviceStatus, currentCore])

  const syncToEditor = useCallback(
    async (newRules: Rule[], triggerSoftRestart = false) => {
      const wrapper = editorRef.current
      if (!wrapper) return
      try {
        const json = JSON.parse(stripJsonComments(wrapper.getValue()))
        json.routing.rules = newRules
        const text = JSON.stringify(json, null, 2)
        wrapper.replaceAll(text)

        if (triggerSoftRestart && autoApplyRef.current && serviceStatusRef.current === 'running') {
          const activeIndex = activeConfigIndexRef.current
          const activeConfig = configsRef.current[activeIndex]
          if (activeConfig) {
            const content = wrapper.getValue()
            await apiCall<any>('PUT', 'configs', {
              file: activeConfig.file,
              content,
            })
            dispatch({
              type: 'SAVE_CONFIG',
              index: activeIndex,
              content,
            })
            dispatch({
              type: 'SET_SERVICE_STATUS',
              status: 'pending',
              pendingText: 'Перезапуск...',
            })
            const r = await apiCall<any>('POST', 'control', {
              action: 'softRestart',
              core: currentCoreRef.current,
            })
            showToast(r?.success ? 'Изменения применены' : `Ошибка: ${r?.error}`, r?.success ? 'success' : 'error')
            dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
          }
        }
      } catch (e: any) {
        showToast(`Ошибка синхронизации: ${e.message}`, 'error')
      }
    },
    [editorRef, showToast, dispatch]
  )

  const applyRules = useCallback(
    (newRules: Rule[], triggerSoftRestart = false) => {
      rulesRef.current = newRules
      setRules(newRules)
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
      syncTimerRef.current = setTimeout(() => syncToEditor(newRules, triggerSoftRestart), 100)
    },
    [syncToEditor]
  )

  const startDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent, fromIndex: number) => {
      if (e.cancelable) e.preventDefault()
      let current = fromIndex
      setDraggingIndex(fromIndex)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const clientY = 'touches' in ev ? ev.touches[0].clientY : ev.clientY
        for (let i = 0; i < cardRefs.current.length; i++) {
          if (i === current) continue
          const rect = cardRefs.current[i]?.getBoundingClientRect()
          if (!rect || clientY < rect.top || clientY > rect.bottom) continue
          const newRules = [...rulesRef.current]
          const [moved] = newRules.splice(current, 1)
          newRules.splice(i, 0, moved)
          current = i
          rulesRef.current = newRules
          setRules(newRules)
          setDraggingIndex(i)
          break
        }
      }
      const onUp = () => {
        syncToEditor(rulesRef.current)
        setDraggingIndex(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('touchmove', onMove, { passive: true })
      document.addEventListener('touchend', onUp, { passive: true })
    },
    [syncToEditor]
  )

  const handleUpdateRule = useCallback(
    (index: number, updated: Rule, triggerSoftRestart = false) => {
      if (rulesRef.current[index] === updated) return
      const next = [...rulesRef.current]
      next[index] = updated
      applyRules(next, triggerSoftRestart)
    },
    [applyRules]
  )

  const handleDeleteRule = useCallback(
    (index: number) => {
      applyRules(rulesRef.current.filter((_, i) => i !== index))
    },
    [applyRules]
  )

  const handleDragStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent, index: number) => {
      startDrag(e, index)
    },
    [startDrag]
  )

  return (
    <div ref={scrollRef} className="absolute inset-4 flex flex-col gap-2 overflow-y-auto [scrollbar-width:thin]">
      <div className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          <RuleCard
            key={index}
            ref={getCardRef(index)}
            rule={rule}
            index={index}
            isDragging={draggingIndex === index}
            available={available}
            onUpdate={handleUpdateRule}
            onDelete={handleDeleteRule}
            onDragStart={handleDragStart}
            showToast={showToast}
          />
        ))}
      </div>
      <button
        onClick={() => {
          applyRules([...rulesRef.current, { domain: [], outboundTag: available.outbounds[0] ?? 'direct' }])
          setTimeout(
            () =>
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: 'smooth',
              }),
            50
          )
        }}
        className="text-muted-foreground border-ring/60 hover:border-chart-2 mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-3 py-2.5 text-sm font-medium transition-colors hover:border-solid hover:text-[#60a5fa]"
      >
        <IconPlus size={17} /> Добавить правило
      </button>
    </div>
  )
}

interface RuleCardProps {
  rule: Rule
  index: number
  isDragging: boolean
  available: AvailableTags
  onUpdate: (index: number, r: Rule, triggerSoftRestart?: boolean) => void
  onDelete: (index: number) => void
  onDragStart: (e: React.MouseEvent | React.TouchEvent, index: number) => void
  showToast: (msg: string, type?: 'success' | 'error') => void
}

const RuleCard = memo(
  forwardRef<HTMLDivElement, RuleCardProps>(function RuleCard(
    { rule, index, isDragging, available, onUpdate, onDelete, onDragStart, showToast },
    ref
  ) {
    const [editingName, setEditingName] = useState(false)
    const [nameValue, setNameValue] = useState(rule.ruleTag ?? '')

    const isBalancer = 'balancerTag' in rule
    const outboundType = isBalancer ? 'balancerTag' : 'outboundTag'
    const outboundValue = rule[outboundType] ?? ''
    const conditionFields = Object.keys(rule).filter((k) => k in RULE_FIELDS)
    const availableToAdd = (Object.keys(RULE_FIELDS) as FieldName[]).filter((f) => !(f in rule))

    function saveName() {
      const trimmed = nameValue.trim()
      const updated = { ...rule }
      if (trimmed) updated.ruleTag = trimmed
      else delete updated.ruleTag
      setEditingName(false)
      onUpdate(index, updated)
    }

    function addField(f: FieldName) {
      const cfg = RULE_FIELDS[f]
      onUpdate(index, {
        ...rule,
        [f]: cfg.type === 'array' || cfg.type === 'buttons' ? [] : '',
      })
    }

    function removeField(f: string) {
      const u = { ...rule }
      delete u[f]
      onUpdate(index, u)
    }

    function changeField(old: string, next: FieldName) {
      const u = { ...rule }
      delete u[old]
      const cfg = RULE_FIELDS[next]
      u[next] = cfg.type === 'array' || cfg.type === 'buttons' ? [] : ''
      onUpdate(index, u)
    }

    function updateField(f: string, v: any) {
      onUpdate(index, { ...rule, [f]: v })
    }

    function addBadge(f: string, v: string) {
      if (['port', 'sourcePort'].includes(f) && !validatePort(v)) {
        showToast('Некорректный порт. Допустимы числа или диапазоны 1-65535', 'error')
        return
      }
      const cur = getBadges(rule[f])
      if (cur.includes(v)) return
      const next = [...cur, v]
      const cfg = RULE_FIELDS[f as FieldName]
      updateField(f, cfg?.type === 'array' ? next : next.join(','))
    }

    function editBadge(f: string, oldV: string, newV: string) {
      if (!newV) return removeBadge(f, oldV)
      if (oldV === newV) return
      if (['port', 'sourcePort'].includes(f) && !validatePort(newV)) {
        showToast('Некорректный порт. Допустимы числа или диапазоны 1-65535', 'error')
        return
      }
      const cur = getBadges(rule[f])
      const next = cur.map((x) => (x === oldV ? newV : x))
      const cfg = RULE_FIELDS[f as FieldName]
      updateField(f, cfg?.type === 'array' ? next : next.join(','))
    }

    function removeBadge(f: string, v: string) {
      const next = getBadges(rule[f]).filter((x) => x !== v)
      const cfg = RULE_FIELDS[f as FieldName]
      updateField(f, cfg?.type === 'array' ? next : next.join(','))
    }

    function toggleBtn(f: string, v: string) {
      const cfg = RULE_FIELDS[f as FieldName]
      const cur = getBadges(rule[f])
      let next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
      const optionsOrder = (cfg as any)?.options as string[] | undefined
      if (optionsOrder) next = optionsOrder.filter((o) => next.includes(o))
      updateField(f, (cfg as any)?.isString ? next.join(',') : next)
    }

    function switchOutbound(newType: 'outboundTag' | 'balancerTag') {
      const u = { ...rule }
      delete u.outboundTag
      delete u.balancerTag
      u[newType] = newType === 'outboundTag' ? (available.outbounds[0] ?? '') : (available.balancers[0] ?? '')
      onUpdate(index, u)
    }

    function changeOutboundValue(value: string) {
      if (!value) return
      onUpdate(index, { ...rule, [outboundType]: value }, true)
    }

    return (
      <div
        ref={ref}
        style={{ background: 'var(--color-input-background)' }}
        className={cn(
          'flex flex-col gap-2 rounded-xl border p-3 transition-all duration-150 select-none',
          isDragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none rounded p-1 transition-colors',
              isDragging ? 'cursor-grabbing' : 'cursor-grab'
            )}
            onMouseDown={(e) => onDragStart(e, index)}
            onTouchStart={(e) => onDragStart(e, index)}
          >
            <IconGripVertical size={19} />
          </div>
          <Badge variant="outline" className="h-6 w-6 rounded-md border-blue-500/20 bg-blue-500/10 p-3.5 px-4 text-blue-400">
            #{index + 1}
          </Badge>
          {editingName ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <input
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName()
                  if (e.key === 'Escape') {
                    setEditingName(false)
                    setNameValue(rule.ruleTag ?? '')
                  }
                }}
                autoFocus
                className="border-border h-6 min-w-0 flex-1 border-b bg-transparent text-xs outline-none"
                placeholder="Название правила"
              />
              <button onClick={saveName} className="text-muted-foreground hover:text-foreground shrink-0">
                <IconCheck size={14} />
              </button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
              {rule.ruleTag && <span className="truncate text-sm">{rule.ruleTag}</span>}
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        setEditingName(true)
                        setNameValue(rule.ruleTag ?? '')
                      }}
                      className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-colors"
                    >
                      <IconPencil size={16} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Редактировать название</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
          <button
            onClick={() => onDelete(index)}
            className="text-ring hover:text-destructive hover:bg-destructive/20 ml-auto shrink-0 rounded-md p-1 transition-colors"
          >
            <IconX size={23} className="cursor-pointer" />
          </button>
        </div>

        {/* Condition fields */}
        {conditionFields.map((fieldName) => {
          const cfg = RULE_FIELDS[fieldName as FieldName]
          const otherFields = (Object.keys(RULE_FIELDS) as FieldName[]).filter((f) => f === fieldName || !(f in rule))

          return (
            <div key={fieldName} className="flex items-start gap-2">
              <Select
                value={fieldName}
                onValueChange={(v) => {
                  if (v && v !== fieldName) changeField(fieldName, v as FieldName)
                }}
              >
                <SelectTrigger
                  popper
                  className="border-border bg-input-background hover:bg-muted flex h-9 w-fit shrink-0 items-center justify-between gap-2 rounded-md border px-3 text-[13px] font-medium transition-colors focus:ring-0 [&>svg]:opacity-50"
                >
                  <SelectValue placeholder={fieldName} />
                </SelectTrigger>

                <SelectContent position="popper" align="start">
                  <SelectGroup>
                    {otherFields.map((f) => (
                      <SelectItem key={f} value={f} className="cursor-pointer text-[13px]">
                        {f}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>

              <div className="min-w-0 flex-1">
                {cfg?.type === 'buttons' || fieldName === 'inboundTag' ? (
                  <div className="border-border bg-input-background flex min-h-9 cursor-pointer flex-wrap items-center gap-1 rounded-md border px-1 py-1 pr-1">
                    {((fieldName === 'inboundTag' ? available.inbounds : (cfg as any).options) ?? []).map((opt: string) => {
                      const active = getBadges(rule[fieldName]).includes(opt)
                      const colors: Record<string, { a: string; i: string }> = {
                        inboundTag: {
                          a: 'text-green-400 bg-green-400/15 border-none rounded-sm',
                          i: 'text-green-400/25 bg-green-400/3 border-none rounded-sm hover:bg-green-400/15',
                        },
                        protocol: {
                          a: 'text-purple-400 bg-purple-400/15 border-none rounded-sm',
                          i: 'text-purple-400/25 bg-purple-400/3 border-none rounded-sm hover:bg-purple-400/15',
                        },
                        network: {
                          a: 'text-blue-400 bg-blue-400/15 border-none rounded-sm',
                          i: 'text-blue-400/25 bg-blue-400/3 border-none rounded-sm hover:bg-blue-400/15',
                        },
                      }
                      const c = colors[fieldName] || {
                        a: 'text-primary-400 bg-primary-400/15 border-none rounded-sm',
                        i: 'text-primary-400/25 bg-primary-400/3 border-none rounded-sm hover:bg-primary-400/15',
                      }

                      return (
                        <button
                          key={opt}
                          onClick={() => toggleBtn(fieldName, opt)}
                          className={cn(
                            'cursor-pointer rounded border px-3 py-0.75 text-xs font-medium transition-colors',
                            active ? c.a : c.i
                          )}
                        >
                          {fieldName === 'network' || fieldName === 'protocol' ? opt.toUpperCase() : opt}
                        </button>
                      )
                    })}
                    {fieldName === 'inboundTag' && available.inbounds.length === 0 && (
                      <span className="text-muted-foreground text-xs">Inbound теги не найдены</span>
                    )}
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault()
                        removeField(fieldName)
                      }}
                      className="text-muted-foreground/40 hover:text-destructive ml-auto shrink-0 p-1 transition-colors"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                ) : (
                  <BadgeInput
                    badges={getBadges(rule[fieldName])}
                    placeholder={cfg?.placeholder ?? ''}
                    fieldType={fieldName}
                    onAdd={(v) => addBadge(fieldName, v)}
                    onRemove={(v) => removeBadge(fieldName, v)}
                    onRemoveField={() => removeField(fieldName)}
                    onEdit={(oldV, newV) => editBadge(fieldName, oldV, newV)}
                  />
                )}
              </div>
            </div>
          )
        })}

        {/* Add condition */}
        {availableToAdd.length > 0 && (
          <Select
            value=""
            onValueChange={(v) => {
              if (v) addField(v as FieldName)
            }}
          >
            <SelectTrigger
              popper
              className="text-muted-foreground hover:text-foreground border-border flex h-auto min-h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed bg-transparent px-3 py-2 text-xs tracking-wide transition-colors focus:ring-0 [&>svg]:hidden"
            >
              <span className="flex gap-1">
                <IconPlus size={13} />
                Добавить условие
              </span>
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectGroup>
                {availableToAdd.map((f) => (
                  <SelectItem key={f} value={f} className="cursor-pointer text-sm">
                    {f}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}

        {/* Outbound row */}
        <div className="flex items-center gap-2">
          <Select value={outboundType} onValueChange={(v) => switchOutbound(v as 'outboundTag' | 'balancerTag')}>
            <SelectTrigger
              popper
              className="min-w-34 shrink-0 border-blue-500/40 text-[13px] font-bold text-blue-400 transition-colors hover:bg-blue-500/10 [&>svg]:text-blue-400/60"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="border-blue-500/40">
              <SelectGroup>
                <SelectItem value="outboundTag" className="text-[13px] font-medium">
                  outboundTag
                </SelectItem>
                <SelectItem value="balancerTag" className="text-[13px] font-medium">
                  balancerTag
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select value={outboundValue} onValueChange={changeOutboundValue}>
            <SelectTrigger
              popper
              className="flex-1 border-blue-500/40 text-[13px] transition-colors hover:bg-blue-500/10 [&>svg]:text-blue-400/60"
            >
              <SelectValue placeholder="Выберите outbound..." />
            </SelectTrigger>
            <SelectContent position="popper" className="border-blue-500/40">
              <SelectGroup>
                {(isBalancer ? available.balancers : available.outbounds).length === 0 ? (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    {isBalancer ? 'Балансиры не найдены' : 'Аутбаунды не найдены'}
                  </div>
                ) : (
                  (isBalancer ? available.balancers : available.outbounds).map((tag) => (
                    <SelectItem key={tag} value={tag} className="text-[13px]">
                      {tag}
                    </SelectItem>
                  ))
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }),
  (prev, next) =>
    prev.rule === next.rule &&
    prev.index === next.index &&
    prev.isDragging === next.isDragging &&
    prev.available === next.available &&
    prev.showToast === next.showToast
)
RuleCard.displayName = 'RuleCard'

interface BadgeInputProps {
  badges: string[]
  placeholder: string
  fieldType: string
  onAdd: (v: string) => void
  onRemove: (v: string) => void
  onRemoveField: () => void
  onEdit: (oldV: string, newV: string) => void
}

function BadgeInput({ badges, placeholder, fieldType, onAdd, onRemove, onRemoveField, onEdit }: BadgeInputProps) {
  const [input, setInput] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function commitNew(v: string) {
    const t = v.trim()
    if (!t) return
    onAdd(t)
    setInput('')
  }

  function startEdit(i: number) {
    setEditingIndex(i)
    setEditingValue(badges[i])
  }

  function commitEdit() {
    if (editingIndex === null) return
    const old = badges[editingIndex]
    const trimmed = editingValue.trim()
    setEditingIndex(null)
    setEditingValue('')
    onEdit(old, trimmed)
  }

  function cancelEdit() {
    setEditingIndex(null)
    setEditingValue('')
  }

  const color =
    fieldType === 'domain'
      ? 'text-red-400 bg-red-400/15 border-none rounded-sm'
      : fieldType === 'ip'
        ? 'text-blue-400 bg-blue-400/15 border-none rounded-sm'
        : fieldType === 'sourceIP'
          ? 'text-purple-400 bg-purple-400/15 border-none rounded-sm'
          : 'text-yellow-400 bg-yellow-400/15 border-none rounded-sm'

  return (
    <div
      className="border-border bg-input-background relative flex min-h-9 cursor-text flex-wrap items-center gap-1 rounded-md border px-1 py-1 pr-7"
      onClick={() => {
        if (editingIndex === null) inputRef.current?.focus()
      }}
    >
      {badges.map((badge, i) =>
        editingIndex === i ? (
          <input
            key={i}
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                commitEdit()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            style={{ width: Math.max(editingValue.length * 8, 60) + 'px' }}
            className={cn('rounded border px-1.5 py-0.5 text-xs outline-none', color)}
          />
        ) : (
          <span
            key={i}
            onClick={(e) => {
              e.stopPropagation()
              startEdit(i)
            }}
            className={cn(
              'inline-flex max-w-full cursor-pointer items-center gap-0.5 rounded border py-0.75 pr-2.25 pl-3 text-xs tracking-wide break-all transition-opacity select-none hover:opacity-75',
              color
            )}
          >
            {badge}
            <button
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onRemove(badge)
              }}
              onClick={(e) => e.stopPropagation()}
              className="ml-1 text-sm leading-none opacity-50 transition-opacity hover:opacity-100"
            >
              <IconX size={12} />
            </button>
          </span>
        )
      )}
      {editingIndex === null && (
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commitNew(input)
            }
            if (e.key === ' ') {
              e.preventDefault()
              commitNew(input)
            }
            if (e.key === 'Backspace' && !input && badges.length > 0) onRemove(badges[badges.length - 1])
          }}
          onBlur={() => commitNew(input)}
          placeholder={badges.length === 0 ? placeholder : ''}
          className="placeholder:text-muted-foreground/50 min-w-5 flex-1 bg-transparent pr-1 pl-1 outline-none placeholder:text-[13px] md:text-[13px]"
        />
      )}
      <button
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onRemoveField()
        }}
        onClick={(e) => e.stopPropagation()}
        className="text-muted-foreground/40 hover:text-destructive absolute top-1.5 right-1 p-1 transition-colors"
      >
        <IconX size={14} />
      </button>
    </div>
  )
}
