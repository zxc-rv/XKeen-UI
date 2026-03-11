import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { IconAlertCircle, IconCircleCheck, IconX } from '@tabler/icons-react'
import { AnimatePresence, LazyMotion, domMax, m } from 'framer-motion'
import { useAppContext, useToastContext } from '../../lib/store'
import type { ToastMessage } from '../../lib/types'

function AlertItem({ alert }: { alert: ToastMessage }) {
  const { dispatch } = useAppContext()
  const isError = alert.type === 'error'

  return (
    <m.div
      layout
      initial={{ opacity: 1, y: 16 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { duration: 0.35, ease: [0.215, 0.61, 0.355, 1] },
      }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      className="max-w-100px w-full"
    >
      <Alert variant={isError ? 'destructive' : 'default'} className="relative">
        {isError ? <IconAlertCircle className="size-4.5" /> : <IconCircleCheck className="size-4.5" />}
        <AlertTitle className="pb-1">{alert.title}</AlertTitle>
        {alert.body && <AlertDescription>{alert.body}</AlertDescription>}
        <button
          onClick={() => dispatch({ type: 'REMOVE_TOAST', id: alert.id })}
          className="absolute top-2 right-2 rounded-md p-1 opacity-70 hover:opacity-100"
        >
          <IconX size={18} />
        </button>
      </Alert>
    </m.div>
  )
}

export function Toast() {
  const { toasts } = useToastContext()

  return (
    <LazyMotion features={domMax}>
      <div className="fixed right-0 bottom-6 left-0 z-100 flex flex-col items-center gap-2 px-4 md:right-6 md:left-auto md:w-90 md:items-end md:px-0">
        <AnimatePresence>
          {toasts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} />
          ))}
        </AnimatePresence>
      </div>
    </LazyMotion>
  )
}
