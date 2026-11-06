import { RoutingSelectContent } from './RoutingSelectContent'
import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from 'react'
import { IconCodeDots, IconGripVertical, IconPencil, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  describeMihomoPayloadRule,
  describeMihomoRoutingRule,
  editMihomoRuleMatcher,
  getMihomoRuleConditions,
  getMihomoRuleOptions,
  MIHOMO_RULE_TYPES,
} from '@/lib/mihomo-rules'
import { IndexBadge } from '../xray/IndexBadge'

export function conditionColor(field: string, value = '', behavior?: string): string {
  const f = field.toUpperCase()
  if (behavior === 'domain' || f.includes('DOMAIN') || f === 'GEOSITE' || (f === 'RULE-SET' && /@domain$/i.test(value)))
    return 'text-red-400 bg-red-400/15'
  if (f.startsWith('SRC-IP') || f === 'SRC-GEOIP') return 'text-purple-400 bg-purple-400/15'
  if (behavior === 'ipcidr' || f.includes('IP') || f === 'NETWORK' || (f === 'RULE-SET' && /@ipcidr$/i.test(value)))
    return 'text-blue-400 bg-blue-400/15'
  if (f.includes('PORT') || f === 'DSCP') return 'text-yellow-400 bg-yellow-400/15'
  if (f.startsWith('IN-')) return 'text-green-400 bg-green-400/15'
  if (f.startsWith('PROCESS') || f === 'UID') return 'text-purple-400 bg-purple-400/15'
  return 'text-teal-400 bg-teal-400/15'
}

interface Props {
  raw: string
  index: number
  title?: string
  payload?: boolean
  behavior?: string
  targets: string[]
  providers: string[]
  dragging?: boolean
  onDragStart?: (event: MouseEvent | TouchEvent) => void
  onChange: (raw: string) => void
  onTargetChange?: (target: string) => void
  onEdit: () => void
  onDelete: () => void
  onError: (message: string) => void
}

