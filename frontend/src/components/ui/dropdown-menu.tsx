import { Menu as DropdownMenuPrimitive } from '@base-ui/react/menu'
import * as React from 'react'

import { getRenderChildren, getRenderProp } from '@/components/ui/primitive-render'
import { cn } from '@/lib/utils'
import { IconCheck, IconChevronRight } from '@tabler/icons-react'

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({
  asChild,
  children,
  render,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger> & { asChild?: boolean }) {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" render={getRenderProp(asChild, children, render)} {...props}>
      {getRenderChildren(asChild, children)}
    </DropdownMenuPrimitive.Trigger>
  )
}

function DropdownMenuContent({
  className,
  align = 'start',
  alignOffset,
  side,
  sideOffset = 4,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Popup> &
  Pick<DropdownMenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & {
    onCloseAutoFocus?: (event: Event) => void
  }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Positioner sideOffset={sideOffset} side={side} align={align} alignOffset={alignOffset} className="isolate z-50 outline-none">
        <DropdownMenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          finalFocus={onCloseAutoFocus ? () => null : undefined}
          className={cn(
            'border-border data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-input-background text-popover-foreground z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md outline-none transition duration-200 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

type MenuItemCompatProps<T extends React.ElementType> = React.ComponentProps<T> & {
  onSelect?: (event: React.MouseEvent<HTMLElement>) => void
  textValue?: string
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  onSelect,
  textValue,
  ...props
}: MenuItemCompatProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      onClick={onSelect}
      label={textValue}
      className={cn(
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:*:[svg]:text-destructive data-[variant=destructive]:focus:text-destructive group/dropdown-menu-item relative flex items-center gap-2 rounded-sm px-1.5 py-1.25 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) focus:font-semibold focus:text-[#60a5fa] not-data-[variant=destructive]:focus:**:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) data-highlighted:font-semibold data-highlighted:text-[#60a5fa] not-data-[variant=destructive]:data-highlighted:**:text-[#60a5fa] data-inset:pl-8 data-[variant=destructive]:focus:bg-(--menu-destructive-active-bg) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  onSelect,
  textValue,
  ...props
}: MenuItemCompatProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) focus:font-semibold focus:text-[#60a5fa] focus:**:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) data-highlighted:font-semibold data-highlighted:text-[#60a5fa] data-highlighted:**:text-[#60a5fa] data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      onClick={onSelect}
      label={textValue}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.CheckboxItemIndicator>
          <IconCheck />
        </DropdownMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  onSelect,
  textValue,
  ...props
}: MenuItemCompatProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) focus:font-semibold focus:text-[#60a5fa] focus:**:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) data-highlighted:font-semibold data-highlighted:text-[#60a5fa] data-highlighted:**:text-[#60a5fa] data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
      onClick={onSelect}
      label={textValue}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.RadioItemIndicator>
          <IconCheck />
        </DropdownMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.GroupLabel> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn('text-muted-foreground px-2 py-1.5 text-xs font-medium data-inset:pl-8', className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        'text-muted-foreground ml-auto text-xs tracking-widest group-focus/dropdown-menu-item:font-semibold group-focus/dropdown-menu-item:text-[#60a5fa]',
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuRoot>) {
  return <DropdownMenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  textValue,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean
  textValue?: string
}) {
  return (
    <DropdownMenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      label={textValue}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-1.5 py-1.25 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) focus:font-semibold focus:text-[#60a5fa] not-data-[variant=destructive]:focus:**:text-[#60a5fa] data-highlighted:bg-(--menu-active-bg) data-highlighted:font-semibold data-highlighted:text-[#60a5fa] not-data-[variant=destructive]:data-highlighted:**:text-[#60a5fa] data-inset:pl-8 data-popup-open:bg-(--menu-active-bg) data-popup-open:font-semibold data-popup-open:text-[#60a5fa] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <IconChevronRight className="ml-auto" />
    </DropdownMenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({ className, align = 'start', alignOffset = -3, side = 'right', sideOffset = 0, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Popup> & Pick<DropdownMenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Positioner align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} className="isolate z-50 outline-none">
        <DropdownMenuPrimitive.Popup
          data-slot="dropdown-menu-sub-content"
          className={cn(
            'border-border data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-input-background text-popover-foreground z-50 min-w-24 origin-(--transform-origin) overflow-hidden rounded-md border p-1 shadow-md outline-none transition duration-200 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Positioner>
    </DropdownMenuPrimitive.Portal>
  )
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
}
