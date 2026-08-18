import { useParams } from "wouter";
import { format } from "date-fns";
import { Scale, TrendingUp, TrendingDown, CheckCircle2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { useBalanceDetail } from "@/hooks/use-balances";
import { formatPaise } from "@splittingwisdom/shared";
import { cn } from "@/lib/utils";
import { parseDateOnly } from "@/lib/date";

export default function BalanceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, refetch } = useBalanceDetail(id);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (isError || !data) {
    return <ErrorState message="Couldn't load this balance." onRetry={() => refetch()} />;
  }

  const isOwedToMe = data.netAmount > 0;
  const isSettled = data.netAmount === 0;

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <InitialsAvatar name={data.displayName} className="h-12 w-12 text-base" />
        <div>
          <h1 className="text-2xl font-semibold">{data.displayName}</h1>
          <p
            className={cn(
              "flex items-center gap-1 text-sm font-medium",
              isSettled && "text-muted-foreground",
              !isSettled && isOwedToMe && "text-success",
              !isSettled && !isOwedToMe && "text-coral",
            )}
          >
            {isSettled ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : isOwedToMe ? (
              <TrendingUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <TrendingDown className="h-4 w-4" aria-hidden="true" />
            )}
            {isSettled
              ? "Settled up"
              : `${isOwedToMe ? "Owes you" : "You owe"} ${formatPaise(Math.abs(data.netAmount))}`}
          </p>
        </div>
        <span title="Settlements arrive in a later update" className="ml-auto">
          <Button variant="coral" disabled>
            Settle Up
          </Button>
        </span>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Contributing bills</h2>
        {data.contributingBills.length === 0 ? (
          <EmptyState icon={Scale} heading="No bills yet" description="Bills between you two will show up here." />
        ) : (
          <div className="space-y-2">
            {data.contributingBills.map((bill) => (
              <div key={bill.billId} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{bill.description}</p>
                  <span className="text-xs text-muted-foreground">
                    {format(parseDateOnly(bill.billDate), "d MMM yyyy")}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {bill.groupName} · {bill.payerIsMe ? "You" : bill.payerName} paid {formatPaise(bill.grandTotal)}
                  {" · "}
                  {bill.payerIsMe ? `their share ${formatPaise(bill.theirShare)}` : `your share ${formatPaise(bill.theirShare)}`}
                  {" → "}
                  {bill.payerIsMe
                    ? `they owe ${formatPaise(bill.theirShare)}`
                    : `you owe ${formatPaise(bill.theirShare)}`}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Settlement history</h2>
        <EmptyState
          icon={Scale}
          heading="No settlements yet"
          description="Settlement records arrive in a later update."
        />
      </section>
    </div>
  );
}
