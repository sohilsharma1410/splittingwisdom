import { ChevronLeft } from "lucide-react";
import { useLocation } from "wouter";

/**
 * Goes back in browser history when there's somewhere to go back to (the
 * common case — arrived via a link from Dashboard/Activity/Group/etc.),
 * otherwise falls back to a fixed route (e.g. a bill opened directly from a
 * bookmark or shared link with no prior in-app history).
 */
export function BackButton({ fallbackHref }: { fallbackHref: string }) {
  const [, navigate] = useLocation();

  function handleBack() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate(fallbackHref);
    }
  }

  return (
    <button
      onClick={handleBack}
      aria-label="Go back"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
    >
      <ChevronLeft className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
