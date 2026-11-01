import { useState } from "react";
import { Link } from "wouter";
import { SettleButton } from "@/components/settlements/settle-button";
import { format } from "date-fns";
import { Scale, TrendingUp, TrendingDown, CheckCircle2, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { useBalances, type BalanceSummaryItem } from "@/hooks/use-balances";
import { formatPaise } from "@splittingwisdom/shared";
import { cn } from "@/lib/utils";

type Filter = "all" | "owed" | "owe";

function BalanceCard({ balance }: { balance: BalanceSummaryItem }) {
  const isOwedToMe = balance.netAmount > 0;
  const isSettled = balance.netAmount === 0;

  return (
    <div className="relative flex items-center gap-3 rounded-xl border border-border bg-surface p-4 pr-20 card-lift md:pr-4">
      <Link
        href={`/balance/${balance.personId}`}
        aria-label={`View balance with ${balance.displayName}`}
        className="absolute inset-0 rounded-xl"
      />
      <InitialsAvatar name={balance.displayName} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{balance.displayName}</p>
        <p className="text-xs text-muted-foreground">
          Last activity {format(new Date(balance.lastActivity), "d MMM yyyy")}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span
          className={cn(
            "flex items-center gap-1 text-sm font-semibold",
            isSettled && "text-muted-foreground",
            !isSettled && isOwedToMe && "text-success-ink",
            !isSettled && !isOwedToMe && "text-coral-ink",
          )}
        >
          {isSettled ? (
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          ) : isOwedToMe ? (
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <TrendingDown className="h-4 w-4" aria-hidden="true" />
          )}
          {isSettled ? "Settled" : formatPaise(Math.abs(balance.netAmount))}
        </span>
        <span className="text-xs text-muted-foreground">
          {isSettled ? "" : isOwedToMe ? "owes you" : "you owe"}
        </span>
        {!isSettled && (
          <SettleButton
            personId={balance.personId}
            displayName={balance.displayName}
            netAmount={balance.netAmount}
          />
        )}
      </div>
    </div>
  );
}

export default function Balances() {
  const { data, isLoading, isError, refetch } = useBalances();
  const [filter, setFilter] = useState<Filter>("all");

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !data) {
    return <ErrorState message="Couldn't load your balances." onRetry={() => refetch()} />;
  }

  const filtered = data.balances.filter((b) => {
    if (filter === "owed") return b.netAmount > 0;
    if (filter === "owe") return b.netAmount < 0;
    return true;
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Balances</h1>
        <p className="mt-1 text-muted-foreground">Who owes you, and who you owe.</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm text-muted-foreground">Net balance</p>
          <p
            className={cn(
              "tabular-currency mt-1 text-2xl font-semibold",
              data.netBalance > 0 && "text-success-ink",
              data.netBalance < 0 && "text-coral-ink",
            )}
          >
            {data.netBalance === 0 ? "Settled" : formatPaise(Math.abs(data.netBalance))}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm text-muted-foreground">Owed to you</p>
          <p className="tabular-currency mt-1 text-2xl font-semibold text-success-ink">
            {formatPaise(data.totalOwedToMe)}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm text-muted-foreground">You owe</p>
          <p className="tabular-currency mt-1 text-2xl font-semibold text-coral-ink">
            {formatPaise(data.totalIOwe)}
          </p>
        </div>
      </div>

      {data.simplifiableGroups.length > 0 && (
        <section className="space-y-2 rounded-xl border border-border bg-surface p-4" aria-label="Fewer payments possible">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-mint-ink" aria-hidden="true" />
            Fewer payments possible
          </h2>
          <ul className="space-y-1">
            {data.simplifiableGroups.map((g) => (
              <li key={g.groupId}>
                <Link href={`/group/${g.groupId}#settle-up`} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-foreground/5">
                  <span className="truncate font-medium">{g.groupName}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {g.directCount} debts → {g.simplifiedCount} payment{g.simplifiedCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex gap-2">
        {(
          [
            ["all", "All"],
            ["owed", "Owed to You"],
            ["owe", "You Owe"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? "default" : "outline"}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Scale}
          heading={data.balances.length === 0 ? "No balances yet" : "Nothing here"}
          description={
            data.balances.length === 0
              ? "Once you're in a group with a bill, your balances with each person will show up here."
              : "Try a different filter."
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((b) => (
            <BalanceCard key={b.personId} balance={b} />
          ))}
        </div>
      )}
    </div>
  );
}
