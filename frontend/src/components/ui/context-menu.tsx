import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import * as React from 'react'

import { getRenderChildren, getRenderProp } from '@/components/ui/primitive-render'
import { cn } from '@/lib/utils'
import { IconCheck, IconChevronRight } from '@tabler/icons-react'

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  className,
  asChild,
  children,
  render,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger> & { asChild?: boolean }) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      render={getRenderProp(asChild, children, render)}
      className={cn('select-none', className)}
      {...props}
    >
      {getRenderChildren(asChild, children)}
    </ContextMenuPrimitive.Trigger>
  )
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
}

function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubmenuRoot>) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

function ContextMenuContent({
  className,
  side,
  alignOffset,
  sideOffset,
  align,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Popup> &
  Pick<ContextMenuPrimitive.Positioner.Props, 'side' | 'alignOffset' | 'sideOffset' | 'align'> & {
    onCloseAutoFocus?: (event: Event) => void
  }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner side={side} alignOffset={alignOffset} sideOffset={sideOffset} align={align} className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          finalFocus={onCloseAutoFocus ? false : undefined}
          className={cn(
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 bg-input-background text-popover-foreground z-50 max-h-(--available-height) min-w-41 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md p-1 shadow-md ring-1 outline-none transition duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

type ContextMenuItemCompatProps<T extends React.ElementType> = React.ComponentProps<T> & {
  onSelect?: (event: React.MouseEvent<HTMLElement>) => void
  textValue?: string
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  onSelect,
  textValue,
  ...props
}: ContextMenuItemCompatProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      onClick={onSelect}
      label={textValue}
      className={cn(
        "group/context-menu-item data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive relative flex items-center gap-2 rounded-sm px-2 py-1.25 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) not-data-[variant=destructive]:focus:font-semibold not-data-[variant=destructive]:focus:text-[#60a5fa] not-data-[variant=destructive]:focus:**:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) data-inset:pl-8 data-[variant=destructive]:focus:bg-(--menu-destructive-active-bg) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  textValue,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubmenuTrigger> & {
  inset?: boolean
  textValue?: string
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      label={textValue}
      className={cn(
        "focus:text-accent-foreground data-popup-open:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.25 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) data-highlighted:bg-(--menu-active-bg) data-inset:pl-8 data-popup-open:bg-(--menu-active-bg) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <IconChevronRight className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

function ContextMenuSubContent({ className, align = 'start', alignOffset = 4, side = 'right', sideOffset = 0, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Popup> & Pick<ContextMenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-sub-content"
          className={cn(
            'bg-popover text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 origin-(--transform-origin) overflow-hidden rounded-md border p-1 shadow-lg outline-none transition duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  onSelect,
  textValue,
  ...props
}: ContextMenuItemCompatProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.25 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      onClick={onSelect}
      label={textValue}
      {...props}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <IconCheck />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  onSelect,
  textValue,
  ...props
}: ContextMenuItemCompatProps<typeof ContextMenuPrimitive.RadioItem> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.25 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-(--menu-active-bg) data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-(--menu-active-bg) data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
      onClick={onSelect}
      label={textValue}
    >
      <span className="pointer-events-none absolute right-2">
        <ContextMenuPrimitive.RadioItemIndicator>
          <IconCheck />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.GroupLabel> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn('text-muted-foreground px-2 py-1.25 text-xs font-medium data-inset:pl-8', className)}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />
  )
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        'text-muted-foreground group-focus/context-menu-item:text-accent-foreground ml-auto text-xs tracking-widest',
        className
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
}
