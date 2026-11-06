import { ConditionSummary } from './ConditionSummary'
import { ProviderLabel } from './ProviderLabel'
import { mihomoRuleColor } from '@/lib/mihomo-rule-color'
import { NetworkSelect } from './NetworkSelect'
import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react'
import { IconPencil, IconGripVertical, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  describeMihomoRoutingRule,
  editMihomoRuleMatcher,
  getMihomoRuleOptions,
  setMihomoRuleOptions,
  summarizeMihomoCondition,
  MIHOMO_RULE_TYPES,
} from '@/lib/mihomo-rules'
import { cn } from '@/lib/utils'
import { IndexBadge } from '../xray/IndexBadge'
import { RoutingSelectContent } from './RoutingSelectContent'
import { SelectorLabel } from './SelectorLabel'

interface Props {
  draft?: boolean
  onConstruct: (type: string) => void
  raw: string
  index: number
  targets: string[]
  providers: string[]
  icons: Record<string, string>
  dragging: boolean
  onDragStart: (event: MouseEvent | TouchEvent) => void
  onChange: (raw: string) => void
  onTargetChange: (target: string) => void
  onEdit: () => void
  onDelete: () => void
  onError: (message: string) => void
}

export function MihomoRoutingRuleRow({
  draft = false,
  onConstruct,
  raw,
  index,
  targets,
  providers,
  icons,
  dragging,
  onDragStart,
  onChange,
  onTargetChange,
  onEdit,
  onDelete,
  onError,
}: Props) {
  const rule = describeMihomoRoutingRule(raw)
  const type = rule.type.toUpperCase()
  const flags = getMihomoRuleOptions(raw)
  const hasOptions = flags.length > 0 || /^(?:IP-|SRC-IP-|GEOIP$|SRC-GEOIP$)/.test(type)
  const optionChoices = { none: 'Без параметров', 'no-resolve': 'no-resolve', src: 'src', 'no-resolve,src': 'no-resolve · src' }
  const optionValue = flags.includes('no-resolve') && flags.includes('src') ? 'no-resolve,src' : (flags[0] ?? 'none')
  const logical = ['AND', 'OR', 'NOT'].includes(type)
  let summary = rule.matcher
  if (logical) {
    try {
      summary = summarizeMihomoCondition(`${type},${rule.matcher}`)
    } catch {
      /* Keep raw conditions visible when unsupported. */
    }
  }
  const fixedType = ['SUB-RULE', 'MATCH'].includes(type)
  const types = fixedType ? [type] : [...new Set(['RULE-SET', ...MIHOMO_RULE_TYPES, 'AND', 'OR', 'NOT', type])]
  const routes = [...new Set([...targets, ...(rule.target ? [rule.target] : [])])].filter((target) => target !== 'REJECT-DROP')
  const [value, setValue] = useState(rule.matcher)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cancelBlur = useRef(false)
  useEffect(() => {
    setValue(rule.matcher)
  }, [rule.matcher])
  function edit(nextType: string, nextValue: string) {
    try {
      if (['AND', 'OR', 'NOT'].includes(nextType)) {
        onConstruct(nextType)
        return
      }
      onChange(draft ? [nextType, nextValue.trim(), rule.target].join(',') : editMihomoRuleMatcher(raw, nextType, nextValue))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Не удалось изменить правило')
      setValue(rule.matcher)
    }
  }
  function commit() {
    if (cancelBlur.current) {
      cancelBlur.current = false
      return
    }
    if (value !== rule.matcher) edit(type, value)
  }
  return (
    <article
      aria-label={`Строка правила ${index + 1}`}
      className={cn(
        'bg-input-background grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border p-2 text-sm lg:grid-cols-[auto_auto_minmax(0,0.8fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto]',
        dragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
      )}
    >
      <button
        type="button"
        disabled={draft}
        aria-label={`Переместить правило ${index + 1}`}
        onMouseDown={onDragStart}
        onTouchStart={onDragStart}
        className={cn(
          'text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none rounded p-1',
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        )}
      >
        <IconGripVertical size={16} />
      </button>
      {draft ? (
        <span className="text-chart-2 flex h-6 w-6 items-center justify-center" aria-label="Новое правило">
          +
        </span>
      ) : (
        <IndexBadge index={index} className="mr-0" />
      )}
      <Select
        value={type}
        items={Object.fromEntries(types.map((item) => [item, item]))}
        onValueChange={(next) => next && edit(next, rule.matcher)}
      >
        <SelectTrigger
          disabled={fixedType}
          aria-label={`Тип правила ${index + 1}`}
          className={cn('w-full min-w-0', mihomoRuleColor(type, '', false))}
        >
          <SelectValue />
        </SelectTrigger>
        <RoutingSelectContent>
          {types.map((item) => (
            <SelectItem key={item} value={item} className={mihomoRuleColor(item, '', false)}>
              {item}
            </SelectItem>
          ))}
        </RoutingSelectContent>
      </Select>
      <div className="bg-input-background border-border col-span-4 flex h-9 min-w-0 items-center overflow-hidden rounded-md border lg:col-auto">
        <div className="h-full min-w-0 flex-1">
          {logical ? (
            <Button
              variant="outline"
              aria-label={`Изменить условия правила ${index + 1}`}
              className="h-full w-full min-w-0 justify-start rounded-none border-0 font-normal"
              onClick={onEdit}
            >
              <span className="min-w-0 truncate">
                <ConditionSummary raw={`${type},${rule.matcher}`} fallback={summary} />
              </span>
            </Button>
          ) : type === 'RULE-SET' ? (
            <Select
              value={rule.matcher}
              items={Object.fromEntries([...new Set([rule.matcher, ...providers])].map((item) => [item, item]))}
              onValueChange={(next) => next && edit(type, next)}
            >
              <SelectTrigger aria-label={`Значение правила ${index + 1}`} className="h-full w-full min-w-0 rounded-none border-0">
                <SelectValue>
                  <ProviderLabel name={rule.matcher} />
                </SelectValue>
              </SelectTrigger>
              <RoutingSelectContent>
                {[...new Set([rule.matcher, ...providers])].map((item) => (
                  <SelectItem key={item} value={item}>
                    <ProviderLabel name={item} />
                  </SelectItem>
                ))}
              </RoutingSelectContent>
            </Select>
          ) : type === 'NETWORK' ? (
            <NetworkSelect
              label={`Значение правила ${index + 1}`}
              value={rule.matcher}
              onValueChange={(next) => edit(type, next)}
              className="h-full rounded-none border-0"
            />
          ) : (
            <Input
              className="h-full w-full min-w-0 rounded-none border-0"
              value={value}
              readOnly={type === 'MATCH'}
              placeholder={type === 'MATCH' ? 'Любой трафик' : ''}
              aria-label={`Значение правила ${index + 1}`}
              onFocus={() => {
                cancelBlur.current = false
              }}
              onChange={(event) => setValue(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  cancelBlur.current = true
                  setValue(rule.matcher)
                  event.currentTarget.blur()
                }
              }}
            />
          )}
        </div>
        {hasOptions && (
          <div className="h-full max-w-[48%] min-w-0 shrink-0">
            <Select
              value={optionValue}
              items={optionChoices}
              onValueChange={(next) => {
                try {
                  onChange(setMihomoRuleOptions(raw, next === 'none' ? [] : next.split(',')))
                } catch (error) {
                  onError(error instanceof Error ? error.message : 'Не удалось изменить параметры')
                }
              }}
            >
              <SelectTrigger aria-label={`Параметры правила ${index + 1}`} className="h-full w-full min-w-0 rounded-none border-0 border-l">
                <SelectValue>{optionValue === 'none' ? 'Параметры' : optionChoices[optionValue as keyof typeof optionChoices]}</SelectValue>
              </SelectTrigger>
              <RoutingSelectContent>
                {Object.entries(optionChoices).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </RoutingSelectContent>
            </Select>
          </div>
        )}
      </div>
      <div className="col-span-4 min-w-0 lg:col-auto">
        <Select
          value={rule.target}
          items={Object.fromEntries(routes.map((target) => [target, target]))}
          onValueChange={(next) => next && onTargetChange(next)}
        >
          <SelectTrigger disabled={type === 'SUB-RULE'} aria-label={`Маршрут правила ${index + 1}`} className="w-full min-w-0">
            <SelectValue placeholder="Выберите маршрут">
              {rule.target ? <SelectorLabel name={rule.target} icon={icons[rule.target]} /> : 'Выберите маршрут'}
            </SelectValue>
          </SelectTrigger>
          <RoutingSelectContent>
            {routes.map((target) => (
              <SelectItem key={target} value={target}>
                <SelectorLabel name={target} icon={icons[target]} />
              </SelectItem>
            ))}
          </RoutingSelectContent>
        </Select>
      </div>
      <div className="col-start-4 row-start-1 flex gap-1 lg:col-start-auto lg:row-start-auto">
        <Button variant="outline" size="icon-sm" aria-label={`Изменить правило ${index + 1}`} onClick={onEdit}>
          <IconPencil size={16} />
        </Button>
        <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
          <PopoverTrigger
            render={<Button variant="outline" size="icon-sm" aria-label={`Удалить правило ${index + 1}`} className="hover:text-red-400" />}
          >
            <IconTrash size={16} />
          </PopoverTrigger>
          <PopoverContent align="end">
            <PopoverHeader>
              <PopoverTitle>Удалить правило #{index + 1} из конфигурации?</PopoverTitle>
            </PopoverHeader>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
                Нет
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false)
                  onDelete()
                }}
              >
                Да
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </article>
  )
}
