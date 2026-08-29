import { useState } from "react";
import { useParams, Link } from "wouter";
import { format } from "date-fns";
import { parseDateOnly } from "@/lib/date";
import { Pencil, Trash2, ChevronDown, Receipt, AlertTriangle, Users } from "lucide-react";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { BillFormDialog } from "@/components/bills/bill-form-dialog";
import { DeleteBillAlert } from "@/components/bills/delete-bill-alert";
import { AssignmentEditor } from "@/components/bills/assignment-editor";
import { useBill, useUpdateBill, type BillItemDetail, type BillItemInput, type ItemAssignmentInput } from "@/hooks/use-bills";
import { useGroup } from "@/hooks/use-groups";
import { useToast } from "@/components/ui/toast";
import { memberColor } from "@/lib/member-colors";
import { cn } from "@/lib/utils";
import { formatPaise } from "@splittingwisdom/shared";

const SPLIT_TYPE_LABEL: Record<string, string> = {
  equal: "split equally",
  percentage: "by percentage",
  ratio: "by ratio",
  custom: "custom amount",
};

function itemToInput(item: BillItemDetail): BillItemInput {
  return {
    name: item.name,
    price: item.price,
    quantity: item.quantity,
    assignments: item.assignments.map((a) => ({
      memberId: a.memberId,
      splitType: a.splitType,
      percentage: a.percentage ?? undefined,
      ratio: a.ratio ?? undefined,
      customAmount: a.customAmount ?? undefined,
    })),
  };
}

