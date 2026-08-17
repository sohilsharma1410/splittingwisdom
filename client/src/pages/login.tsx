import { Scale } from "lucide-react";
import { Link } from "wouter";

export default function Login() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-surface p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-mint text-mint-foreground">
            <Scale className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold">Log in to SplittingWisdom</h1>
          <p className="text-sm text-muted-foreground">
            Login form arrives in Checkpoint B.
          </p>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          New here?{" "}
          <Link href="/register" className="text-mint hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
