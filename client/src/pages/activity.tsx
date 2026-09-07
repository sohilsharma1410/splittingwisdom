import { useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Activity as ActivityIcon, CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BreakdownDialog } from "@/components/bills/breakdown-dialog";
import { useActivity, type ActivityBillItem } from "@/hooks/use-bills";
import { formatPaise } from "@splittingwisdom/shared";
import { parseDateOnly } from "@/lib/date";

type Filter = "all" | "pending" | "settled";

const SPLIT_TYPE_LABEL: Record<string, string> = {
  equal: "equal",
  percentage: "percentage",
  ratio: "ratio",
  custom: "custom",
};

function ActivityCard({ bill }: { bill: ActivityBillItem }) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  return (
    <div className="relative rounded-xl border border-border bg-surface p-4 transition-shadow hover:shadow-md">
      <Link href={`/bill/${bill.id}`} className="absolute inset-0" aria-label={`Open ${bill.description}`} />

      <div className="flex items-start justify-between gap-3 pr-20 md:pr-0">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{bill.description}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {bill.groupName} · {format(parseDateOnly(bill.billDate), "d MMM yyyy")} · Paid by {bill.paidByName}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="tabular-currency font-semibold">{formatPaise(bill.grandTotal)}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {bill.status === "settled" ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Settled
              </>
            ) : (
              <>
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Pending
              </>
            )}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Your share: {formatPaise(bill.myShare)}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setBreakdownOpen(true);
          }}
          className="relative z-10 text-mint hover:underline"
        >
          {bill.itemCount} item{bill.itemCount === 1 ? "" : "s"} · See breakdown
        </button>
      </div>

      <BreakdownDialog
        open={breakdownOpen}
        onOpenChange={setBreakdownOpen}
        title={bill.description}
        description={`${bill.groupName} · ${format(parseDateOnly(bill.billDate), "d MMM yyyy")} · Paid by ${bill.paidByName}`}
      >
        {bill.unassignedItemCount > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-coral">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {bill.unassignedItemCount} item{bill.unassignedItemCount === 1 ? "" : "s"} not assigned yet.
          </p>
        )}
        {bill.items.map((item) => (
          <div key={item.id} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between text-xs">
              <span className="truncate font-medium text-foreground">{item.name}</span>
              <span className="tabular-currency shrink-0 text-muted-foreground">{formatPaise(item.price)}</span>
            </div>
            {item.assignments.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">Unassigned</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                {item.assignments.map((a) => (
                  <li key={a.memberId} className="flex justify-between gap-2">
                    <span className="truncate">
                      {a.displayName} ({SPLIT_TYPE_LABEL[a.splitType]})
                    </span>
                    <span className="tabular-currency shrink-0">{formatPaise(a.share)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </BreakdownDialog>
    </div>
  );
}

export default function Activity() {
  const { data, isLoading, isError, refetch } = useActivity();
  const [filter, setFilter] = useState<Filter>("all");

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (isError || !data) {
    return <ErrorState message="Couldn't load activity." onRetry={() => refetch()} />;
  }

  const pendingCount = data.bills.filter((b) => b.status === "pending").length;
  const settledCount = data.bills.filter((b) => b.status === "settled").length;
  const filtered = data.bills.filter((b) => filter === "all" || b.status === filter);

  const groups = new Map<string, ActivityBillItem[]>();
  for (const bill of filtered) {
    const key = format(parseDateOnly(bill.billDate), "d MMMM yyyy");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bill);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Activity</h1>
        <p className="mt-1 text-muted-foreground">Every bill across your groups, newest first.</p>
      </header>

      <div className="flex gap-2">
        {(
          [
            ["all", `All (${data.bills.length})`],
            ["pending", `Pending (${pendingCount})`],
            ["settled", `Settled (${settledCount})`],
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
          icon={ActivityIcon}
          heading={data.bills.length === 0 ? "No activity yet" : "Nothing here"}
          description={
            data.bills.length === 0
              ? "Bills you add will show up here, grouped by date."
              : "Try a different filter."
          }
        />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([date, bills]) => (
            <div key={date} className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{date}</h2>
              <div className="space-y-2">
                {bills.map((bill) => (
                  <ActivityCard key={bill.id} bill={bill} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
