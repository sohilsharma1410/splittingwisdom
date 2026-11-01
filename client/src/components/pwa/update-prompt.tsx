import { RefreshCw } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-3 border-b border-border bg-surface px-4 py-2 text-sm"
    >
      <span className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 shrink-0 text-mint" aria-hidden="true" />
        A new version of SplittingWisdom is ready.
      </span>
      <Button size="sm" onClick={() => void updateServiceWorker(true)}>
        Refresh
      </Button>
    </div>
  );
}
