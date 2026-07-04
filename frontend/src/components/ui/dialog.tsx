import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { getRenderChildren, getRenderProp } from '@/components/ui/primitive-render'
import { cn } from '@/lib/utils'
import { IconX } from '@tabler/icons-react'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  asChild,
  children,
  render,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger> & { asChild?: boolean }) {
  return (
    <DialogPrimitive.Trigger data-slot="dialog-trigger" render={getRenderProp(asChild, children, render)} {...props}>
      {getRenderChildren(asChild, children)}
    </DialogPrimitive.Trigger>
  )
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ asChild, children, render, ...props }: React.ComponentProps<typeof DialogPrimitive.Close> & { asChild?: boolean }) {
  return (
    <DialogPrimitive.Close data-slot="dialog-close" render={getRenderProp(asChild, children, render)} {...props}>
      {getRenderChildren(asChild, children)}
    </DialogPrimitive.Close>
  )
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className={cn(
          'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 isolate z-50',
          'bg-[#020817]/80 duration-200',
          className
        )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & {
  showCloseButton?: boolean
  onEscapeKeyDown?: (event: KeyboardEvent) => void
}) {
  void onEscapeKeyDown

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'bg-card data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-xl p-5 text-sm ring-1 duration-200 outline-none sm:max-w-md',
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" render={<Button variant="ghost" className="text-ring hover:bg-muted! absolute top-4 right-4 transition-colors hover:text-white" size="icon" />}>
            <IconX className="size-6" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props}>
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-xl leading-none font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  asChild,
  children,
  render,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description> & { asChild?: boolean }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      render={getRenderProp(asChild, children, render)}
      className={cn('text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3', className)}
      {...props}
    >
      {getRenderChildren(asChild, children)}
    </DialogPrimitive.Description>
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
