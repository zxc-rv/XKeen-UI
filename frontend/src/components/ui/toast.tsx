import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { IconAlertCircle, IconBrandGithub, IconCircleCheck, IconX } from '@tabler/icons-react'
import { AnimatePresence, LazyMotion, domMax, m } from 'framer-motion'
import { useAppActions, useToasts } from '../../lib/store'
import type { ToastMessage } from '../../lib/types'

function AlertItem({ alert }: { alert: ToastMessage }) {
  const { dispatch } = useAppActions()
  const isError = alert.type === 'error'
  const isWarning = alert.type === 'warning'

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
      <Alert
        variant={isError ? 'destructive' : 'default'}
        className={
          isWarning ? 'relative overflow-hidden text-yellow-600 dark:text-amber-400' : 'relative overflow-hidden'
        }
      >
        {isError || isWarning ? (
          <IconAlertCircle className={isWarning ? 'size-4.5 text-yellow-600 dark:text-amber-400' : 'size-4.5'} />
        ) : (
          <IconCircleCheck className="size-4.5" />
        )}
        <AlertTitle className={isWarning ? 'pb-1 text-yellow-600 dark:text-amber-400' : 'pb-1'}>{alert.title}</AlertTitle>
        {alert.body && (
          <AlertDescription className={isWarning ? 'text-yellow-600/90 dark:text-amber-400/90' : undefined}>
            {alert.body}
          </AlertDescription>
        )}
        <AlertAction className="flex items-center gap-1">
          {alert.action && (
            <a
              href={alert.action.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md p-1 opacity-70 hover:opacity-100"
            >
              <IconBrandGithub size={18} />
            </a>
          )}
          <button
            onClick={() => dispatch({ type: 'REMOVE_TOAST', id: alert.id })}
            className="rounded-md p-1 opacity-70 hover:opacity-100"
          >
            <IconX size={18} />
          </button>
        </AlertAction>
      </Alert>
    </m.div>
  )
}

export function Toast() {
  const toasts = useToasts()

  return (
    <LazyMotion features={domMax}>
      <div className="fixed right-0 bottom-6 left-0 z-45 flex flex-col items-center gap-2 px-4 md:right-6 md:left-auto md:w-90 md:items-end md:px-0">
        <AnimatePresence>
          {toasts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} />
          ))}
        </AnimatePresence>
      </div>
    </LazyMotion>
  )
}