export default function BillDetail() {
  const { id } = useParams<{ id: string }>();
  const billId = Number(id);
  const { data, isLoading, isError, refetch } = useBill(billId);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [assigningItem, setAssigningItem] = useState<BillItemDetail | null>(null);
  const { toast } = useToast();

  const updateBill = useUpdateBill(billId, data?.bill.groupId ?? -1);
  const { data: groupData } = useGroup(data?.bill.groupId ?? -1);
  const groupMembers = groupData?.group.members ?? [];

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
  const billDateLocal = parseDateOnly(bill.billDate);
  const assignedCount = bill.itemCount - bill.unassignedItemCount;
  const totalAssignedItemShare = bill.breakdown.reduce((sum, row) => sum + row.itemShare, 0);

  async function saveItemAssignments(itemId: number, assignments: ItemAssignmentInput[]) {
    const nextItems: BillItemInput[] = bill.items.map((item) =>
      item.id === itemId ? { ...itemToInput(item), assignments } : itemToInput(item),
    );
    try {
      await updateBill.mutateAsync({ items: nextItems });
      toast({ title: "Assignment saved", variant: "success" });
    } catch {
      toast({ title: "Couldn't save assignment", variant: "error" });
    }
  }

  async function assignAllEqually() {
    const allMemberIds = groupMembers.map((m) => m.id);
    const nextItems: BillItemInput[] = bill.items.map((item) => {
      const input = itemToInput(item);
      if (input.assignments.length > 0) return input;
      return { ...input, assignments: allMemberIds.map((memberId) => ({ memberId, splitType: "equal" as const })) };
    });
    try {
      await updateBill.mutateAsync({ items: nextItems });
      toast({ title: "Unassigned items split equally", variant: "success" });
    } catch {
      toast({ title: "Couldn't update assignments", variant: "error" });
    }
  }

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
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Items</h2>
          <span className="text-sm text-muted-foreground">
            {assignedCount} of {bill.itemCount} assigned
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-mint transition-all"
            style={{ width: bill.itemCount > 0 ? `${(assignedCount / bill.itemCount) * 100}%` : "0%" }}
          />
        </div>

        {bill.unassignedItemCount > 0 && (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-coral/30 bg-coral/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2 text-coral">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {bill.unassignedItemCount} item{bill.unassignedItemCount === 1 ? "" : "s"} not assigned yet — excluded
              from balances until assigned.
            </span>
            <Button size="sm" variant="outline" onClick={assignAllEqually} disabled={updateBill.isPending}>
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Assign all equally
            </Button>
          </div>
        )}

        <div className="divide-y divide-border rounded-xl border border-border bg-surface">
          {bill.items.map((item) => (
            <ItemRow key={item.id} item={item} onEdit={() => setAssigningItem(item)} />
          ))}
        </div>
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
            <p className="text-muted-foreground">
              Each item is split among the people assigned to it, using that item's split method. Tax, tip, and
              fees are then added — and any discount subtracted — in proportion to each person's item total. Paise
              that don't divide evenly go one each to people in a fixed order, so shares always add up exactly.
            </p>
            <div className="space-y-4 border-t border-border pt-4">
              {bill.breakdown.map((row) => {
                const theirItems = bill.items.filter((item) => item.assignments.some((a) => a.memberId === row.memberId));
                const proportion =
                  totalAssignedItemShare > 0 ? Math.round((row.itemShare / totalAssignedItemShare) * 100) : 0;
                const chargesTotal = row.taxShare + row.tipShare + row.serviceFeeShare - row.discountShare;

                return (
                  <div key={row.memberId}>
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{row.displayName}</p>
                      <span className="tabular-currency font-semibold">{formatPaise(row.total)}</span>
                    </div>
                    <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                      {theirItems.map((item) => {
                        const assignment = item.assignments.find((a) => a.memberId === row.memberId)!;
                        return (
                          <li key={item.id} className="flex justify-between gap-2">
                            <span className="truncate">
                              {item.name} ({SPLIT_TYPE_LABEL[assignment.splitType]})
                            </span>
                            <span className="tabular-currency shrink-0">{formatPaise(assignment.share)}</span>
                          </li>
                        );
                      })}
                      {chargesTotal !== 0 && (
                        <li className="flex justify-between gap-2">
                          <span>
                            Tax/tip/fees ({proportion}% of the subtotal was theirs)
                            {row.discountShare > 0 && " · discount applied"}
                          </span>
                          <span className="tabular-currency shrink-0">{formatPaise(chargesTotal)}</span>
                        </li>
                      )}
                    </ul>
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
      {assigningItem && (
        <AssignmentEditor
          open={!!assigningItem}
          onOpenChange={(open) => !open && setAssigningItem(null)}
          item={{ name: assigningItem.name, price: assigningItem.price }}
          members={groupMembers}
          initialAssignments={assigningItem.assignments.map((a) => ({
            memberId: a.memberId,
            splitType: a.splitType,
            percentage: a.percentage ?? undefined,
            ratio: a.ratio ?? undefined,
            customAmount: a.customAmount ?? undefined,
          }))}
          onSave={(assignments) => saveItemAssignments(assigningItem.id, assignments)}
        />
      )}
    </div>
  );
}

function ItemRow({ item, onEdit }: { item: BillItemDetail; onEdit: () => void }) {
  const isAssigned = item.assignments.length > 0;
  return (
    <div className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:pr-20 md:pr-0">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {item.name}
            {item.quantity > 1 && <span className="text-muted-foreground"> ×{item.quantity}</span>}
          </p>
          <span
            className={cn(
              "mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              isAssigned ? "bg-mint/15 text-mint" : "bg-coral/15 text-coral",
            )}
          >
            {isAssigned ? "Assigned" : "Unassigned"}
          </span>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 pr-20 sm:justify-end sm:pr-0">
          <span className="tabular-currency text-sm font-semibold">{formatPaise(item.price)}</span>
          <Button size="sm" variant="outline" onClick={onEdit}>
            {isAssigned ? "Edit" : "Assign"}
          </Button>
        </div>
      </div>
      {isAssigned && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.assignments.map((a) => {
            const color = memberColor(a.memberId);
            return (
              <span
                key={a.memberId}
                className={cn("flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-xs font-medium", color.bg, color.text)}
              >
                <InitialsAvatar name={a.displayName} className={cn(color.bg, color.text, "h-5 w-5 ring-0 text-[10px]")} />
                {a.displayName} · {formatPaise(a.share)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
