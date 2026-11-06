import type { ReactNode } from 'react'
import { SelectContent, SelectGroup } from '@/components/ui/select'

/** Same menu styling and grouped item spacing as the Add Rule dialog. */
export function RoutingSelectContent({
  children,
  align = 'center',
  position = 'item-aligned',
}: {
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  position?: 'item-aligned' | 'popper'
}) {
  return (
    <SelectContent
      align={align}
      position={position}
      className="max-h-[min(31rem,var(--available-height))] w-117 max-w-[calc(100vw-2rem)] min-w-0!"
    >
      <SelectGroup>{children}</SelectGroup>
    </SelectContent>
  )
}