export function MihomoRoutingRuleCard({
  raw,
  index,
  title,
  payload = false,
  behavior = 'classical',
  targets,
  providers,
  dragging,
  onDragStart,
  onChange,
  onTargetChange,
  onEdit,
  onDelete,
  onError,
}: Props) {
  const rule = payload ? describeMihomoPayloadRule(raw, behavior) : describeMihomoRoutingRule(raw)
  const type = rule.type.toUpperCase()
  const composite = ['AND', 'OR', 'NOT', 'SUB-RULE'].includes(type)
  const conditions = getMihomoRuleConditions(raw, payload)
  const options = payload && behavior !== 'classical' ? [] : getMihomoRuleOptions(raw, payload)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(rule.matcher)
  const skipBlurRef = useRef(false)
  useEffect(() => {
    setValue(rule.matcher)
    setEditing(false)
  }, [raw, rule.matcher])

  const label = payload ? `правило payload ${index + 1}` : `правило ${index + 1}`
  const types = composite
    ? [type]
    : payload && behavior === 'domain'
      ? ['DOMAIN', 'DOMAIN-SUFFIX']
      : payload && behavior === 'ipcidr'
        ? ['IP-CIDR', 'IP-CIDR6']
        : [...new Set([type, ...MIHOMO_RULE_TYPES, 'RULE-SET'])].filter((item) => item !== 'MATCH')
  function changeMatcher(nextType: string, nextValue: string) {
    try {
      onChange(editMihomoRuleMatcher(raw, nextType, nextValue, payload, behavior))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Не удалось изменить условие')
    }
  }
  function beginEdit() {
    skipBlurRef.current = false
    setValue(rule.matcher)
    setEditing(true)
  }
  function commit() {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      return
    }
    setEditing(false)
    if (value !== rule.matcher) changeMatcher(type, value)
  }

  return (
    <article
      className={cn(
        'bg-input-background flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-sm transition-all duration-150',
        dragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
      )}
      aria-label={`${payload ? 'Payload' : 'Правило'} ${index + 1}`}
    >
      <div className="flex min-w-0 items-center gap-1">
        {onDragStart && (
          <button
            type="button"
            aria-label={`Переместить ${label}`}
            onMouseDown={onDragStart}
            onTouchStart={onDragStart}
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none rounded p-1 transition-colors',
              dragging ? 'cursor-grabbing' : 'cursor-grab'
            )}
          >
            <IconGripVertical size={16} />
          </button>
        )}
        <IndexBadge index={index} />
        <span className="min-w-0 truncate font-medium" title={title || type}>
          {title || (type === 'MATCH' ? 'Остальной трафик' : '')}
        </span>
        {type !== 'MATCH' && (
          <button
            type="button"
            onClick={beginEdit}
            aria-label={`Изменить условие: ${label}`}
            className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 p-0.5 transition-colors"
          >
            <IconPencil size={16} />
          </button>
        )}
        {options.map((option, position) => (
          <span key={`${position}:${option}`} className="text-muted-foreground bg-muted rounded-sm px-2 py-0.5 text-xs">
            {option}
          </span>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" size="icon-sm" onClick={onEdit} aria-label={`Изменить ${label}`}>
                  <IconCodeDots className="size-4.5" />
                </Button>
              }
            />
            <TooltipContent>Редактировать строку правила</TooltipContent>
          </Tooltip>
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Удалить ${label}`}
                  disabled={dragging}
                  className="rounded-md p-1 transition-colors hover:text-red-400"
                />
              }
            >
              <IconTrash size={16} />
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="max-w-72">
              <PopoverHeader>
                <PopoverTitle>Удалить {label} из конфигурации?</PopoverTitle>
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
      </div>
      {type !== 'MATCH' && (
        <div className="flex min-w-0 items-start gap-2">
          <Select
            value={type}
            items={Object.fromEntries(types.map((item) => [item, item]))}
            onValueChange={(next) => next && changeMatcher(next, rule.matcher)}
          >
            <SelectTrigger aria-label={`Тип: ${label}`} disabled={composite} className="max-w-[45%] shrink-0">
              <SelectValue />
            </SelectTrigger>
            <RoutingSelectContent>
              {types.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </RoutingSelectContent>
          </Select>
          {type === 'NETWORK' ? (
            <div className="border-border bg-input-background flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border p-1">
              {['tcp', 'udp'].map((network) => (
                <button
                  key={network}
                  type="button"
                  aria-pressed={rule.matcher.toLowerCase() === network}
                  onClick={() => changeMatcher(type, network)}
                  className={cn(
                    'cursor-pointer rounded-sm px-3 py-0.75 text-xs font-medium transition-colors',
                    rule.matcher.toLowerCase() === network
                      ? 'bg-blue-400/15 text-blue-400'
                      : 'bg-blue-400/3 text-blue-400/25 hover:bg-blue-400/15'
                  )}
                >
                  {network.toUpperCase()}
                </button>
              ))}
            </div>
          ) : type === 'RULE-SET' && !editing ? (
            <Select
              value={rule.matcher}
              items={Object.fromEntries([...new Set([rule.matcher, ...providers])].map((item) => [item, item]))}
              onValueChange={(next) => next && changeMatcher(type, next)}
            >
              <SelectTrigger aria-label={`Набор правил: ${label}`} className="border-border min-w-0 flex-1">
                <SelectValue>
                  <span className={cn('rounded-sm px-3 py-0.75 text-xs tracking-wide', conditionColor(type, rule.matcher))}>
                    {rule.matcher}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <RoutingSelectContent>
                {[...new Set([rule.matcher, ...providers])].map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
              </RoutingSelectContent>
            </Select>
          ) : (
            <div className="border-border bg-input-background flex min-h-9 min-w-0 flex-1 items-center rounded-md border p-1 transition-colors focus-within:border-[#60a5fa]">
              {editing ? (
                <Input
                  autoFocus
                  value={value}
                  aria-label={`Значение: ${label}`}
                  onChange={(event) => setValue(event.target.value)}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      skipBlurRef.current = true
                      setValue(rule.matcher)
                      setEditing(false)
                    }
                  }}
                  className="h-7 border-0 bg-transparent px-2 text-sm shadow-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={beginEdit}
                  title="Нажмите для редактирования"
                  aria-label={`Значение: ${label}`}
                  className={cn(
                    'inline-flex max-w-full cursor-pointer rounded-sm px-3 py-0.75 text-left text-xs tracking-wide break-all transition-opacity hover:opacity-75',
                    conditionColor(type, rule.matcher, behavior === 'classical' ? undefined : behavior),
                    composite && 'font-mono'
                  )}
                >
                  {rule.matcher || '—'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {composite && conditions.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-1" aria-label="Условия составного правила">
          {conditions.map((condition, position) => (
            <span
              key={`${position}:${condition.field}`}
              className={cn('rounded-sm px-3 py-0.75 text-xs tracking-wide break-all', conditionColor(condition.field, condition.value))}
            >
              {condition.field}: {condition.value}
            </span>
          ))}
        </div>
      )}
      {!payload && rule.target && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="bg-input-background flex h-9 min-w-28 shrink-0 items-center rounded-md border border-blue-500/40 px-3 font-bold text-blue-400 sm:min-w-34">
            {type === 'SUB-RULE' ? 'Подправило' : 'Маршрут'}
          </span>
          <Select
            value={rule.target}
            items={Object.fromEntries([...new Set([...targets, rule.target])].map((item) => [item, item]))}
            onValueChange={(next) => next && onTargetChange?.(next)}
          >
            <SelectTrigger aria-label={`Маршрут правила ${index + 1}`} disabled={type === 'SUB-RULE'} className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <RoutingSelectContent>
              {[...new Set([...targets, rule.target])].map((target) => (
                <SelectItem key={target} value={target}>
                  {target}
                </SelectItem>
              ))}
            </RoutingSelectContent>
          </Select>
        </div>
      )}
    </article>
  )
}
