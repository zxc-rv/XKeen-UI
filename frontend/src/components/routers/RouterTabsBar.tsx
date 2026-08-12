import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LOCAL_ROUTER_ID } from '../../lib/routers'
import { useRoutersStore } from '../../lib/routers-store'
import { cn } from '../../lib/utils'

export const tabBarSectionClass =
  'border-border bg-muted/30 shrink-0 border-b px-3 py-2.5 sm:px-4'

function OnlineDot({ online }: { online: boolean | null }) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        online === true && 'bg-green-500',
        online === false && 'bg-red-500',
        online === null && 'bg-muted-foreground/40'
      )}
      aria-hidden
    />
  )
}

export function MassConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  targets,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  targets: string[]
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ul className="bg-muted/40 max-h-48 list-inside list-disc overflow-y-auto rounded-md border px-3 py-2 text-sm">
          {targets.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            Продолжить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RouterOnlineDot({ id }: { id: string }) {
  const online = useRoutersStore((s) => s.online[id])
  return <OnlineDot online={id === LOCAL_ROUTER_ID ? (online ?? true) : (online ?? null)} />
}
