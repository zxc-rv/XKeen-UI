import { Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn, copyText } from '@/lib/utils'
import { IconCheck, IconCopy } from '@tabler/icons-react'

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Content> & {
  copyTextValue?: string
}

function TooltipContent({ className, sideOffset = 0, children, copyTextValue, ...props }: TooltipContentProps) {
  const [copied, setCopied] = React.useState(false)

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    if (!copyTextValue || !(await copyText(copyTextValue))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 bg-foreground text-background z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs',
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
        <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-xs" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
