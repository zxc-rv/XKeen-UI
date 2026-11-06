import { ProviderLabel } from './ProviderLabel'
import { mihomoRuleColor } from '@/lib/mihomo-rule-color'
import { cn } from '@/lib/utils'
import { NetworkSelect } from './NetworkSelect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MIHOMO_RULE_TYPES, type MihomoConditionNode } from '@/lib/mihomo-rules'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { RoutingSelectContent } from './RoutingSelectContent'

export const CONDITION_TYPES = ['RULE-SET', ...MIHOMO_RULE_TYPES, 'AND', 'OR', 'NOT']
export function emptyCondition(type = 'DOMAIN-SUFFIX'): MihomoConditionNode {
  return ['AND', 'OR', 'NOT'].includes(type)
    ? { type, children: [emptyCondition(), ...(type === 'NOT' ? [] : [emptyCondition('NETWORK')])] }
    : { type, value: '' }
}

interface Props {
  node: MihomoConditionNode
  onChange: (node: MihomoConditionNode) => void
  providers: string[]
  depth?: number
}

export function ConditionEditor({ node, onChange, providers, depth = 0 }: Props) {
  const logical = ['AND', 'OR', 'NOT'].includes(node.type)
  const children = node.children ?? []
  return (
    <div className="min-w-0 space-y-3 rounded-lg border p-3" aria-label={depth ? 'Условие' : 'Правило конструктора'}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select value={node.type} onValueChange={(type) => type && onChange(type === node.type ? node : emptyCondition(type))}>
          <SelectTrigger
            aria-label={depth ? 'Тип условия' : 'Тип правила'}
            className={cn('w-full min-w-0 sm:w-52', mihomoRuleColor(node.type, '', false))}
          >
            <SelectValue />
          </SelectTrigger>
          <RoutingSelectContent>
            {CONDITION_TYPES.map((type) => (
              <SelectItem key={type} value={type} className={mihomoRuleColor(type, '', false)}>
                {type}
              </SelectItem>
            ))}
          </RoutingSelectContent>
        </Select>
        {logical ? (
          <span className="text-muted-foreground text-xs">
            {node.type === 'AND' ? 'Все условия' : node.type === 'OR' ? 'Любое условие' : 'Не соответствует условию'}
          </span>
        ) : node.type === 'RULE-SET' ? (
          <Select value={node.value ?? ''} onValueChange={(value) => onChange({ ...node, value })}>
            <SelectTrigger aria-label="Rule-provider условия" className="min-w-0 flex-1">
              <SelectValue placeholder="Выберите rule-provider">
                {node.value ? <ProviderLabel name={node.value} /> : 'Выберите rule-provider'}
              </SelectValue>
            </SelectTrigger>
            <RoutingSelectContent>
              {providers.map((name) => (
                <SelectItem key={name} value={name}>
                  <ProviderLabel name={name} />
                </SelectItem>
              ))}
            </RoutingSelectContent>
          </Select>
        ) : node.type === 'NETWORK' ? (
          <div className="min-w-0 flex-1">
            <NetworkSelect label="Сеть условия" value={node.value ?? ''} onValueChange={(value) => onChange({ ...node, value })} />
          </div>
        ) : (
          <Input
            aria-label="Значение условия"
            className="min-w-0 flex-1 basis-40"
            value={node.value ?? ''}
            placeholder={node.type === 'NETWORK' ? 'tcp / udp' : 'Значение'}
            onChange={(event) => onChange({ ...node, value: event.target.value })}
          />
        )}
      </div>
      {logical && (
        <div className="space-y-3 border-l-2 pl-3">
          {children.map((child, index) => (
            <div key={index} className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <ConditionEditor
                  node={child}
                  providers={providers}
                  depth={depth + 1}
                  onChange={(next) => onChange({ ...node, children: children.map((item, i) => (i === index ? next : item)) })}
                />
              </div>
              {node.type !== 'NOT' && (
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={`Удалить условие ${index + 1}`}
                  onClick={() => onChange({ ...node, children: children.filter((_, i) => i !== index) })}
                >
                  <IconTrash size={16} />
                </Button>
              )}
            </div>
          ))}
          {node.type !== 'NOT' && (
            <Button size="sm" variant="outline" onClick={() => onChange({ ...node, children: [...children, emptyCondition()] })}>
              <IconPlus size={16} />
              Добавить условие
            </Button>
          )}
        </div>
      )}
      {!!node.options?.length && <p className="text-muted-foreground text-xs">{node.options.join(' · ')}</p>}
    </div>
  )
}
