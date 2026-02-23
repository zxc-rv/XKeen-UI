import { useEffect } from "react";
import { IconX, IconAlertCircle, IconCircleCheck } from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAppContext } from "../store";
import type { ToastMessage } from "../types";

function AlertItem({ alert }: { alert: ToastMessage }) {
  const { dispatch } = useAppContext();
  const isError = alert.type === "error";

  useEffect(() => {
    const timer = setTimeout(
      () => dispatch({ type: "REMOVE_TOAST", id: alert.id }),
      5000,
    );
    return () => clearTimeout(timer);
  }, [alert.id, dispatch]);

  return (
    <Alert
      variant={isError ? "destructive" : "default"}
      className="relative animate-in slide-in-from-bottom-4 fade-in"
    >
      {isError ? (
        <IconAlertCircle className="size-4.5" />
      ) : (
        <IconCircleCheck className="size-4.5" />
      )}

      <AlertTitle className="pb-1">{alert.title}</AlertTitle>

      {alert.body && <AlertDescription>{alert.body}</AlertDescription>}

      <button
        onClick={() => dispatch({ type: "REMOVE_TOAST", id: alert.id })}
        className="absolute right-2 top-2 rounded-md p-1 opacity-70 hover:opacity-100"
      >
        <IconX size={18} />
      </button>
    </Alert>
  );
}

export function Toast() {
  const { state } = useAppContext();

  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-90 flex-col gap-2">
      {state.toasts.map((alert) => (
        <AlertItem key={alert.id} alert={alert} />
      ))}
    </div>
  );
}
