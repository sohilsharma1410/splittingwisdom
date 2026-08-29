import { useState } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import { Scale, TrendingUp, TrendingDown, CheckCircle2, ChevronDown } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { useBalanceDetail, type ContributingBill } from "@/hooks/use-balances";
import { formatPaise } from "@splittingwisdom/shared";
import { cn } from "@/lib/utils";
import { parseDateOnly } from "@/lib/date";

const SPLIT_TYPE_LABEL: Record<string, string> = {
  equal: "split equally",
  percentage: "by percentage",
  ratio: "by ratio",
  custom: "custom amount",
};

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
        <BackButton fallbackHref="/balances" />
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
              <ContributingBillCard key={bill.billId} bill={bill} />
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

function ContributingBillCard({ bill }: { bill: ContributingBill }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-medium">{bill.description}</p>
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
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{format(parseDateOnly(bill.billDate), "d MMM yyyy")}</span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          {bill.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">No items driving this contribution.</p>
          ) : (
            bill.items.map((item) => (
              <div key={item.itemId} className="flex items-center justify-between text-xs">
                <span className="truncate text-muted-foreground">
                  {item.name} ({SPLIT_TYPE_LABEL[item.splitType]})
                </span>
                <span className="tabular-currency shrink-0 font-medium">{formatPaise(item.share)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
