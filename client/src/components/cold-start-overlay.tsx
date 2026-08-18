import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { API_BASE_URL } from "@/lib/query-client";

/**
 * Render's free tier spins the server down after ~15 minutes idle; the
 * first request after that can take 30-60s to wake it back up. Ping
 * /api/health on load and show a friendly overlay only if it's actually
 * slow, so this stays invisible on a warm server.
 */
export function ColdStartOverlay() {
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) setWaking(true);
    }, 2500);

    fetch(`${API_BASE_URL}/api/health`)
      .catch(() => {})
      .finally(() => {
        settled = true;
        clearTimeout(timer);
        setWaking(false);
      });

    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!waking) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-background/95 px-4 text-center backdrop-blur-sm">
      <Loader2 className="h-8 w-8 animate-spin text-mint" aria-hidden="true" />
      <p className="text-sm font-medium">Waking the server…</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        The free hosting tier sleeps after a while. This can take up to a minute — thanks for
        your patience.
      </p>
    </div>
  );
}
