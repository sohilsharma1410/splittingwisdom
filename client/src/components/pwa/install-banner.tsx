import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "splittingwisdom-install-dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

export function InstallBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone] = useState(isStandalone);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Non-persistent dismissal is fine.
    }
  };

  if (dismissed || standalone) return null;

  const showAndroid = installEvent !== null;
  const showIos = !showAndroid && isIos();
  if (!showAndroid && !showIos) return null;

  return (
    <div role="region" aria-label="Install the app" className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 text-sm">
      {showAndroid ? (
        <>
          <Download className="h-4 w-4 shrink-0 text-mint" aria-hidden="true" />
          <span className="flex-1">Install SplittingWisdom on your phone for one-tap access.</span>
          <Button
            size="sm"
            onClick={async () => {
              await installEvent.prompt();
              const { outcome } = await installEvent.userChoice;
              setInstallEvent(null);
              if (outcome === "accepted") dismiss();
            }}
          >
            Install
          </Button>
        </>
      ) : (
        <>
          <Share className="h-4 w-4 shrink-0 text-mint" aria-hidden="true" />
          <span className="flex-1">To install: tap the Share button, then “Add to Home Screen”.</span>
        </>
      )}
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="rounded-lg p-1 text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
