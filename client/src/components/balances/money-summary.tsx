import { AlertCircle, CheckCircle2, TrendingDown, TrendingUp } from "lucide-react";
import { formatPaise } from "@splittingwisdom/shared";
import { cn } from "@/lib/utils";

interface MoneySummaryProps {
  /** Shown only on a group page: everything the group spent. */
  groupSpent?: number;
  /** Part of groupSpent assigned to nobody yet. */
  unassigned?: number;
  share: number;
  paid: number;
  /** After settlements. Positive: the others owe you. */
  net: number;
}

function Figure({ label, amount, hint }: { label: string; amount: number; hint: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="tabular-currency mt-1 text-xl font-semibold">{formatPaise(amount)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Your share, what you paid, and where that leaves you. Every figure is derived from the bills
 * (shared/lib/balance.ts summarizeMember), never stored.
 */
export function MoneySummary({ groupSpent, unassigned = 0, share, paid, net }: MoneySummaryProps) {
  const settled = net === 0;
  const owedToYou = net > 0;
  const NetIcon = settled ? CheckCircle2 : owedToYou ? TrendingUp : TrendingDown;

  return (
    <section aria-label="Your money" className="space-y-3">
      <div
        className={cn(
          "rounded-xl border p-4",
          settled && "border-border bg-surface",
          !settled && owedToYou && "border-success-ink/30 bg-success-ink/5",
          !settled && !owedToYou && "border-coral-ink/30 bg-coral-ink/5",
        )}
      >
        <p className="text-sm text-muted-foreground">Net balance</p>
        <p
          className={cn(
            "mt-1 flex items-center gap-2 text-2xl font-semibold",
            settled && "text-muted-foreground",
            !settled && owedToYou && "text-success-ink",
            !settled && !owedToYou && "text-coral-ink",
          )}
        >
          <NetIcon className="h-6 w-6 shrink-0" aria-hidden="true" />
          {settled ? (
            "All settled"
          ) : (
            <span>
              {owedToYou ? "You get back " : "You owe "}
              <span className="tabular-currency">{formatPaise(Math.abs(net))}</span>
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          What you paid minus your share, after any settle-ups.
        </p>
      </div>

      <div className={cn("grid grid-cols-2 gap-3", groupSpent !== undefined && "sm:grid-cols-3")}>
        {groupSpent !== undefined && (
          <div className="col-span-2 sm:col-span-1">
            <Figure label="Group spent" amount={groupSpent} hint="All bills, everyone together." />
          </div>
        )}
        <Figure label="Your share" amount={share} hint="What you had, tax and tip included." />
        <Figure label="You paid" amount={paid} hint="Bills you paid for." />
      </div>

      {unassigned > 0 && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {formatPaise(unassigned)} of the group's bills isn't assigned to anyone yet, so it isn't in
          anyone's share.
        </p>
      )}
    </section>
  );
}
