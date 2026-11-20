import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn, copyText } from '@/lib/utils'
import { IconCheck, IconCopy } from '@tabler/icons-react'

const MOBILE_MEDIA_QUERY = '(max-width: 767px)'

function isMobileViewport() {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches
}

function TooltipProvider({
  delayDuration = 0,
  skipDelayDuration,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Provider>, 'delay'> & {
  delayDuration?: number
  skipDelayDuration?: number
}) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delayDuration} {...props} />
}

type TooltipRootProps = React.ComponentProps<typeof TooltipPrimitive.Root>
type TooltipActions = NonNullable<TooltipRootProps['actionsRef']> extends React.RefObject<infer T> ? T : never

const TooltipCloseContext = React.createContext<(() => void) | null>(null)

function Tooltip({ children, actionsRef, ...props }: TooltipRootProps) {
  const fallbackActionsRef = React.useRef<TooltipActions | null>(null)
  const resolvedActionsRef = actionsRef ?? fallbackActionsRef
  const close = React.useCallback(() => resolvedActionsRef.current?.close(), [resolvedActionsRef])

  const content =
    typeof children === 'function' ? (
      (payload: unknown) => (
        <TooltipCloseContext.Provider value={close}>
          {(children as (payload: unknown) => React.ReactNode)(payload)}
        </TooltipCloseContext.Provider>
      )
    ) : (
      <TooltipCloseContext.Provider value={close}>{children}</TooltipCloseContext.Provider>
    )

  return (
    <TooltipPrimitive.Root data-slot="tooltip" actionsRef={resolvedActionsRef} {...props}>
      {content as TooltipRootProps['children']}
    </TooltipPrimitive.Root>
  )
}

function TooltipTrigger({ children, render, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger data-slot="tooltip-trigger" render={render} onFocus={(event) => event.preventBaseUIHandler()} {...props}>
      {children}
    </TooltipPrimitive.Trigger>
  )
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Popup> &
  Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset'> & {
    copyTextValue?: string
  }

function TooltipContent({
  className,
  sideOffset = 0,
  side,
  align,
  alignOffset,
  children,
  copyTextValue,
  onClick,
  onPointerDown,
  ...props
}: TooltipContentProps) {
  const [copied, setCopied] = React.useState(false)
  const closeTooltip = React.useContext(TooltipCloseContext)

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    if (!copyTextValue || !(await copyText(copyTextValue))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} className="isolate z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'bg-foreground text-background data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 w-fit origin-(--transform-origin) rounded-md px-3 py-1.5 text-xs pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]',
            className
          )}
          onClick={(event) => {
            onClick?.(event)
            event.stopPropagation()
            if (!isMobileViewport()) return
            event.preventDefault()
            closeTooltip?.()
          }}
          onPointerDown={(event) => {
            onPointerDown?.(event)
            event.stopPropagation()
          }}
          {...props}
        >
          {copyTextValue ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0">{children}</div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-background/70 hover:bg-background/10 hover:text-background size-6 shrink-0"
                onClick={handleCopy}
              >
                {copied ? <IconCheck size={13} className="text-green-400" /> : <IconCopy size={13} />}
              </Button>
            </div>
          ) : (
            children
          )}
          <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-xs data-[side=bottom]:top-1 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
