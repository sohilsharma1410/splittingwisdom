import type { ReactNode } from "react";
import { ArrowRightLeft, CloudOff, Loader2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useServerStatus } from "@/hooks/use-server-status";

function Bar({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-3 border-b border-border bg-surface px-4 py-2 text-sm"
    >
      <span className="flex items-center gap-2">
        {icon}
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}

export function ServerStatusBanner() {
  const { role, status, switchNow } = useServerStatus();

  if (status.kind === "offline") {
    return (
      <Bar icon={<WifiOff className="h-4 w-4 shrink-0 text-coral-ink" aria-hidden="true" />}>
        You're offline. Changes can't be saved until you're back online.
      </Bar>
    );
  }
  if (status.kind === "redirecting") {
    return (
      <Bar icon={<Loader2 className="h-4 w-4 shrink-0 animate-spin text-mint-ink" aria-hidden="true" />}>
        {status.target === "backup" ? "Main server unreachable — opening the backup app…" : "Main server is back — switching…"}
      </Bar>
    );
  }
  if (status.kind === "primary-down") {
    return (
      <Bar
        icon={<CloudOff className="h-4 w-4 shrink-0 text-coral-ink" aria-hidden="true" />}
        action={
          <Button size="sm" variant="outline" onClick={switchNow}>
            Open backup
          </Button>
        }
      >
        Main server unreachable.
      </Bar>
    );
  }
  if (status.kind === "primary-back") {
    return (
      <Bar
        icon={<ArrowRightLeft className="h-4 w-4 shrink-0 text-mint-ink" aria-hidden="true" />}
        action={
          <Button size="sm" onClick={switchNow}>
            Switch
          </Button>
        }
      >
        Main server is back.
      </Bar>
    );
  }
  if (role === "standby") {
    return (
      <Bar icon={<CloudOff className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}>
        Backup mode — your changes are copied back to the main server automatically. You may need to log in again.
      </Bar>
    );
  }
  return null;
}
