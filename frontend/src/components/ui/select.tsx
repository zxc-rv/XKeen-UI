import { Select as SelectPrimitive } from '@base-ui/react/select'
import type { SelectRootProps, SelectRootChangeEventDetails } from '@base-ui/react/select'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { IconCheck, IconChevronDown, IconChevronUp, IconSelector } from '@tabler/icons-react'

function Select({
  onValueChange,
  items,
  ...props
}: Omit<SelectRootProps<string>, 'onValueChange'> & {
  onValueChange?: (value: string, eventDetails: SelectRootChangeEventDetails) => void
}) {
  return (
    <SelectPrimitive.Root<string>
      data-slot="select"
      items={items}
      onValueChange={(value, details) => {
        if (value !== null) onValueChange?.(value, details)
      }}
      {...props}
    />
  )
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn('scroll-my-1 p-1', className)} {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = 'default',
  popper = false,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default'
  popper?: boolean
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      data-popper={popper ? '' : undefined}
      className={cn(
        "bg-input-background hover:bg-input-background-hover data-popper:data-popup-open:hover:bg-input-background flex w-fit cursor-pointer items-center justify-between gap-1.5 rounded-md border py-2 pr-2 pl-2.5 text-sm whitespace-nowrap shadow-xs transition-[background-color,border-color,box-shadow] duration-200 outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 data-popper:data-popup-open:border-[#60a5fa] data-popper:data-popup-open:[box-shadow:0_0_0_3px rgba(59,130,246,0.15)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <IconSelector className="text-muted-foreground pointer-events-none size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'item-aligned',
  align = 'center',
  sideOffset = 4,
  side,
  alignOffset,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  position?: 'item-aligned' | 'popper'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  side?: 'top' | 'bottom' | 'left' | 'right'
  alignOffset?: number
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        alignItemWithTrigger={position === 'item-aligned'}
        align={align}
        sideOffset={sideOffset}
        side={side}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'border-border bg-input-background text-popover-foreground relative z-50 max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-md border shadow-md',
            position === 'popper'
              ? 'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-open:slide-in-from-top-2 data-[side=bottom]:data-closed:slide-out-to-top-2 data-[side=top]:data-open:slide-in-from-bottom-2 data-[side=top]:data-closed:slide-out-to-bottom-2 duration-200'
              : 'transition duration-200 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className
          )}
          {...props}
        >
          <SelectScrollUpArrow />
          <SelectPrimitive.List>
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownArrow />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel data-slot="select-label" className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)} {...props} />
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full items-center gap-2 rounded-sm py-1.25 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) focus:font-semibold focus:text-[#60a5fa] not-data-[variant=destructive]:focus:**:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <IconCheck className="pointer-events-none size-3.5 stroke-3" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function SelectScrollUpArrow({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-arrow"
      className={cn(
        "z-10 inset-x-0 top-0 flex cursor-default items-center justify-center py-1 bg-gradient-to-b from-(--color-input-background) to-transparent [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <IconChevronUp />
    </SelectPrimitive.ScrollUpArrow>
  )
}

function SelectScrollDownArrow({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-arrow"
      className={cn(
        "z-10 inset-x-0 bottom-0 flex cursor-default items-center justify-center py-1 bg-gradient-to-t from-(--color-input-background) to-transparent [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <IconChevronDown />
    </SelectPrimitive.ScrollDownArrow>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownArrow,
  SelectScrollUpArrow,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
