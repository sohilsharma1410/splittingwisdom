import { useState } from "react";
import { useParams, Link } from "wouter";
import { format } from "date-fns";
import { parseDateOnly } from "@/lib/date";
import { Pencil, Trash2, ChevronDown, Receipt } from "lucide-react";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
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
          <div className="mt-3 space-y-4 rounded-xl border border-border bg-surface p-5 text-sm">
            <div>
              <p className="font-medium">1. Subtotal split equally among {nMembers} people</p>
              <p className="mt-1 text-muted-foreground">
                {formatPaise(bill.subtotalAmount)} ÷ {nMembers} = {formatPaise(Math.floor(bill.subtotalAmount / nMembers))} each,
                with the leftover paise given one each to members in a fixed order so the total always
                adds up exactly.
              </p>
            </div>

            {(bill.taxAmount > 0 || bill.tipAmount > 0 || bill.serviceFeeAmount > 0) && (
              <div>
                <p className="font-medium">2. Tax, tip & fees allocated by item share</p>
                <p className="mt-1 text-muted-foreground">
                  Each person's tax, tip, and service fee is proportional to their share of the
                  subtotal above — someone with a bigger share of the bill pays a bigger share of
                  the tax. Someone with no items on a bill would owe nothing here.
                </p>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  {bill.taxAmount > 0 && <li>Tax: {formatPaise(bill.taxAmount)}</li>}
                  {bill.tipAmount > 0 && <li>Tip: {formatPaise(bill.tipAmount)}</li>}
                  {bill.serviceFeeAmount > 0 && <li>Service fee: {formatPaise(bill.serviceFeeAmount)}</li>}
                </ul>
              </div>
            )}

            {bill.discountAmount > 0 && (
              <div>
                <p className="font-medium">3. Discount subtracted the same way</p>
                <p className="mt-1 text-muted-foreground">
                  {formatPaise(bill.discountAmount)} discount is subtracted from each person
                  proportionally to their item share, same rule as tax above.
                </p>
              </div>
            )}

            <div>
              <p className="font-medium">Rounding rule</p>
              <p className="mt-1 text-muted-foreground">
                Amounts are split in whole paise. Everyone gets the same rounded-down base share;
                any leftover paise (never more than {nMembers - 1}) go one each to members in a
                fixed, deterministic order — so the shares always add up to the exact total, never
                more or less.
              </p>
            </div>

            <div className="border-t border-border pt-3">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pb-1 font-normal">Person</th>
                    <th className="pb-1 text-right font-normal">Item</th>
                    {bill.taxAmount > 0 && <th className="pb-1 text-right font-normal">Tax</th>}
                    {bill.tipAmount > 0 && <th className="pb-1 text-right font-normal">Tip</th>}
                    {bill.serviceFeeAmount > 0 && <th className="pb-1 text-right font-normal">Fee</th>}
                    {bill.discountAmount > 0 && <th className="pb-1 text-right font-normal">Discount</th>}
                    <th className="pb-1 text-right font-normal">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.breakdown.map((row) => (
                    <tr key={row.memberId} className="border-t border-border">
                      <td className="py-1.5">{row.displayName}</td>
                      <td className="py-1.5 text-right tabular-currency">{formatPaise(row.itemShare)}</td>
                      {bill.taxAmount > 0 && (
                        <td className="py-1.5 text-right tabular-currency">{formatPaise(row.taxShare)}</td>
                      )}
                      {bill.tipAmount > 0 && (
                        <td className="py-1.5 text-right tabular-currency">{formatPaise(row.tipShare)}</td>
                      )}
                      {bill.serviceFeeAmount > 0 && (
                        <td className="py-1.5 text-right tabular-currency">{formatPaise(row.serviceFeeShare)}</td>
                      )}
                      {bill.discountAmount > 0 && (
                        <td className="py-1.5 text-right tabular-currency">
                          -{formatPaise(row.discountShare)}
                        </td>
                      )}
                      <td className="py-1.5 text-right tabular-currency font-semibold">
                        {formatPaise(row.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
