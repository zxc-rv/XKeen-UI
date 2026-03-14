import { Select as SelectPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { IconCheck, IconChevronDown, IconChevronUp, IconSelector } from '@tabler/icons-react'

const CLOSE_ANIMATION_MS = 200

type SelectAnimationContext = {
  isClosing: boolean
  registerPosition: (position: string) => void
}
const SelectAnimationContext = React.createContext<SelectAnimationContext>({
  isClosing: false,
  registerPosition: () => {},
})

function Select({ open: openProp, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const [renderOpen, setRenderOpen] = React.useState(() => openProp ?? defaultOpen ?? false)
  const [isClosing, setIsClosing] = React.useState(false)
  const closeTimeoutRef = React.useRef<number | null>(null)
  const positionRef = React.useRef<string>('item-aligned')
  const isControlled = openProp !== undefined

  const registerPosition = React.useCallback((position: string) => {
    positionRef.current = position
  }, [])

  const clearCloseTimeout = React.useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    if (positionRef.current !== 'popper') {
      setRenderOpen(false)
      return
    }
    clearCloseTimeout()
    setIsClosing(true)
    closeTimeoutRef.current = window.setTimeout(() => {
      setRenderOpen(false)
      setIsClosing(false)
      closeTimeoutRef.current = null
    }, CLOSE_ANIMATION_MS)
  }, [clearCloseTimeout])

  React.useEffect(() => () => clearCloseTimeout(), [clearCloseTimeout])

  React.useEffect(() => {
    if (!isControlled) return
    if (openProp) {
      clearCloseTimeout()
      setIsClosing(false)
      setRenderOpen(true)
    } else if (renderOpen && !isClosing) {
      scheduleClose()
    }
  }, [clearCloseTimeout, isClosing, isControlled, openProp, renderOpen, scheduleClose])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        clearCloseTimeout()
        setIsClosing(false)
        setRenderOpen(true)
      } else if (renderOpen && !isClosing) {
        scheduleClose()
      }
      onOpenChange?.(nextOpen)
    },
    [clearCloseTimeout, isClosing, onOpenChange, renderOpen, scheduleClose]
  )

  return (
    <SelectAnimationContext.Provider value={React.useMemo(() => ({ isClosing, registerPosition }), [isClosing, registerPosition])}>
      <SelectPrimitive.Root data-slot="select" open={renderOpen} onOpenChange={handleOpenChange} {...props} />
    </SelectAnimationContext.Provider>
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
  const { isClosing } = React.useContext(SelectAnimationContext)

  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      data-popper={popper || undefined}
      data-closing={isClosing || undefined}
      className={cn(
        "bg-input-background hover:bg-input-background-hover data-[state=open]:hover:bg-input-background data-closing:hover:bg-input-background flex w-fit cursor-pointer items-center justify-between gap-1.5 rounded-md border py-2 pr-2 pl-2.5 text-sm whitespace-nowrap shadow-xs [transition-property:background-color,border-color,box-shadow] duration-200 outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 data-popper:data-[state=open]:not-data-closing:border-[#60a5fa] data-popper:data-[state=open]:not-data-closing:[box-shadow:0_0_0_3px_rgba(59,130,246,0.15)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
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
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const { isClosing, registerPosition } = React.useContext(SelectAnimationContext)

  React.useLayoutEffect(() => {
    registerPosition(position)
  }, [position, registerPosition])

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-align-trigger={position === 'item-aligned'}
        className={cn(
          'border-border bg-input-background text-popover-foreground relative z-50 max-h-(--radix-select-content-available-height) min-w-30 origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md',
          position === 'item-aligned' &&
            (isClosing
              ? 'animate-out fade-out-0 zoom-out-95 fill-mode-[forwards] pointer-events-none duration-200'
              : 'animate-in fade-in-0 zoom-in-95 duration-200'),
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          position === 'popper' &&
            (isClosing
              ? 'animate-out fade-out-0 data-[side=bottom]:slide-out-to-top-2 data-[side=left]:slide-out-to-right-2 data-[side=right]:slide-out-to-left-2 data-[side=top]:slide-out-to-bottom-2 fill-mode-[forwards] pointer-events-none duration-200'
              : 'animate-in fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 duration-200'),
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className={cn(position === 'popper' && 'h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)')}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label data-slot="select-label" className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)} {...props} />
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.25 pr-8 pl-1.5 text-sm outline-hidden select-none focus:font-semibold focus:text-[#60a5fa] not-data-[variant=destructive]:focus:**:text-[#60a5fa] data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
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

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("bg-popover z-10 flex cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      <IconChevronUp />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("bg-popover z-10 flex cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      <IconChevronDown />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
