import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ProbeTracker,
  buildRedirectUrl,
  canAutoSwitch,
  detectRole,
  extractSwitchStamp,
  isPrimaryBack,
  isPrimaryDown,
  probeHealth,
  probeRecording,
  stampRedirectUrl,
  probePrimaryReady,
  type NodeRole,
} from "@/lib/failover";

export type ServerStatus =
  | { kind: "ok" }
  | { kind: "offline" }
  | { kind: "redirecting"; target: "backup" | "main" }
  | { kind: "primary-down" }
  | { kind: "primary-back" };

interface ServerStatusValue {
  role: NodeRole;
  status: ServerStatus;
  /** Switch to the other copy of the app now (keeps the current page). */
  switchNow: () => void;
}

const LAST_SWITCH_KEY = "splittingwisdom-last-switch";
const PRIMARY_POLL_MS = 30_000;
const STANDBY_POLL_MS = 60_000;

const config = {
  primaryUrl: import.meta.env.VITE_PRIMARY_URL,
  standbyUrl: import.meta.env.VITE_STANDBY_URL,
};

function readLastSwitch(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_SWITCH_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function storeLastSwitch(stamp: number) {
  try {
    window.localStorage.setItem(LAST_SWITCH_KEY, String(stamp));
  } catch {
    // Storage can be unavailable (private mode); the guard just won't persist.
  }
}

/** Run once at startup: adopt a switch timestamp carried in the URL, then hide it. */
export function consumeSwitchStamp() {
  const { stamp, cleanedHref } = extractSwitchStamp(window.location.href);
  if (cleanedHref === window.location.href) return;
  if (stamp !== null) storeLastSwitch(stamp);
  window.history.replaceState(window.history.state, "", cleanedHref);
}

const ServerStatusContext = createContext<ServerStatusValue>({
  role: "unknown",
  status: { kind: "ok" },
  switchNow: () => {},
});

export function ServerStatusProvider({ children }: { children: ReactNode }) {
  const role = useMemo(() => detectRole(config, window.location.origin), []);
  const [status, setStatus] = useState<ServerStatus>({ kind: "ok" });
  const [online, setOnline] = useState(() => navigator.onLine);
  const redirecting = useRef(false);

  const otherBase = role === "primary" ? config.standbyUrl : config.primaryUrl;

  const goToOther = useCallback(() => {
    if (!otherBase || redirecting.current) return;
    redirecting.current = true;
    const now = Date.now();
    storeLastSwitch(now);
    window.location.replace(stampRedirectUrl(buildRedirectUrl(otherBase, window.location), now));
  }, [otherBase]);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (role === "unknown") return;
    let cancelled = false;
    const tracker = new ProbeTracker();
    const redirectLater = (target: "backup" | "main", delayMs: number) => {
      setStatus({ kind: "redirecting", target });
      window.setTimeout(() => !cancelled && goToOther(), delayMs);
    };

    async function check(cold: boolean) {
      if (cancelled || redirecting.current) return;
      if (!navigator.onLine) return;

      if (role === "primary") {
        // Probe our own origin: if this copy of the app loaded from cache but
        // its server is gone, that is exactly the outage to fail over from.
        const ok = await probeRecording(() => probeHealth(window.location.origin), tracker, cold ? 2 : 1);
        if (cancelled) return;
        if (ok) {
          setStatus({ kind: "ok" });
        } else if (isPrimaryDown({ role, failures: tracker.failures, online: navigator.onLine })) {
          if (cold && canAutoSwitch(readLastSwitch(), Date.now())) redirectLater("backup", 1200);
          else setStatus({ kind: "primary-down" });
        }
        return;
      }

      // standby: is the main server back AND caught up?
      const ready = await probePrimaryReady(config.primaryUrl!);
      if (cancelled) return;
      tracker.record(ready);
      if (cold && ready && canAutoSwitch(readLastSwitch(), Date.now())) {
        redirectLater("main", 800);
      } else if (isPrimaryBack({ role, successes: tracker.successes })) {
        setStatus({ kind: "primary-back" });
      } else if (!ready) {
        setStatus({ kind: "ok" });
      }
    }

    void check(true);
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void check(false);
      },
      role === "primary" ? PRIMARY_POLL_MS : STANDBY_POLL_MS,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [role, goToOther]);

  const value = useMemo<ServerStatusValue>(
    () => ({ role, status: !online ? { kind: "offline" } : status, switchNow: goToOther }),
    [role, status, online, goToOther],
  );

  return <ServerStatusContext.Provider value={value}>{children}</ServerStatusContext.Provider>;
}

export function useServerStatus() {
  return useContext(ServerStatusContext);
}
