import { useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Activity as ActivityIcon, ChevronDown, CheckCircle2, Clock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useActivity, type ActivityBillItem } from "@/hooks/use-bills";
import { formatPaise } from "@splittingwisdom/shared";
import { parseDateOnly } from "@/lib/date";
import { cn } from "@/lib/utils";

type Filter = "all" | "pending" | "settled";

function ActivityCard({ bill }: { bill: ActivityBillItem }) {
  const [expanded, setExpanded] = useState(false);
  const maxShare = Math.max(...bill.breakdown.map((b) => b.total), 1);

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/bill/${bill.id}`} className="min-w-0 flex-1">
          <p className="truncate font-medium hover:underline">{bill.description}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {bill.groupName} · {format(parseDateOnly(bill.billDate), "d MMM yyyy")} · Paid by {bill.paidByName}
          </p>
        </Link>
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
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex items-center gap-1 text-mint"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          {bill.itemCount} item{bill.itemCount === 1 ? "" : "s"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {bill.breakdown.map((row) => (
            <div key={row.memberId}>
              <div className="flex justify-between text-xs">
                <span>{row.displayName}</span>
                <span className="tabular-currency">
                  {formatPaise(row.total)} ({Math.round((row.total / bill.grandTotal) * 100)}%)
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full rounded-full bg-mint"
                  style={{ width: `${(row.total / maxShare) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
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
