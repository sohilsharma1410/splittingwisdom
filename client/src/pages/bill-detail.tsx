import { useState } from "react";
import { useParams, Link } from "wouter";
import { format } from "date-fns";
import { parseDateOnly } from "@/lib/date";
import { Pencil, Trash2, ChevronDown, Receipt } from "lucide-react";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { BillFormDialog } from "@/components/bills/bill-form-dialog";
import { DeleteBillAlert } from "@/components/bills/delete-bill-alert";
import { useBill } from "@/hooks/use-bills";
import { formatPaise } from "@splittingwisdom/shared";

export default function BillDetail() {
  const { id } = useParams<{ id: string }>();
  const billId = Number(id);
  const { data, isLoading, isError, refetch } = useBill(billId);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showHow, setShowHow] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !data) {
    return <ErrorState message="Couldn't load this bill." onRetry={() => refetch()} />;
  }

  const { bill } = data;
  const nMembers = bill.breakdown.length;
  const billDateLocal = parseDateOnly(bill.billDate);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <BackButton fallbackHref={`/group/${bill.groupId}`} />
          <div className="min-w-0">
            <Link href={`/group/${bill.groupId}`} className="text-sm text-mint hover:underline">
              {bill.groupName}
            </Link>
            <h1 className="mt-1 text-3xl font-semibold">{bill.description}</h1>
            <p className="mt-1 text-muted-foreground">
              {format(billDateLocal, "d MMM yyyy")}
              {bill.merchant && ` · ${bill.merchant}`} · Paid by {bill.paidByName}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="icon" aria-label="Edit bill" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button variant="outline" size="icon" aria-label="Delete bill" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4 text-coral" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Receipt className="h-4 w-4" aria-hidden="true" />
            Total
          </span>
          <span className="tabular-currency text-2xl font-semibold">{formatPaise(bill.grandTotal)}</span>
        </div>
        {bill.lastEditedAt && bill.lastEditedByName && (
          <p className="mt-2 text-xs text-muted-foreground">
            Edited by {bill.lastEditedByName} at {format(new Date(bill.lastEditedAt), "d MMM yyyy, h:mm a")}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Per-person share</h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-surface">
          {bill.breakdown.map((row) => (
            <div key={row.memberId} className="flex items-center justify-between p-4">
              <span className="text-sm font-medium">{row.displayName}</span>
              <span className="tabular-currency text-sm font-semibold">{formatPaise(row.total)}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <button
          onClick={() => setShowHow((s) => !s)}
          aria-expanded={showHow}
          className="flex items-center gap-1.5 text-sm font-medium text-mint"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${showHow ? "rotate-180" : ""}`} aria-hidden="true" />
          How was this calculated?
        </button>

        {showHow && (
          <div className="mt-3 space-y-3 rounded-xl border border-border bg-surface p-5 text-sm">
            <p className="text-muted-foreground">
              Split equally among {nMembers} people
              {(bill.taxAmount > 0 || bill.tipAmount > 0 || bill.serviceFeeAmount > 0) &&
                ", with tax/tip/fees added in the same proportion as each person's share"}
              {bill.discountAmount > 0 && " and any discount subtracted the same way"}. Paise
              that don't divide evenly go one each to people in a fixed order, so shares always
              add up exactly — never more, never less.
            </p>
            <div className="divide-y divide-border border-t border-border">
              {bill.breakdown.map((row) => {
                const parts = [
                  `${formatPaise(row.itemShare)} item`,
                  row.taxShare > 0 && `${formatPaise(row.taxShare)} tax`,
                  row.tipShare > 0 && `${formatPaise(row.tipShare)} tip`,
                  row.serviceFeeShare > 0 && `${formatPaise(row.serviceFeeShare)} fee`,
                  row.discountShare > 0 && `−${formatPaise(row.discountShare)} discount`,
                ].filter((p): p is string => Boolean(p));
                return (
                  <div key={row.memberId} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0 pr-3">
                      <p className="font-medium">{row.displayName}</p>
                      {parts.length > 1 && (
                        <p className="truncate text-xs text-muted-foreground">{parts.join(" + ")}</p>
                      )}
                    </div>
                    <span className="tabular-currency shrink-0 font-semibold">{formatPaise(row.total)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <BillFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lockedGroupId={bill.groupId}
        editBill={bill}
      />
      <DeleteBillAlert
        billId={bill.id}
        groupId={bill.groupId}
        description={bill.description}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}
