import { useState, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Scale, Loader2 } from "lucide-react";
import { registerSchema } from "@splittingwisdom/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, ApiError } from "@/lib/query-client";
import { useToast } from "@/components/ui/toast";
import type { AuthUser } from "@/hooks/use-auth";

export default function Register() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const nextPath = new URLSearchParams(search).get("next");
  const redirectTo = nextPath?.startsWith("/") ? nextPath : "/";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<{ user: AuthUser }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, displayName, password }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["auth", "me"], data);
      toast({ title: `Welcome, ${data.user.displayName}`, variant: "success" });
      navigate(redirectTo);
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

    const parsed = registerSchema.safeParse({ email, displayName, password });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0].message);
      return;
    }

    mutation.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-surface p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-mint text-mint-foreground">
            <Scale className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold">Create your account</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="register-name">Name</Label>
            <Input
              id="register-name"
              autoComplete="name"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="register-email">Email</Label>
            <Input
              id="register-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="register-password">Password</Label>
            <Input
              id="register-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>

          {formError && (
            <p role="alert" className="text-sm text-coral">
              {formError}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Create account
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href={nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login"}
            className="text-mint hover:underline"
          >
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
