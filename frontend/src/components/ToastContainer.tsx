import { useEffect } from "react"
import { IconX, IconCheck, IconAlertCircle } from "@tabler/icons-react"
import { useAppContext } from "../store"
import type { ToastMessage } from "../types"

function Toast({ toast }: { toast: ToastMessage }) {
  const { dispatch } = useAppContext()

  useEffect(() => {
    const t = setTimeout(() => dispatch({ type: "REMOVE_TOAST", id: toast.id }), 5000)
    return () => clearTimeout(t)
  }, [toast.id, dispatch])

  const isError = toast.type === "error"

  return (
    <div
      role="alert"
      className={`
      relative flex w-90 items-start gap-3 rounded-lg border p-4 shadow-lg
      animate-in slide-in-from-bottom-4 fade-in duration-200
      bg-card
      ${isError ? "border-destructive/50 text-destructive" : "border-border"}
    `}
    >
      <span className={`shrink-0 ${isError ? "text-destructive" : "text-green-500"}`}>
        {isError ? <IconAlertCircle size={16} /> : <IconCheck size={16} />}
      </span>
      <div>
        <p className="text-sm font-medium leading-none text-foreground">{toast.title}</p>
        {toast.body && <p className="text-sm text-muted-foreground pt-2">{toast.body}</p>}
      </div>
      <button
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-70 hover:opacity-100 transition-opacity"
        onClick={() => dispatch({ type: "REMOVE_TOAST", id: toast.id })}
      >
        <IconX size={16} />
      </button>
    </div>
  )
}

export function ToastContainer() {
  const { state } = useAppContext()
  return (
    <div className="fixed bottom-6 right-6 z-100 flex flex-col gap-2">
      {state.toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  )
}
