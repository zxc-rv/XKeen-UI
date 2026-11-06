import { RoutingSelectContent } from './RoutingSelectContent'
import { useRef, useState, type MouseEvent, type TouchEvent } from 'react'
import { IconCodeDots, IconGripVertical, IconPlus, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { ClearIcon } from '@/components/ui/clear-icon'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { describeMihomoRoutingRule, editMihomoRuleMatcher, getMihomoRuleOptions } from '@/lib/mihomo-rules'
import { IndexBadge } from '../xray/IndexBadge'
import { conditionColor } from './RoutingRuleCard'
import { SelectorLabel } from './SelectorLabel'

type Group = { label: string; target: string; indices: number[]; subrule: boolean }
interface Props {
  group: Group
  groupIndex: number
  rules: string[]
  targets: string[]
  providerBehaviors: Record<string, string>
  groupIcons: Record<string, string>
  onChange: (index: number, raw: string) => void
  onTargetChange: (target: string) => void
  onDelete: (indices: number[]) => void
  onEdit: (indices: number[], label: string) => void
  onError: (message: string) => void
  onAddRule: () => void
  dragging?: boolean
  onDragStart?: (event: MouseEvent | TouchEvent) => void
}

function fieldLabel(type: string, behavior?: string) {
  if (behavior === 'domain' || type.includes('DOMAIN') || type === 'GEOSITE') return 'domain'
  if (type.startsWith('SRC-IP') || type === 'SRC-GEOIP') return 'sourceIP'
  if (behavior === 'ipcidr' || type.includes('IP')) return 'ip'
  if (type === 'DST-PORT') return 'port'
  if (type === 'SRC-PORT') return 'sourcePort'
  if (type === 'NETWORK') return 'network'
  if (type.startsWith('IN-')) return 'inbound'
  if (type.startsWith('PROCESS') || type === 'UID') return 'process'
  if (type === 'RULE-SET') return 'rule-set'
  return type
}

function DeleteButton({ label, onDelete, small = false }: { label: string; onDelete: () => void; small?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={small ? 'ghost' : 'outline'}
            size={small ? 'icon-xs' : 'icon-sm'}
            aria-label={`Удалить ${label}`}
            className={
              small
                ? 'size-4 rounded-sm p-0 text-current opacity-50 hover:bg-transparent hover:opacity-100'
                : 'rounded-md p-1 hover:text-red-400'
            }
          />
        }
      >
        {small ? <ClearIcon size={12} /> : <IconTrash size={16} />}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6}>
        <PopoverHeader>
          <PopoverTitle>Удалить {label} из конфигурации?</PopoverTitle>
        </PopoverHeader>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Нет
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Да
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function RuleBadge({
  raw,
  index,
  behavior,
  onChange,
  onDelete,
  onError,
}: {
  raw: string
  index: number
  behavior?: string
  onChange: (raw: string) => void
  onDelete: () => void
  onError: (message: string) => void
}) {
  const rule = describeMihomoRoutingRule(raw)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(rule.matcher)
  const skipBlur = useRef(false)
  const color = conditionColor(rule.type, rule.matcher, behavior)
  const text =
    rule.type.toUpperCase() === 'GEOSITE'
      ? `geosite:${rule.matcher}`
      : rule.type.toUpperCase() === 'GEOIP'
        ? `geoip:${rule.matcher}`
        : rule.matcher || rule.type
  function commit() {
    if (skipBlur.current) {
      skipBlur.current = false
      return
    }
    setEditing(false)
    if (value === rule.matcher) return
    try {
      onChange(editMihomoRuleMatcher(raw, rule.type.toUpperCase(), value))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Не удалось изменить правило')
    }
  }
  return (
    <span
      className={cn('inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-sm py-0.75 pr-2.25 pl-3 text-xs tracking-wide', color)}
      title={`Правило #${index + 1} · ${raw}`}
    >
      <span className="mr-1 text-[10px] tabular-nums opacity-60 select-none">{index + 1}.</span>
      {editing ? (
        <input
          autoFocus
          value={value}
          aria-label={`Значение правила ${index + 1}`}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              skipBlur.current = true
              setValue(rule.matcher)
              setEditing(false)
            }
          }}
          style={{ width: `${Math.max(8, Math.min(60, value.length + 1))}ch` }}
          className="max-w-full min-w-12 bg-transparent outline-none"
        />
      ) : (
        <button
          type="button"
          aria-label={`Изменить значение правила ${index + 1}`}
          onClick={() => {
            skipBlur.current = false
            setValue(rule.matcher)
            setEditing(true)
          }}
          className="min-w-0 cursor-pointer text-left break-all transition-opacity hover:opacity-75"
        >
          {text}
        </button>
      )}
      <DeleteButton small label={`правило ${index + 1}`} onDelete={onDelete} />
      {getMihomoRuleOptions(raw).length > 0 && <span className="ml-1 opacity-60">{getMihomoRuleOptions(raw).join(' · ')}</span>}
    </span>
  )
}

