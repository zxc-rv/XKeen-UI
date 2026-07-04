import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { getRenderChildren, getRenderProp } from '@/components/ui/primitive-render'
import { cn, copyText } from '@/lib/utils'
import { IconCheck, IconCopy } from '@tabler/icons-react'

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

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ asChild, children, render, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger> & { asChild?: boolean }) {
  return (
    <TooltipPrimitive.Trigger data-slot="tooltip-trigger" render={getRenderProp(asChild, children, render)} {...props}>
      {getRenderChildren(asChild, children)}
    </TooltipPrimitive.Trigger>
  )
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Popup> &
  Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset'> & {
    copyTextValue?: string
  }

function TooltipContent({ className, sideOffset = 0, side, align, alignOffset, children, copyTextValue, ...props }: TooltipContentProps) {
  const [copied, setCopied] = React.useState(false)

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
            'bg-foreground text-background z-50 w-fit origin-(--transform-origin) rounded-md px-3 py-1.5 text-xs data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className
          )}
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
