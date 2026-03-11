import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { IconAlertTriangle } from '@tabler/icons-react'
import { useModalContext } from '../../lib/store'

export function CommentsWarningModal() {
  const { modals, dispatch } = useModalContext()

  function close() {
    dispatch({
      type: 'SHOW_MODAL',
      modal: 'showCommentsWarningModal',
      show: false,
    })
    dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: null })
  }

  function confirm() {
    modals.pendingSaveAction?.()
    close()
  }

  return (
    <Dialog open={modals.showCommentsWarningModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm bg-[#0F1629]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 pb-3">
            <IconAlertTriangle size={23} className="text-amber-400" />
            Предупреждение
          </DialogTitle>
          <DialogDescription>
            В конфигурации найдены комментарии. При сохранении через GUI они будут <strong>утеряны</strong>. Продолжить?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Отмена
          </Button>
          <Button onClick={confirm}>Продолжить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
