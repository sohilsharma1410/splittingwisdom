import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { SettleDialog, type SettleTarget } from "@/components/settlements/settle-dialog";

interface SettleContextValue {
  openSettle: (target: SettleTarget) => void;
}

const SettleContext = createContext<SettleContextValue | undefined>(undefined);

const IDLE_TARGET: SettleTarget = {
  displayName: "",
  iPay: true,
  outstanding: 0,
  buildRequest: () => {
    throw new Error("No settlement target is open.");
  },
};

/**
 * One settlement dialog for the whole app, opened from anywhere. It can't
 * live inside the row or button that opened it: a payment that settles
 * someone in full makes that row disappear, which would tear the dialog down
 * before it could show its confirmation.
 */
export function SettleProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<SettleTarget>(IDLE_TARGET);
  const [open, setOpen] = useState(false);

  const openSettle = useCallback((next: SettleTarget) => {
    setTarget(next);
    setOpen(true);
  }, []);

  const value = useMemo(() => ({ openSettle }), [openSettle]);

  return (
    <SettleContext.Provider value={value}>
      {children}
      <SettleDialog open={open} onOpenChange={setOpen} target={target} />
    </SettleContext.Provider>
  );
}

export function useSettle() {
  const ctx = useContext(SettleContext);
  if (!ctx) throw new Error("useSettle must be used within SettleProvider");
  return ctx;
}
