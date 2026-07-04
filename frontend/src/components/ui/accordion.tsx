import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'

type AccordionProps = Omit<React.ComponentProps<typeof AccordionPrimitive.Root>, 'value' | 'defaultValue' | 'onValueChange'> & {
  type?: 'single' | 'multiple'
  collapsible?: boolean
  value?: string | string[]
  defaultValue?: string | string[]
  onValueChange?: (value: any) => void
}

function toAccordionValue(value: string | string[] | undefined) {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

function fromAccordionValue(value: unknown[], multiple: boolean) {
  return multiple ? (value as string[]) : ((value[0] as string | undefined) ?? '')
}

function Accordion({ className, type, value, defaultValue, onValueChange, ...props }: AccordionProps) {
  const multiple = type === 'multiple'

  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      multiple={multiple || undefined}
      value={toAccordionValue(value)}
      defaultValue={toAccordionValue(defaultValue)}
      onValueChange={onValueChange ? (nextValue) => onValueChange(fromAccordionValue(nextValue, multiple)) : undefined}
      className={cn('flex w-full flex-col', className)}
      {...props}
    />
  )
}

function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn('not-last:border-b', className)} {...props} />
}

function AccordionTrigger({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'focus-visible:ring-ring/50 focus-visible:border-ring focus-visible:after:border-ring **:data-[slot=accordion-trigger-icon]:text-muted-foreground group/accordion-trigger relative flex flex-1 items-start justify-between rounded-md border border-transparent py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4',
          className
        )}
        {...props}
      >
        {children}
        <IconChevronDown
          data-slot="accordion-trigger-icon"
          className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
        />
        <IconChevronUp
          data-slot="accordion-trigger-icon"
          className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Panel>) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0"
      {...props}
    >
      <div
        className={cn(
          '[&_a]:hover:text-foreground pt-0 pb-4 [&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-4',
          className
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger }
