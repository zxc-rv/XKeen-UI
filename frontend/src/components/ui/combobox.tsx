'use client'

import { Combobox as ComboboxPrimitive } from '@base-ui/react'
import { IconCheck, IconSelector, IconX } from '@tabler/icons-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'

const ComboboxOpenContext = React.createContext(false)
const ComboboxAnchorContext = React.createContext<{
  anchorElement: HTMLDivElement | null
  setAnchorElement: (element: HTMLDivElement | null) => void
}>({
  anchorElement: null,
  setAnchorElement: () => {},
})

function Combobox<Value, Multiple extends boolean | undefined = false>({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: ComboboxPrimitive.Root.Props<Value, Multiple>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const [anchorElement, setAnchorElement] = React.useState<HTMLDivElement | null>(null)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean, eventDetails: ComboboxPrimitive.Root.ChangeEventDetails) => {
      if (!isControlled) setUncontrolledOpen(nextOpen)
      onOpenChange?.(nextOpen, eventDetails)
    },
    [isControlled, onOpenChange]
  )

  return (
    <ComboboxOpenContext.Provider value={!!open}>
      <ComboboxAnchorContext.Provider value={{ anchorElement, setAnchorElement }}>
        <ComboboxPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props} />
      </ComboboxAnchorContext.Provider>
    </ComboboxOpenContext.Provider>
  )
}

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  const open = React.useContext(ComboboxOpenContext)

  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      data-popup-open={open || undefined}
      className={cn('cursor-default! [&_svg:not([class*=size-])]:size-4', className)}
      {...props}
    >
      {children}
      <IconSelector className="text-muted-foreground pointer-events-none size-4" />
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn(className)}
      {...props}
    >
      <IconX className="pointer-events-none" />
    </ComboboxPrimitive.Clear>
  )
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  fullWidth = false,
  openBorderColor = '#60a5fa',
  openShadowColor = 'rgba(59,130,246,0.15)',
  showTrigger = true,
  showClear = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  fullWidth?: boolean
  openBorderColor?: string
  openShadowColor?: string
  showTrigger?: boolean
  showClear?: boolean
}) {
  const open = React.useContext(ComboboxOpenContext)
  const { setAnchorElement } = React.useContext(ComboboxAnchorContext)

  return (
    <div ref={setAnchorElement} className={cn('min-w-0', fullWidth ? 'w-full' : 'inline-block w-auto')}>
      <InputGroup
        className={cn(fullWidth ? 'w-full' : 'w-auto', open && 'hover:bg-input-background!', className)}
        style={
          open
            ? {
                borderColor: openBorderColor,
                boxShadow: `0 0 0 3px ${openShadowColor}`,
              }
            : undefined
        }
      >
        <ComboboxPrimitive.Input
          render={
            <InputGroupInput
              disabled={disabled}
              className={cn('text-[13px] placeholder:text-[13px]', open ? 'cursor-text' : 'cursor-pointer caret-transparent')}
            />
          }
          {...props}
        />
        <InputGroupAddon align="inline-end">
          {showTrigger && (
            <InputGroupButton
              size="icon-xs"
              variant="ghost"
              asChild
              data-slot="input-group-button"
              className={cn(
                'cursor-default! bg-transparent! group-has-data-[slot=combobox-clear]/input-group:hidden hover:bg-transparent! hover:text-inherit! data-pressed:bg-transparent dark:hover:bg-transparent!'
              )}
              disabled={disabled}
            >
              <ComboboxTrigger />
            </InputGroupButton>
          )}
          {showClear && <ComboboxClear disabled={disabled} />}
        </InputGroupAddon>
        {children}
      </InputGroup>
    </div>
  )
}

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props & Pick<ComboboxPrimitive.Positioner.Props, 'side' | 'align' | 'sideOffset' | 'alignOffset' | 'anchor'>) {
  const { anchorElement } = React.useContext(ComboboxAnchorContext)
  const resolvedAnchor = anchor ?? anchorElement

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={resolvedAnchor}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          className={cn(
            'group/combobox-content border-border bg-input-background text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:slide-out-to-top-2 data-[side=inline-end]:slide-out-to-left-2 data-[side=inline-start]:slide-out-to-right-2 data-[side=left]:slide-out-to-right-2 data-[side=right]:slide-out-to-left-2 data-[side=top]:slide-out-to-bottom-2 *:data-[slot=input-group]:border-input/30 *:data-[slot=input-group]:bg-input-background data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 relative z-50 max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-(--anchor-width) origin-(--transform-origin) cursor-default overflow-hidden rounded-md border shadow-md duration-200 *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:shadow-none',
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        'no-scrollbar max-h-[min(calc(--spacing(96)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0',
        className
      )}
      {...props}
    />
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        'focus:bg-accent data-highlighted:bg-accent relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.25 pr-1.5 pl-8 text-sm outline-hidden select-none focus:font-semibold focus:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:font-semibold data-highlighted:text-[#60a5fa] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={<span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center" />}
      >
        <IconCheck className="pointer-events-none size-3.5 stroke-3" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return <ComboboxPrimitive.Group data-slot="combobox-group" className={cn('scroll-my-1 p-1', className)} {...props} />
}

function ComboboxLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)}
      {...props}
    />
  )
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        'text-muted-foreground hidden w-full justify-center px-2 py-2 text-center text-sm group-data-empty/combobox-content:flex',
        className
      )}
      {...props}
    />
  )
}

function ComboboxSeparator({ className, ...props }: ComboboxPrimitive.Separator.Props) {
  return <ComboboxPrimitive.Separator data-slot="combobox-separator" className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />
}

function ComboboxChips({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> & ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(
        'border-input focus-within:border-ring focus-within:ring-ring/50 has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/20 dark:bg-input/30 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40 flex min-h-8 flex-wrap items-center gap-1 rounded-lg border bg-transparent bg-clip-padding px-2.5 py-1 text-sm transition-colors focus-within:ring-3 has-aria-invalid:ring-3 has-data-[slot=combobox-chip]:px-1',
        className
      )}
      {...props}
    />
  )
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  showRemove?: boolean
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        'bg-muted text-foreground flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0',
        className
      )}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          render={<Button variant="ghost" size="icon-xs" />}
          className="-ml-1 opacity-50 hover:opacity-100"
          data-slot="combobox-chip-remove"
        >
          <IconX className="pointer-events-none" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  )
}

function ComboboxChipsInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return <ComboboxPrimitive.Input data-slot="combobox-chip-input" className={cn('min-w-16 flex-1 outline-none', className)} {...props} />
}

function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null)
}

export {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
}
