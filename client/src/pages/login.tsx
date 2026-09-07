import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Scale, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, ApiError } from "@/lib/query-client";
import { useToast } from "@/components/ui/toast";
import { useAuth, type AuthUser } from "@/hooks/use-auth";

export default function Login() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const nextPath = new URLSearchParams(search).get("next");
  const redirectTo = nextPath?.startsWith("/") ? nextPath : "/";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  // Navigate only once useAuth() itself reports the fresh user — never
  // right inside the mutation callback. ProtectedRoute reads useAuth() too,
  // and navigating a render or two before it sees the same fresh data made
  // it briefly redirect straight back to /login (this component's fresh
  // "success" state and the route tree's context value updated in
  // different renders), which looked like login silently doing nothing.
  useEffect(() => {
    if (loggedIn && user) navigate(redirectTo);
  }, [loggedIn, user, navigate, redirectTo]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<{ user: AuthUser }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    onSuccess: async (data) => {
      // The app's own startup fetch of ["auth", "me"] (expected to 401 while
      // logged out) can still be in flight or retrying here — most visibly
      // after a slow cold-start server response. If it resolves after this,
      // it silently overwrites the freshly-logged-in user with that stale
      // result. Cancel it first so it can never win the race.
      await queryClient.cancelQueries({ queryKey: ["auth", "me"] });
      queryClient.setQueryData(["auth", "me"], data);
      toast({ title: "Welcome back", variant: "success" });
      setLoggedIn(true);
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError ? err.message : "Something went wrong. Try again.",
      );
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    mutation.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-surface p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-mint text-mint-foreground">
            <Scale className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold">Log in to SplittingWisdom</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {formError && (
            <p role="alert" className="text-sm text-coral">
              {formError}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Log in
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          New here?{" "}
          <Link
            href={nextPath ? `/register?next=${encodeURIComponent(nextPath)}` : "/register"}
            className="text-mint hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
