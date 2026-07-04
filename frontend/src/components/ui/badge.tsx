import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { getRenderChildren, getRenderProp } from '@/components/ui/primitive-render'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'h-5 gap-1 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive overflow-hidden group/badge',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        sky: 'bg-sky-500/12 text-sky-700 dark:bg-sky-500/18 dark:text-sky-300',
        emerald: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/18 dark:text-emerald-300',
        amber: 'bg-amber-500/14 text-amber-700 dark:bg-amber-500/18 dark:text-amber-300',
        rose: 'bg-rose-500/12 text-rose-700 dark:bg-rose-500/18 dark:text-rose-300',
        destructive:
          'bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20',
        outline: 'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

function Badge({
  className,
  children,
  variant = 'default',
  asChild = false,
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  return useRender({
    defaultTagName: 'span',
    render: getRenderProp(asChild, children, render),
    props: mergeProps<'span'>(
      {
        'data-slot': 'badge',
        'data-variant': variant,
        className: cn(badgeVariants({ variant }), className),
        children: getRenderChildren(asChild, children),
      } as React.ComponentProps<'span'>,
      props
    ),
  })
}

export { Badge, badgeVariants }
