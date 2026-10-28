import { cn } from '../../../lib/utils'

interface IndexBadgeProps {
  /** Позиция элемента (с нуля), отображается как index + 1 */
  index: number
  className?: string
}

/**
 * Плоский круглый бадж с порядковым номером элемента списка (правило маршрутизации, аутбаунд).
 */
export function IndexBadge({ index, className }: IndexBadgeProps) {
  return (
    <span
      className={cn(
        'mr-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-blue-500/20 bg-blue-500/10 pt-px text-[11px] leading-none font-medium text-blue-400 select-none',
        className
      )}
    >
      {index + 1}
    </span>
  )
}
