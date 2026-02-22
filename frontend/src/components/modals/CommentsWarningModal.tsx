import { IconAlertTriangle } from '@tabler/icons-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppContext } from '../../store'

export function CommentsWarningModal() {
  const { state, dispatch } = useAppContext()

  function close() {
    dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: false })
    dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: null })
  }

  function confirm() {
    state.pendingSaveAction?.()
    close()
  }

  return (
    <Dialog open={state.showCommentsWarningModal} onOpenChange={open => !open && close()}>
      <DialogContent className="bg-[#0F1629] max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconAlertTriangle size={18} className="text-amber-500" />
            Предупреждение
          </DialogTitle>
          <DialogDescription>
            В конфигурации найдены комментарии. При сохранении через GUI они будут <strong>утеряны</strong>. Продолжить?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Отмена</Button>
          <Button onClick={confirm}>Продолжить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