export function MihomoRoutingGroupCard({
  group,
  groupIndex,
  rules,
  targets,
  providerBehaviors,
  groupIcons,
  onChange,
  onTargetChange,
  onDelete,
  onEdit,
  onError,
  onAddRule,
  dragging,
  onDragStart,
}: Props) {
  const rows = new Map<string, number[]>()
  for (const index of group.indices) {
    const rule = describeMihomoRoutingRule(rules[index])
    if (rule.type.toUpperCase() === 'MATCH') continue
    const key = fieldLabel(rule.type.toUpperCase(), rule.type.toUpperCase() === 'RULE-SET' ? providerBehaviors[rule.matcher] : undefined)
    const row = rows.get(key)
    if (row) row.push(index)
    else rows.set(key, [index])
  }
  return (
    <article
      aria-label={`Блок ${group.label}`}
      className={cn(
        'bg-input-background flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-sm transition-all duration-150',
        dragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        {onDragStart && (
          <button
            type="button"
            aria-label={`Переместить блок ${group.label}`}
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
        <IndexBadge index={groupIndex} />
        <span className="min-w-0 truncate font-medium" title={group.label}>
          {group.label}
        </span>
        <span
          className="text-muted-foreground ml-1 text-xs"
          title={`Позиции в YAML: ${group.indices.map((index) => index + 1).join(', ')}`}
        >
          {group.indices.length}
        </span>
        <div className="ml-auto flex shrink-0 gap-1">
          {!group.subrule && rows.size > 0 && (
            <Button variant="outline" size="icon-sm" aria-label={`Добавить правило в блок ${group.label}`} onClick={onAddRule}>
              <IconPlus size={16} />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Изменить блок ${group.label}`}
            onClick={() => onEdit(group.indices, group.label)}
          >
            <IconCodeDots className="size-4.5" />
          </Button>
          <DeleteButton label={`блок ${group.label}`} onDelete={() => onDelete(group.indices)} />
        </div>
      </div>
      {[...rows.entries()].map(([field, indices]) => (
        <div key={field} className="flex min-w-0 items-start gap-2">
          <span className="border-border bg-input-background flex h-9 w-fit shrink-0 items-center rounded-md border px-3 font-medium">
            {field}
          </span>
          <div className="border-border bg-input-background flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border p-1 focus-within:border-[#60a5fa]">
            {indices.map((index) => {
              const rule = describeMihomoRoutingRule(rules[index])
              return (
                <RuleBadge
                  key={`${index}:${rules[index]}`}
                  raw={rules[index]}
                  index={index}
                  behavior={rule.type.toUpperCase() === 'RULE-SET' ? providerBehaviors[rule.matcher] : undefined}
                  onChange={(raw) => onChange(index, raw)}
                  onDelete={() => onDelete([index])}
                  onError={onError}
                />
              )
            })}
          </div>
        </div>
      ))}
      <div className="flex min-w-0 items-center gap-2">
        <span className="bg-input-background flex h-9 min-w-28 shrink-0 items-center rounded-md border border-blue-500/40 px-3 font-bold text-blue-400 sm:min-w-34">
          {group.subrule ? 'Подправило' : 'Маршрут'}
        </span>
        <Select
          value={group.target}
          items={Object.fromEntries(
            [...new Set([...targets, group.target])].filter((target) => target !== 'REJECT-DROP').map((target) => [target, target])
          )}
          onValueChange={(next) => next && onTargetChange(next)}
        >
          <SelectTrigger disabled={group.subrule} aria-label={`Маршрут группы ${group.label}`} className="min-w-0 flex-1">
            <SelectValue>
              <SelectorLabel name={group.target} icon={groupIcons[group.target]} />
            </SelectValue>
          </SelectTrigger>
          <RoutingSelectContent>
            {[...new Set([...targets, group.target])]
              .filter((target) => target !== 'REJECT-DROP')
              .map((target) => (
                <SelectItem key={target} value={target}>
                  <SelectorLabel name={target} icon={groupIcons[target]} />
                </SelectItem>
              ))}
          </RoutingSelectContent>
        </Select>
      </div>
    </article>
  )
}
