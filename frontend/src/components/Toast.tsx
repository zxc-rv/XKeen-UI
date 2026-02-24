import { useEffect } from "react";
import { IconX, IconAlertCircle, IconCircleCheck } from "@tabler/icons-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useAppContext } from "../store";
import type { ToastMessage } from "../types";
import { LazyMotion, domAnimation, m, AnimatePresence } from "framer-motion";

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
    <m.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      className="w-full max-w-100px"
    >
      <Alert variant={isError ? "destructive" : "default"} className="relative">
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
    </m.div>
  );
}

export function Toast() {
  const { state } = useAppContext();

  return (
    <LazyMotion features={domAnimation}>
      <div className="fixed bottom-6 left-0 right-0 z-100 flex flex-col items-center gap-2 px-4 md:left-auto md:right-6 md:items-end md:px-0 md:w-90">
        <AnimatePresence>
          {state.toasts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} />
          ))}
        </AnimatePresence>
      </div>
    </LazyMotion>
  );
}
