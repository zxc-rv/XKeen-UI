import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAppContext } from "../../store"

export function DirtyModal({ onSaveAndSwitch, onDiscardAndSwitch }: { onSaveAndSwitch: () => void; onDiscardAndSwitch: () => void }) {
  const { state, dispatch } = useAppContext()
  const close = () => dispatch({ type: "SHOW_MODAL", modal: "showDirtyModal", show: false })

  return (
    <Dialog open={state.showDirtyModal} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="pb-3">Несохраненные изменения</DialogTitle>
          <DialogDescription>В файле есть несохраненные изменения. Сохранить их перед переключением?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="destructive" onClick={onDiscardAndSwitch}>
            Не сохранять
          </Button>
          <Button onClick={onSaveAndSwitch}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
