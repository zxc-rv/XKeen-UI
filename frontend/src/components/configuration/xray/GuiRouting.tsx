import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { IconArrowsShuffle, IconCheck, IconGripVertical, IconInfoCircle, IconPencil, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import { forwardRef, memo, useCallback, useEffect, useRef, useState } from 'react'
import { apiCall } from '../../../lib/api'
import { useAppActions, useCoreRuntimeState, useSettings } from '../../../lib/store'
import type { Config } from '../../../lib/types'
import { cn } from '../../../lib/utils'
import { parse as parseJsonc } from 'jsonc-parser'
import type { CodeMirrorRef } from '../CodeMirror'
import { IndexBadge } from './IndexBadge'

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

type Balancer = Record<string, any>

const DOMAIN_STRATEGIES = ['AsIs', 'IPIfNonMatch', 'IPOnDemand']
const BALANCER_STRATEGIES = ['random', 'roundRobin', 'leastPing', 'leastLoad']
const BALANCER_INFO: Record<string, string> = {
  tag: 'Тег балансировщика нагрузки, используется для сопоставления с balancerTag в правилах маршрутизации.',
  selector:
    'Строки используются для сопоставления с префиксом тегов исходящих каналов. Например, для тегов a, ab, c, ba селектор a соответствует a и ab. Отобранные outbounds распределяют между собой нагрузку.',
  strategy:
    'random — случайно выбирает исходящий прокси.\nroundRobin — выбирает подключение по очереди.\nleastPing — выбирает прокси с наименьшей задержкой; требует observatory/burstObservatory, узлы без данных наблюдения исключаются.\nleastLoad — выбирает самый стабильный прокси; требует observatory/burstObservatory, узлы без данных наблюдения исключаются.',
  expected: 'Количество оптимальных узлов, выбираемых балансировщиком. Трафик будет случайным образом распределён между этими узлами.',
  maxRTT: 'Максимально допустимое время RTT (задержки) при измерении скорости.',
  tolerance: 'Максимально допустимая доля неудачных измерений скорости. Например, 0.01 означает, что допустим 1% неудачных измерений.',
  baselines: 'Максимально допустимое стандартное отклонение времени RTT при измерении скорости.',
  costs:
    'Необязательный массив, позволяющий задать веса для подключений.\nmatch — сопоставление Tag исходящего соединения.\nregexp — использовать ли регулярные выражения для выбора Tag.\nvalue — значение веса. Чем больше значение, тем менее вероятно, что узел будет выбран.',
  regexp: 'Использовать ли регулярные выражения для выбора Tag.',
  fallbackTag:
    'Если на основе результатов observatory все подключения оказываются недоступными, будет использовано подключение, выбранное здесь.',
}

const LEAST_LOAD_FIELDS = [
  { key: 'expected', type: 'number', placeholder: '2', info: BALANCER_INFO.expected },
  { key: 'maxRTT', type: 'text', placeholder: '1s', info: BALANCER_INFO.maxRTT },
  { key: 'tolerance', type: 'number', placeholder: '0.01', info: BALANCER_INFO.tolerance },
] as const
const NO_SPINNERS_CLASS =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
const ADD_BUTTON_CLASS =
  'text-muted-foreground border-ring/60 hover:border-chart-2 mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-3 py-2.5 text-sm font-medium transition-colors hover:border-solid hover:text-[#60a5fa]'

function parseRouting(content: string) {
  let routing: Record<string, any> = {}
  try {
    routing = parseJsonc(content)?.routing ?? {}
  } catch {
    /* */
  }
  return {
    rules: (Array.isArray(routing.rules) ? structuredClone(routing.rules) : []) as Rule[],
    balancers: (Array.isArray(routing.balancers) ? structuredClone(routing.balancers) : []) as Balancer[],
    domainStrategy: DOMAIN_STRATEGIES.includes(routing.domainStrategy) ? (routing.domainStrategy as string) : 'AsIs',
  }
}

function pruneEmptyLists(balancers: Balancer[]): Balancer[] {
  return balancers.map((balancer) => {
    const strategy = balancer.strategy ?? {}
    if (!strategy.settings || typeof strategy.settings !== 'object') return balancer
    const settings = { ...strategy.settings }
    for (const key of ['costs', 'baselines']) {
      if (Array.isArray(settings[key]) && settings[key].length === 0) delete settings[key]
    }
    const nextStrategy = { ...strategy, settings }
    if (Object.keys(settings).length === 0) delete nextStrategy.settings
    return { ...balancer, strategy: nextStrategy }
  })
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

function collectTags(content: string | undefined, read: (json: any) => any[] | undefined): string[] {
  try {
    const items = content ? (read(parseJsonc(content)) ?? []) : []
    return [...new Set<string>(items.filter((item) => item.tag).map((item) => item.tag))]
  } catch {
    return []
  }
}

function readAvailable(configs: Config[]): AvailableTags {
  const merged = (get: (json: any) => any[] | undefined): string[] => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const config of configs) {
      for (const tag of collectTags(config.content, get)) {
        if (seen.has(tag)) continue
        seen.add(tag)
        result.push(tag)
      }
    }
    return result
  }
  return {
    outbounds: merged((json) => json.outbounds),
    inbounds: merged((json) => json.inbounds),
    balancers: merged((json) => json.routing?.balancers),
  }
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
  const getActiveContent = () => configs[activeConfigIndex]?.content ?? editorRef.current?.getValue() ?? ''
  const [routing] = useState(() => parseRouting(getActiveContent()))
  const [rules, setRules] = useState<Rule[]>(routing.rules)
  const [balancers, setBalancers] = useState<Balancer[]>(routing.balancers)
  const [domainStrategy, setDomainStrategy] = useState(routing.domainStrategy)
  const [tab, setTab] = useState('rules')
  const [available, setAvailable] = useState<AvailableTags>(() => readAvailable(configs))
  const configsRef = useRef(configs)
  const activeConfigIndexRef = useRef(activeConfigIndex)
  const autoApplyRef = useRef(autoApply)
  const serviceStatusRef = useRef(serviceStatus)
  const currentCoreRef = useRef(currentCore)
  const rulesRef = useRef<Rule[]>(rules)
  const balancersRef = useRef<Balancer[]>(balancers)
  const balancerCardRefs = useRef<(HTMLDivElement | null)[]>([])
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const cardRefHandlersRef = useRef<Record<number, (el: HTMLDivElement | null) => void>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const balancersScrollRef = useRef<HTMLDivElement>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPatchRef = useRef<Record<string, unknown>>({})
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)

  const getCardRef = useCallback((index: number) => {
    if (!cardRefHandlersRef.current[index]) {
      cardRefHandlersRef.current[index] = (el: HTMLDivElement | null) => {
        cardRefs.current[index] = el
      }
    }
    return cardRefHandlersRef.current[index]
  }, [])

  useEffect(() => {
    const parsed = parseRouting(getActiveContent())
    rulesRef.current = parsed.rules
    setRules(parsed.rules)
    balancersRef.current = parsed.balancers
    setBalancers(parsed.balancers)
    setDomainStrategy(parsed.domainStrategy)
    setAvailable(readAvailable(configsRef.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfigIndex])

  useEffect(() => {
    configsRef.current = configs
    activeConfigIndexRef.current = activeConfigIndex
    setAvailable(readAvailable(configs))
  }, [configs, activeConfigIndex])

  useEffect(() => {
    autoApplyRef.current = autoApply
  }, [autoApply])

  useEffect(() => {
    serviceStatusRef.current = serviceStatus
    currentCoreRef.current = currentCore
  }, [serviceStatus, currentCore])

  const syncToEditor = useCallback(
    async (patch: Record<string, unknown>, triggerSoftRestart = false) => {
      const wrapper = editorRef.current
      if (!wrapper) return
      try {
        const json = parseJsonc(wrapper.getValue())
        json.routing = { ...json.routing, ...patch }
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

  const applyRouting = useCallback(
    (patch: Record<string, unknown>, triggerSoftRestart = false) => {
      Object.assign(pendingPatchRef.current, patch)
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
      syncTimerRef.current = setTimeout(() => {
        const pending = pendingPatchRef.current
        pendingPatchRef.current = {}
        syncToEditor(pending, triggerSoftRestart)
      }, 100)
    },
    [syncToEditor]
  )

  const applyRules = useCallback(
    (newRules: Rule[], triggerSoftRestart = false) => {
      rulesRef.current = newRules
      setRules(newRules)
      applyRouting({ rules: newRules }, triggerSoftRestart)
    },
    [applyRouting]
  )

  const updateBalancers = (next: Balancer[]) => {
    balancersRef.current = next
    setBalancers(next)
    applyRouting({ balancers: next.length ? pruneEmptyLists(next) : undefined })
  }

  const changeDomainStrategy = (value: string) => {
    setDomainStrategy(value)
    applyRouting({ domainStrategy: value })
  }

  const addBalancer = useCallback(() => {
    updateBalancers([
      ...balancersRef.current,
      { tag: `balancer-${balancersRef.current.length + 1}`, selector: [], strategy: { type: 'random' } },
    ])
    setTimeout(
      () =>
        balancersScrollRef.current?.scrollTo({
          top: balancersScrollRef.current.scrollHeight,
          behavior: 'smooth',
        }),
      50
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent, fromIndex: number, kind: 'rules' | 'balancers' = 'rules') => {
      const { itemsRef, setItems, refs } =
        kind === 'rules'
          ? { itemsRef: rulesRef, setItems: setRules, refs: cardRefs }
          : { itemsRef: balancersRef, setItems: setBalancers, refs: balancerCardRefs }
      if (e.cancelable) e.preventDefault()
      let current = fromIndex
      setDraggingIndex(fromIndex)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const clientY = 'touches' in ev ? ev.touches[0].clientY : ev.clientY
        for (let i = 0; i < refs.current.length; i++) {
          if (i === current) continue
          const rect = refs.current[i]?.getBoundingClientRect()
          if (!rect || clientY < rect.top || clientY > rect.bottom) continue
          const newItems = [...itemsRef.current]
          const [moved] = newItems.splice(current, 1)
          newItems.splice(i, 0, moved)
          current = i
          itemsRef.current = newItems
          setItems(newItems)
          setDraggingIndex(i)
          break
        }
      }
      const onUp = () => {
        syncToEditor({ [kind]: itemsRef.current })
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
    <Tabs value={tab} onValueChange={setTab} className="absolute inset-4 flex-col">
      <div className="flex shrink-0 items-center gap-2">
        <TabsList>
          <TabsTrigger value="rules" className="dark:data-[state=active]:bg-input-background! data-[state=active]:bg-white!">
            Роутинг
          </TabsTrigger>
          <TabsTrigger value="balancers" className="dark:data-[state=active]:bg-input-background! data-[state=active]:bg-white!">
            Балансеры
          </TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground hidden text-xs sm:inline">domainStrategy</span>
          <Select value={domainStrategy} onValueChange={changeDomainStrategy}>
            <SelectTrigger className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {DOMAIN_STRATEGIES.map((strategy) => (
                  <SelectItem key={strategy} value={strategy}>
                    {strategy}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
      <TabsContent ref={scrollRef} value="rules" className="flex min-h-0 scrollbar-thin flex-col gap-2 overflow-y-auto pb-1">
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
          className={ADD_BUTTON_CLASS}
        >
          <IconPlus size={17} /> Добавить правило
        </button>
      </TabsContent>
      <TabsContent ref={balancersScrollRef} value="balancers" className="flex min-h-0 scrollbar-thin flex-col gap-2 overflow-y-auto pb-1">
        {balancers.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconArrowsShuffle />
              </EmptyMedia>
              <EmptyTitle>Балансеры не найдены</EmptyTitle>
              <EmptyDescription>Добавьте балансер, чтобы распределять трафик между несколькими подключениями</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => addBalancer()}>
                <IconPlus data-icon="inline-start" /> Добавить
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {balancers.map((balancer, index) => (
              <BalancerCard
                key={index}
                ref={(element) => {
                  balancerCardRefs.current[index] = element
                }}
                balancer={balancer}
                index={index}
                isDragging={draggingIndex === index}
                available={available}
                onDragStart={(event) => startDrag(event, index, 'balancers')}
                onChange={(updated) => updateBalancers(balancers.map((item, position) => (position === index ? updated : item)))}
                onDelete={() => updateBalancers(balancers.filter((_, position) => position !== index))}
              />
            ))}
            <button onClick={() => addBalancer()} className={ADD_BUTTON_CLASS}>
              <IconPlus size={17} /> Добавить балансер
            </button>
          </>
        )}
      </TabsContent>
    </Tabs>
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
    const isBalancer = 'balancerTag' in rule
    const outboundType = isBalancer ? 'balancerTag' : 'outboundTag'
    const outboundValue = rule[outboundType] ?? ''
    const conditionFields = Object.keys(rule).filter((k) => k in RULE_FIELDS)
    const availableToAdd = (Object.keys(RULE_FIELDS) as FieldName[]).filter((f) => !(f in rule))

    function saveName(name: string) {
      const updated = { ...rule }
      if (name) updated.ruleTag = name
      else delete updated.ruleTag
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
        className={cn(
          'bg-input-background flex flex-col gap-2 rounded-xl border p-3 transition-all duration-150 select-none',
          isDragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-1">
          <div
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none rounded p-1 transition-colors',
              isDragging ? 'cursor-grabbing' : 'cursor-grab'
            )}
            onMouseDown={(e) => onDragStart(e, index)}
            onTouchStart={(e) => onDragStart(e, index)}
          >
            <IconGripVertical size={16} />
          </div>
          <IndexBadge index={index} />
          <EditableTitle value={rule.ruleTag ?? ''} placeholder="Название правила" onSave={saveName} />
          {availableToAdd.length > 0 && (
            <Select
              value=""
              onValueChange={(v) => {
                if (v) addField(v as FieldName)
              }}
            >
              <SelectTrigger
                popper
                hideIcon
                size="sm"
                aria-label="Добавить условие"
                className="text-muted-foreground hover:text-foreground border-border ml-auto h-8 shrink-0 gap-1.5 rounded-md border border-dashed bg-transparent px-2 text-xs transition-colors focus:ring-0 sm:pl-1.5"
              >
                <IconPlus size={13} />
                <span className="hidden sm:inline">Добавить условие</span>
              </SelectTrigger>
              <SelectContent position="popper" align="end">
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
          <Button
            onClick={() => onDelete(index)}
            variant="outline"
            size="icon-sm"
            className="hover:text-destructive hover:bg-destructive/20 shrink-0 rounded-md p-1 transition-colors"
          >
            <IconTrash size={16} className="cursor-pointer" />
          </Button>
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
                  className="border-border bg-input-background hover:bg-muted flex h-9 w-fit shrink-0 items-center justify-between gap-2 rounded-md border px-3 font-medium transition-colors focus:ring-0"
                >
                  <SelectValue placeholder={fieldName} />
                </SelectTrigger>

                <SelectContent position="popper" align="start">
                  <SelectGroup>
                    {otherFields.map((f) => (
                      <SelectItem key={f} value={f} className="cursor-pointer">
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

        {/* Outbound row */}
        <div className="flex items-center gap-2">
          <Select value={outboundType} onValueChange={(v) => switchOutbound(v as 'outboundTag' | 'balancerTag')}>
            <SelectTrigger
              popper
              className="min-w-34 shrink-0 border-blue-500/40 font-bold text-blue-400 transition-colors hover:bg-blue-500/10 [&>svg]:text-blue-400/60"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="border-blue-500/40">
              <SelectGroup>
                <SelectItem value="outboundTag" className="font-medium">
                  outboundTag
                </SelectItem>
                <SelectItem value="balancerTag" className="font-medium">
                  balancerTag
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select value={outboundValue} onValueChange={changeOutboundValue}>
            <SelectTrigger
              popper
              className="min-w-0 flex-1 border-blue-500/40 transition-colors hover:bg-blue-500/10 [&>svg]:text-blue-400/60"
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
                    <SelectItem key={tag} value={tag}>
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

const NO_FALLBACK = '__none__'

function listHandlers(list: string[], update: (next: string[]) => void) {
  return {
    badges: list,
    onAdd: (value: string) => {
      if (!list.includes(value)) update([...list, value])
    },
    onRemove: (value: string) => update(list.filter((item) => item !== value)),
    onEdit: (oldValue: string, newValue: string) => update(list.map((item) => (item === oldValue ? newValue : item)).filter(Boolean)),
    onRemoveField: () => update([]),
  }
}

function InfoIcon({ text, ariaLabel, className }: { text: string; ariaLabel?: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger
          render={<span className={cn('text-muted-foreground inline-flex cursor-help', className)} />}
          aria-label={ariaLabel ?? `Подробнее: ${text}`}
        >
          <IconInfoCircle className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-xs whitespace-pre-line">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function FieldRow({ label, tooltip, children }: { label: string; tooltip?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="border-border text-muted-foreground flex h-9 w-30 shrink-0 items-center rounded-md border px-3 text-sm font-medium">
        {label}
        {tooltip && <InfoIcon text={tooltip} ariaLabel={`Подробнее: ${label}`} className="ml-auto" />}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function EditableTitle({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  function save() {
    setEditing(false)
    onSave(draft.trim())
  }

  if (editing)
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              setEditing(false)
              setDraft(value)
            }
          }}
          autoFocus
          className="border-border h-6 min-w-0 flex-1 border-b bg-transparent text-xs outline-none"
          placeholder={placeholder}
        />
        <button onClick={save} className="text-muted-foreground hover:text-foreground shrink-0">
          <IconCheck size={14} />
        </button>
      </div>
    )

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {value && <span className="truncate text-sm">{value}</span>}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={() => {
                  setDraft(value)
                  setEditing(true)
                }}
                className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 transition-colors"
              >
                <IconPencil size={16} />
              </button>
            }
          />
          <TooltipContent>Редактировать название</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

interface BalancerCardProps {
  balancer: Balancer
  index: number
  isDragging: boolean
  available: AvailableTags
  onChange: (balancer: Balancer) => void
  onDelete: () => void
  onDragStart: (event: React.MouseEvent | React.TouchEvent) => void
}

const BalancerCard = forwardRef<HTMLDivElement, BalancerCardProps>(function BalancerCard(
  { balancer, index, isDragging, available, onChange, onDelete, onDragStart },
  ref
) {
  const strategyType: string = balancer.strategy?.type ?? 'random'
  const settings: Record<string, any> = balancer.strategy?.settings ?? {}
  const costs: Record<string, any>[] = settings.costs ?? []

  function patch(changes: Balancer) {
    onChange({ ...balancer, ...changes })
  }

  function patchSettings(changes: Record<string, unknown>) {
    patch({ strategy: { ...balancer.strategy, type: strategyType, settings: { ...settings, ...changes } } })
  }

  function patchCost(position: number, changes: Record<string, unknown>) {
    patchSettings({ costs: costs.map((cost, costIndex) => (costIndex === position ? { ...cost, ...changes } : cost)) })
  }

  return (
    <div
      ref={ref}
      className={cn(
        'bg-input-background flex flex-col gap-2 rounded-xl border p-3 transition-all duration-150 select-none',
        isDragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
      )}
    >
      <div className="flex items-center gap-1">
        <div
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none rounded p-1 transition-colors',
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
        >
          <IconGripVertical size={16} />
        </div>
        <IndexBadge index={index} />
        <EditableTitle value={balancer.tag ?? ''} placeholder="Тег балансера" onSave={(tag) => tag && patch({ tag })} />
        <Button
          onClick={onDelete}
          variant="outline"
          size="icon-sm"
          className="hover:text-destructive hover:bg-destructive/20 shrink-0 rounded-md p-1 transition-colors"
        >
          <IconTrash size={16} className="cursor-pointer" />
        </Button>
      </div>

      <FieldRow label="selector" tooltip={BALANCER_INFO.selector}>
        <BadgeInput
          {...listHandlers(balancer.selector ?? [], (selector) => patch({ selector }))}
          placeholder="proxy-, vless-"
          fieldType="selector"
        />
      </FieldRow>

      <FieldRow label="strategy" tooltip={BALANCER_INFO.strategy}>
        <Select value={strategyType} onValueChange={(type) => patch({ strategy: { type } })}>
          <SelectTrigger popper className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {BALANCER_STRATEGIES.map((strategy) => (
                <SelectItem key={strategy} value={strategy}>
                  {strategy}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </FieldRow>

      {strategyType === 'leastLoad' && (
        <>
          {LEAST_LOAD_FIELDS.map(({ key, type, placeholder, info }) => (
            <FieldRow key={key} label={key} tooltip={info}>
              <InputGroup>
                <InputGroupInput
                  key={String(settings[key] ?? '')}
                  type={type}
                  step="any"
                  defaultValue={String(settings[key] ?? '')}
                  placeholder={placeholder}
                  className={cn(NO_SPINNERS_CLASS, 'pr-7')}
                  onBlur={(event) => {
                    const next = event.target.value
                    if (next !== String(settings[key] ?? '')) {
                      patchSettings({ [key]: next === '' ? undefined : type === 'number' ? Number(next) : next })
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
                <button
                  onClick={() => patchSettings({ [key]: undefined })}
                  className="text-muted-foreground/40 hover:text-destructive absolute top-1.5 right-1 cursor-pointer p-1 transition-colors"
                  aria-label={`Удалить ${key}`}
                >
                  <IconX size={14} />
                </button>
              </InputGroup>
            </FieldRow>
          ))}

          <FieldRow label="baselines" tooltip={BALANCER_INFO.baselines}>
            <BadgeInput
              {...listHandlers(settings.baselines ?? [], (baselines) => patchSettings({ baselines }))}
              placeholder="1s, 2s"
              fieldType="baselines"
            />
          </FieldRow>

          <FieldRow label="costs" tooltip={BALANCER_INFO.costs}>
            <div className="flex flex-col gap-1">
              {costs.map((cost, position) => (
                <div key={position} className="flex flex-col gap-1 sm:flex-row sm:items-center">
                  <InputGroup className="min-w-0 flex-1">
                    <InputGroupAddon align="inline-start">
                      <InputGroupText>match</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      key={cost.match ?? ''}
                      defaultValue={cost.match ?? ''}
                      placeholder="tag"
                      onBlur={(event) => {
                        const next = event.target.value.trim()
                        if (next !== (cost.match ?? '')) patchCost(position, { match: next })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                    <InputGroupAddon align="inline-end" className="cursor-default!">
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <InputGroupButton
                                onClick={() => patchCost(position, { regexp: !cost.regexp })}
                                className={cn(
                                  'h-7 cursor-pointer rounded-[calc(var(--radius)-5px)] px-2 text-xs font-medium transition-colors',
                                  cost.regexp ? 'bg-yellow-400/15 text-yellow-400' : 'text-yellow-400/25 hover:bg-yellow-400/15'
                                )}
                              />
                            }
                            aria-label="regexp"
                          >
                            regexp
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={8}>
                            {BALANCER_INFO.regexp}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </InputGroupAddon>
                  </InputGroup>
                  <div className="flex items-center gap-1">
                    <InputGroup className="min-w-0 flex-1 sm:w-28 sm:flex-none">
                      <InputGroupAddon align="inline-start">
                        <InputGroupText>value</InputGroupText>
                      </InputGroupAddon>
                      <InputGroupInput
                        type="number"
                        step="any"
                        key={String(cost.value ?? '')}
                        defaultValue={String(cost.value ?? '')}
                        placeholder="0.5"
                        className={NO_SPINNERS_CLASS}
                        onBlur={(event) => {
                          const next = event.target.value
                          if (next !== String(cost.value ?? '')) patchCost(position, { value: Number(next) })
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                      />
                    </InputGroup>
                    <button
                      onClick={() => patchSettings({ costs: costs.filter((_, costIndex) => costIndex !== position) })}
                      className="text-muted-foreground/40 hover:text-destructive shrink-0 p-1 transition-colors"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={() => patchSettings({ costs: [...costs, { regexp: false, match: '', value: 0.5 }] })}
                className="text-muted-foreground hover:text-foreground border-border flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed text-xs transition-colors"
              >
                <IconPlus size={13} /> Добавить вес
              </button>
            </div>
          </FieldRow>
        </>
      )}

      <div className="flex items-center gap-2">
        <span className="bg-input-background flex h-9 min-w-34 shrink-0 items-center rounded-md border border-blue-500/40 px-2.5 text-sm font-bold text-blue-400 shadow-xs">
          fallbackTag
          <InfoIcon text={BALANCER_INFO.fallbackTag} ariaLabel="Подробнее: fallbackTag" className="ml-auto text-blue-400/40" />
        </span>
        <Select
          value={balancer.fallbackTag ?? NO_FALLBACK}
          items={{ [NO_FALLBACK]: 'Без фолбека', ...Object.fromEntries(available.outbounds.map((tag) => [tag, tag])) }}
          onValueChange={(fallbackTag) => patch({ fallbackTag: fallbackTag === NO_FALLBACK ? undefined : fallbackTag })}
        >
          <SelectTrigger
            popper
            className={cn(
              'min-w-0 flex-1 border-blue-500/40 transition-colors hover:bg-blue-500/10 [&>svg]:text-blue-400/60',
              !balancer.fallbackTag && 'text-muted-foreground'
            )}
          >
            <SelectValue placeholder="Выберите outbound..." />
          </SelectTrigger>
          <SelectContent position="popper" className="border-blue-500/40">
            <SelectGroup>
              <SelectItem value={NO_FALLBACK} className="text-muted-foreground">
                Без фолбека
              </SelectItem>
              {available.outbounds.length === 0 ? (
                <div className="text-muted-foreground px-2 py-1.5 text-xs">Аутбаунды не найдены</div>
              ) : (
                available.outbounds.map((tag) => (
                  <SelectItem key={tag} value={tag}>
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
})
BalancerCard.displayName = 'BalancerCard'
