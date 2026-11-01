import { useState } from "react";
import { useParams } from "wouter";
import { format } from "date-fns";
import { Scale, TrendingUp, TrendingDown, CheckCircle2, ChevronRight, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { BackButton } from "@/components/ui/back-button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { BreakdownDialog } from "@/components/bills/breakdown-dialog";
import { useBalanceDetail, type ContributingBill, type SettlementHistoryItem } from "@/hooks/use-balances";
import { SettleButton } from "@/components/settlements/settle-button";
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
        {!isSettled && (
          <div className="ml-auto">
            <SettleButton
              personId={data.personId}
              displayName={data.displayName}
              netAmount={data.netAmount}
              size="default"
            />
          </div>
        )}
      </header>

      {data.settlements.length > 0 && (
        <p
          className="tabular-currency rounded-xl border border-border bg-surface p-4 text-sm text-muted-foreground"
          data-testid="balance-math"
        >
          Bills {formatPaise(Math.abs(data.billsNet))} {data.billsNet >= 0 ? "owed to you" : "you owe"}
          {" − "}settled {formatPaise(Math.abs(data.settlementsNet))}
          {" → "}
          <span className="font-semibold text-foreground">
            {isSettled
              ? "settled up"
              : `outstanding ${formatPaise(Math.abs(data.netAmount))}`}
          </span>
        </p>
      )}

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
        {data.settlements.length === 0 ? (
          <EmptyState
            icon={Scale}
            heading="No settlements yet"
            description="Payments between you two will show up here."
          />
        ) : (
          <ul className="space-y-2">
            {data.settlements.map((payment) => (
              <SettlementRow key={payment.id} payment={payment} otherName={data.displayName} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ContributingBillCard({ bill }: { bill: ContributingBill }) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <button
        type="button"
        onClick={() => setDetailOpen(true)}
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
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
      </button>

      <BreakdownDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={bill.description}
        description={`${bill.groupName} · ${bill.payerIsMe ? "You" : bill.payerName} paid ${formatPaise(bill.grandTotal)}`}
      >
        {bill.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">No items driving this contribution.</p>
        ) : (
          <div className="space-y-1.5">
            {bill.items.map((item) => (
              <div key={item.itemId} className="flex items-center justify-between text-xs">
                <span className="truncate text-muted-foreground">
                  {item.name} ({SPLIT_TYPE_LABEL[item.splitType]})
                </span>
                <span className="tabular-currency shrink-0 font-medium">{formatPaise(item.share)}</span>
              </div>
            ))}
          </div>
        )}
      </BreakdownDialog>
    </div>
  );
}

function SettlementRow({ payment, otherName }: { payment: SettlementHistoryItem; otherName: string }) {
  const iPaid = payment.direction === "paid-by-me";
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          iPaid ? "bg-coral/15 text-coral" : "bg-success/15 text-success",
        )}
      >
        {iPaid ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : <ArrowDownLeft className="h-4 w-4" aria-hidden="true" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {iPaid ? `You paid ${otherName}` : `${otherName} paid you`}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {format(new Date(payment.settlementDate), "d MMM yyyy")} · {payment.groupName}
          {payment.note ? ` · “${payment.note}”` : ""}
        </p>
      </div>
      <span className="tabular-currency flex shrink-0 items-center gap-1.5 text-sm font-semibold">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
        {formatPaise(payment.amount)}
      </span>
    </li>
  );
}
