import { QueryClient } from "@tanstack/react-query";

// In production the client and API are proxied to the same origin (see
// client/vercel.json) specifically so the session cookie is first-party —
// mobile Safari (always) and an increasing share of Chrome/Firefox installs
// silently refuse to store a genuinely cross-site cookie no matter how
// correctly SameSite=None/Secure is set server-side, which is exactly what
// broke login-that-doesn't-stick on every phone browser it was tried on.
// So the default here is "" (relative — same origin), not the old
// cross-origin Render URL; only local dev (talking to a local server on a
// different port, where same-origin proxying doesn't apply) needs a default.
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://localhost:4000" : "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  // FormData bodies (receipt image uploads) must NOT get a manual
  // Content-Type — the browser sets its own with the multipart boundary.
  const isFormData = init?.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include",
      headers: init?.body && !isFormData ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch {
    // fetch() throws for network-level failures (offline, DNS, CORS) rather
    // than resolving with a response — surface that distinctly from a real
    // API error so "can't reach the server" never looks like "wrong
    // password" or a generic, unactionable failure.
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;

  if (!res.ok) {
    const message = body?.error?.message ?? res.statusText;
    throw new ApiError(res.status, message);
  }

  return body?.data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
