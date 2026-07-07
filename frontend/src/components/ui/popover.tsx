import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import * as React from 'react'

import { cn } from '@/lib/utils'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ children, render, ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverPrimitive.Trigger data-slot="popover-trigger" render={render} {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  )
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  avoidCollisions,
  anchor,
  side,
  alignOffset,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'sideOffset' | 'anchor' | 'side' | 'alignOffset'> & {
    avoidCollisions?: boolean
  }) {
  void avoidCollisions

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner align={align} sideOffset={sideOffset} anchor={anchor} side={side} alignOffset={alignOffset} className="isolate z-50">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'bg-card text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg p-2.5 text-sm shadow-md ring-1 outline-hidden transition duration-200 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({ children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="popover-anchor" {...props}>
      {children}
    </div>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="popover-header" className={cn('flex flex-col gap-0.5 text-sm', className)} {...props} />
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <div data-slot="popover-title" className={cn('font-medium', className)} {...props} />
}

function PopoverDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="popover-description" className={cn('text-muted-foreground', className)} {...props} />
}

export { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger }
