import { Link } from "wouter";
import { format } from "date-fns";
import { CheckCircle2, Clock } from "lucide-react";
import { formatPaise } from "@splittingwisdom/shared";
import { parseDateOnly } from "@/lib/date";
import type { GroupBillSummary } from "@/hooks/use-bills";

export function BillCard({ bill }: { bill: GroupBillSummary }) {
  return (
    <Link
      href={`/bill/${bill.id}`}
      className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4 transition-shadow hover:shadow-md"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{bill.description}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {format(parseDateOnly(bill.billDate), "d MMM yyyy")} · Paid by {bill.paidByName}
          {bill.merchant && ` · ${bill.merchant}`}
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
    </Link>
  );
}
