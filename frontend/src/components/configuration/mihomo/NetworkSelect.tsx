import { Select, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { RoutingSelectContent } from './RoutingSelectContent'

interface Props {
  value: string
  onValueChange: (value: string) => void
  label?: string
  id?: string
  className?: string
}

export function NetworkSelect({ value, onValueChange, label, id, className }: Props) {
  const selected = value.toLowerCase()
  const values = [...new Set(['tcp', 'udp', ...(selected ? [selected] : [])])]
  return (
    <Select value={selected} items={Object.fromEntries(values.map((item) => [item, item]))} onValueChange={onValueChange}>
      <SelectTrigger id={id} aria-label={label} className={cn('w-full min-w-0', className)}>
        <SelectValue placeholder="Выберите сеть" />
      </SelectTrigger>
      <RoutingSelectContent>
        {values.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </RoutingSelectContent>
    </Select>
  )
}
