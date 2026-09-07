import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { parseDateOnly } from "@/lib/date";
import { cn } from "@/lib/utils";
import { CalendarIcon, ChevronDown, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurrencyInput } from "@/components/ui/currency-input";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";
import { useGroups, useGroup } from "@/hooks/use-groups";
import {
  useCreateBill,
  useUpdateBill,
  type BillDetail,
  type BillItemInput,
  type ItemAssignmentInput,
} from "@/hooks/use-bills";
import { useAuth } from "@/hooks/use-auth";
import { ItemListEditor, itemsSubtotal, type ItemRow } from "@/components/bills/item-list-editor";
import { AssignmentEditor } from "@/components/bills/assignment-editor";
import {
  formatPaise,
  rupeesToPaise,
  paiseToRupeeInput,
  splitEqually,
  allocateProportionally,
  computeBillBreakdown,
} from "@splittingwisdom/shared";

function safeRupeesToPaise(input: string): number {
  try {
    const paise = rupeesToPaise(input || "0");
    return Number.isFinite(paise) ? paise : 0;
  } catch {
    return 0;
  }
}

/** A bill is "Quick Split shaped" if it's one item, equally split — the
 * same data shape whether it came from the Quick Split or itemized path
 * (per the phase 2 plan). Anything else needs the item list editor. */
function isQuickSplitShaped(bill: BillDetail): boolean {
  if (bill.items.length !== 1) return false;
  const [item] = bill.items;
  return item.assignments.every((a) => a.splitType === "equal");
}

const SPLIT_TYPE_LABEL: Record<string, string> = {
  equal: "Split equally",
  percentage: "By percentage",
  ratio: "By ratio",
  custom: "Custom amounts",
};

function summarizeAssignment(assignments: ItemAssignmentInput[], totalSelected: number): string {
  if (assignments.length === 0) return "Unassigned";
  const label = SPLIT_TYPE_LABEL[assignments[0].splitType] ?? "Split";
  if (assignments[0].splitType === "equal" && assignments.length === totalSelected) {
    return `${label}, everyone`;
  }
  return `${label}, ${assignments.length} ${assignments.length === 1 ? "person" : "people"}`;
}

interface BillFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lockedGroupId?: number;
  editBill?: BillDetail;
}

/** A group selection is either a real group id, or the "personal" sentinel
 * meaning "no group — just track this for myself." The server resolves
 * (and lazily creates) the actual personal group; the client never needs
 * to know its id ahead of time. */
type GroupSelection = number | "personal" | null;

export function BillFormDialog({ open, onOpenChange, lockedGroupId, editBill }: BillFormDialogProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: groupsData } = useGroups();
  const createBill = useCreateBill();
  const updateBill = useUpdateBill(editBill?.id ?? -1, editBill?.groupId ?? lockedGroupId ?? -1);
  const isEditing = !!editBill;

  const [groupSelection, setGroupSelection] = useState<GroupSelection>(lockedGroupId ?? editBill?.groupId ?? null);
  // Only meaningful for a brand-new bill — an edit's group (personal or
  // not) is already fully resolved (real group id, real payer, real
  // per-item assignments already loaded from editBill), so there's nothing
  // for the server to auto-resolve and no reason to blank out assignments
  // that are already correct.
  const isPersonalSelected = !isEditing && groupSelection === "personal";
  const effectiveGroupId = typeof groupSelection === "number" ? groupSelection : null;
  const { data: groupData } = useGroup(effectiveGroupId ?? -1);
  // Only registered, joined members can participate in a bill — an invited
  // (unlinked) placeholder has no account and no way to see or act on it.
  const members = (groupData?.group.members ?? []).filter((m) => m.isLinked);

  const [description, setDescription] = useState("");
  const [merchant, setMerchant] = useState("");
  const [billDate, setBillDate] = useState<Date>(new Date());
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [showCharges, setShowCharges] = useState(false);
  const [taxAmount, setTaxAmount] = useState("");
  const [tipAmount, setTipAmount] = useState("");
  const [serviceFeeAmount, setServiceFeeAmount] = useState("");
  const [discountAmount, setDiscountAmount] = useState("");
  const [payerMemberId, setPayerMemberId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Quick Split mode — one field, equal split among selected members.
  const [quickSplit, setQuickSplit] = useState(true);
  const [totalAmount, setTotalAmount] = useState("");
  const [splitMemberIds, setSplitMemberIds] = useState<number[] | null>(null);
  const [showMemberPicker, setShowMemberPicker] = useState(false);

  // Itemized mode — a real item list. Each item defaults to an equal split
  // among splitMemberIds unless overridden via the inline assignment editor
  // (existingItemData holds only the overrides, keyed by item row key).
  const [items, setItems] = useState<ItemRow[]>([{ key: crypto.randomUUID(), name: "", price: "", quantity: "1" }]);
  const [existingItemData, setExistingItemData] = useState<Map<string, ItemAssignmentInput[]>>(new Map());
  const [editingItemKey, setEditingItemKey] = useState<string | null>(null);
  const [showReceiptTotal, setShowReceiptTotal] = useState(false);
  const [receiptTotal, setReceiptTotal] = useState("");

  function getEffectiveAssignments(key: string): ItemAssignmentInput[] {
    const override = existingItemData.get(key);
    if (override) return override;
    return (splitMemberIds ?? []).map((memberId) => ({ memberId, splitType: "equal" as const }));
  }

  function resetForm() {
    setGroupSelection(lockedGroupId ?? editBill?.groupId ?? null);
    setDescription("");
    setMerchant("");
    setBillDate(new Date());
    setShowCharges(false);
    setTaxAmount("");
    setTipAmount("");
    setServiceFeeAmount("");
    setDiscountAmount("");
    setPayerMemberId(null);
    setError(null);
    setQuickSplit(true);
    setTotalAmount("");
    setSplitMemberIds(null);
    setShowMemberPicker(false);
    setItems([{ key: crypto.randomUUID(), name: "", price: "", quantity: "1" }]);
    setExistingItemData(new Map());
    setEditingItemKey(null);
    setShowReceiptTotal(false);
    setReceiptTotal("");
  }

  // Prefill every field from the bill being edited, as soon as the dialog opens.
  useEffect(() => {
    if (!open || !editBill) return;
    setDescription(editBill.description);
    setMerchant(editBill.merchant ?? "");
    setBillDate(parseDateOnly(editBill.billDate));
    setTaxAmount(editBill.taxAmount ? paiseToRupeeInput(editBill.taxAmount) : "");
    setTipAmount(editBill.tipAmount ? paiseToRupeeInput(editBill.tipAmount) : "");
    setServiceFeeAmount(editBill.serviceFeeAmount ? paiseToRupeeInput(editBill.serviceFeeAmount) : "");
    setDiscountAmount(editBill.discountAmount ? paiseToRupeeInput(editBill.discountAmount) : "");
    setShowCharges(
      editBill.taxAmount > 0 ||
        editBill.tipAmount > 0 ||
        editBill.serviceFeeAmount > 0 ||
        editBill.discountAmount > 0,
    );
    setPayerMemberId(editBill.paidByMemberId);

    if (isQuickSplitShaped(editBill)) {
      setQuickSplit(true);
      setTotalAmount(paiseToRupeeInput(editBill.items[0].price));
      setSplitMemberIds(editBill.items[0].assignments.map((a) => a.memberId));
    } else {
      setQuickSplit(false);
      const rows: ItemRow[] = [];
      const carry = new Map<string, ItemAssignmentInput[]>();
      for (const item of editBill.items) {
        const key = crypto.randomUUID();
        rows.push({ key, name: item.name, price: paiseToRupeeInput(item.price), quantity: String(item.quantity) });
        carry.set(
          key,
          item.assignments.map((a) => ({
            memberId: a.memberId,
            splitType: a.splitType,
            percentage: a.percentage ?? undefined,
            ratio: a.ratio ?? undefined,
            customAmount: a.customAmount ?? undefined,
          })),
        );
      }
      setItems(rows);
      setExistingItemData(carry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editBill]);

  // Default payer + split members once this group's member list loads (create mode only).
  // Only linked members are eligible — an invited placeholder can't pay or be split with.
  useEffect(() => {
    if (isEditing || !groupData || splitMemberIds !== null) return;
    setSplitMemberIds(members.map((m) => m.id));
    const myMember = members.find((m) => m.userId === user?.id);
    setPayerMemberId(myMember?.id ?? members[0]?.id ?? null);
  }, [groupData, members, splitMemberIds, user, isEditing]);

  // When editing a bill that isn't split among everyone, show who's excluded
  // right away instead of hiding it behind the summary.
  useEffect(() => {
    if (!isEditing || members.length === 0 || splitMemberIds === null) return;
    if (splitMemberIds.length !== members.length) setShowMemberPicker(true);
  }, [isEditing, members, splitMemberIds]);

  const quickPreview = useMemo(() => {
    const subtotal = safeRupeesToPaise(totalAmount);
    const tax = safeRupeesToPaise(taxAmount);
    const tip = safeRupeesToPaise(tipAmount);
    const fee = safeRupeesToPaise(serviceFeeAmount);
    const discount = safeRupeesToPaise(discountAmount);
    const ids = splitMemberIds ?? [];

    if (ids.length === 0) return { rows: [], grandTotal: subtotal + tax + tip + fee - discount };

    const itemShares = splitEqually(Math.max(subtotal, 0), ids);
    const taxShares = allocateProportionally(tax, itemShares);
    const tipShares = allocateProportionally(tip, itemShares);
    const feeShares = allocateProportionally(fee, itemShares);
    const discountShares = allocateProportionally(discount, itemShares);

    const rows = ids.map((id) => {
      const member = members.find((m) => m.id === id);
      const total =
        (itemShares.get(id) ?? 0) +
        (taxShares.get(id) ?? 0) +
        (tipShares.get(id) ?? 0) +
        (feeShares.get(id) ?? 0) -
        (discountShares.get(id) ?? 0);
      return { id, name: member?.displayName ?? "?", total };
    });

    return { rows, grandTotal: subtotal + tax + tip + fee - discount };
  }, [totalAmount, taxAmount, tipAmount, serviceFeeAmount, discountAmount, splitMemberIds, members]);

  const itemsTotal = itemsSubtotal(items);
  const receiptMismatch =
    showReceiptTotal && receiptTotal.trim() !== "" ? safeRupeesToPaise(receiptTotal) - itemsTotal : 0;

  // Itemized live preview — works the moment items exist, since every item
  // now has a real (default-or-overridden) assignment from the start.
  const itemizedPreview = useMemo(() => {
    if (quickSplit || isPersonalSelected || !payerMemberId) return null;
    const validRows = items.filter((item) => item.name.trim() && safeRupeesToPaise(item.price) > 0);
    if (validRows.length === 0) return null;

    const breakdown = computeBillBreakdown({
      paidByMemberId: payerMemberId,
      taxAmount: safeRupeesToPaise(taxAmount),
      tipAmount: safeRupeesToPaise(tipAmount),
      serviceFeeAmount: safeRupeesToPaise(serviceFeeAmount),
      discountAmount: safeRupeesToPaise(discountAmount),
      items: validRows.map((item) => ({
        price: safeRupeesToPaise(item.price),
        assignments: getEffectiveAssignments(item.key).map((a) => ({
          memberId: a.memberId,
          splitType: a.splitType,
          percentage: a.percentage ?? null,
          ratio: a.ratio ?? null,
          customAmount: a.customAmount ?? null,
        })),
      })),
    });
    if (breakdown.length === 0) return null;

    const rows = breakdown.map((row) => ({
      id: row.memberId,
      name: members.find((m) => m.id === row.memberId)?.displayName ?? "?",
      total: row.total,
    }));
    return { rows, grandTotal: rows.reduce((sum, r) => sum + r.total, 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickSplit, isPersonalSelected, items, existingItemData, splitMemberIds, payerMemberId, taxAmount, tipAmount, serviceFeeAmount, discountAmount, members]);

  function toggleSplitMember(id: number) {
    setSplitMemberIds((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((m) => m !== id) : [...list, id];
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isPersonalSelected && !effectiveGroupId) {
      setError("Choose a group.");
      return;
    }
    if (!description.trim()) {
      setError("Description is required.");
      return;
    }
    if (!isPersonalSelected && !payerMemberId) {
      setError("Choose who paid.");
      return;
    }

    let billItems: BillItemInput[];
    let subtotalAmount: number;

    if (quickSplit) {
      const subtotal = safeRupeesToPaise(totalAmount);
      if (subtotal <= 0) {
        setError("Total amount must be greater than zero.");
        return;
      }
      if (!isPersonalSelected && (!splitMemberIds || splitMemberIds.length === 0)) {
        setError("Select at least one person to split with.");
        return;
      }
      subtotalAmount = subtotal;
      billItems = [
        {
          name: "Entire bill",
          price: subtotal,
          quantity: 1,
          assignments: isPersonalSelected
            ? []
            : (splitMemberIds ?? []).map((memberId) => ({ memberId, splitType: "equal" as const })),
        },
      ];
    } else {
      const validRows = items.filter((item) => item.name.trim() && safeRupeesToPaise(item.price) > 0);
      if (validRows.length === 0) {
        setError("Add at least one item with a name and price.");
        return;
      }
      subtotalAmount = showReceiptTotal && receiptTotal.trim() ? safeRupeesToPaise(receiptTotal) : itemsSubtotal(validRows);
      billItems = validRows.map((item) => ({
        name: item.name.trim(),
        price: safeRupeesToPaise(item.price),
        quantity: Number(item.quantity || "1"),
        assignments: isPersonalSelected ? [] : getEffectiveAssignments(item.key),
      }));
    }

    const payload = {
      groupId: isPersonalSelected ? undefined : (effectiveGroupId ?? undefined),
      description: description.trim(),
      merchant: merchant.trim() || undefined,
      billDate: format(billDate, "yyyy-MM-dd"),
      subtotalAmount,
      taxAmount: safeRupeesToPaise(taxAmount),
      tipAmount: safeRupeesToPaise(tipAmount),
      serviceFeeAmount: safeRupeesToPaise(serviceFeeAmount),
      discountAmount: safeRupeesToPaise(discountAmount),
      paidByMemberId: isPersonalSelected ? undefined : (payerMemberId ?? undefined),
      items: billItems,
    };

    try {
      if (isEditing) {
        await updateBill.mutateAsync(payload);
        toast({ title: "Bill updated", variant: "success" });
        onOpenChange(false);
      } else {
        const result = await createBill.mutateAsync(payload);
        toast({ title: "Bill saved", variant: "success" });
        onOpenChange(false);
        resetForm();
        navigate(`/bill/${result.bill.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    }
  }

  const editingItem = editingItemKey ? items.find((i) => i.key === editingItemKey) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) resetForm();
      }}
    >
      <DialogContent className="md:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Bill" : "New Bill"}</DialogTitle>
          <DialogDescription>
            {isPersonalSelected
              ? "Just for your own tracking — not shared with anyone."
              : quickSplit
                ? "Split a bill equally among selected members."
                : "List each item — split equally by default, override any item below."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {!lockedGroupId && !isEditing && (
            <div className="space-y-1.5">
              <Label htmlFor="bill-group">Group</Label>
              <Select
                value={groupSelection !== null ? String(groupSelection) : undefined}
                onValueChange={(v) => {
                  setGroupSelection(v === "personal" ? "personal" : Number(v));
                  setSplitMemberIds(null);
                  setPayerMemberId(null);
                }}
              >
                <SelectTrigger id="bill-group">
                  <SelectValue placeholder="Choose a group" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Just me (personal)</SelectItem>
                  {(groupsData?.groups ?? []).map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="bill-description">Description</Label>
            <Input
              id="bill-description"
              required
              placeholder="Dinner at Marina"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bill-merchant">Merchant (optional)</Label>
              <Input
                id="bill-merchant"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="w-full justify-start font-normal">
                    <CalendarIcon className="h-4 w-4" aria-hidden="true" />
                    {format(billDate, "d MMM yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start">
                  <Calendar
                    mode="single"
                    selected={billDate}
                    onSelect={(d) => {
                      if (d) setBillDate(d);
                      setDatePopoverOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {effectiveGroupId && (
            <div className="space-y-1.5">
              <Label htmlFor="bill-payer">Paid by</Label>
              <Select
                value={payerMemberId ? String(payerMemberId) : undefined}
                onValueChange={(v) => setPayerMemberId(Number(v))}
              >
                <SelectTrigger id="bill-payer">
                  <SelectValue placeholder="Who paid?" />
                </SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>How do you want to enter this?</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setQuickSplit(true)}
                aria-pressed={quickSplit}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  quickSplit ? "border-mint bg-mint/10" : "border-border hover:bg-foreground/5",
                )}
              >
                <p className={cn("text-sm font-medium", quickSplit && "text-mint")}>Quick Split</p>
                <p className="mt-0.5 text-xs text-muted-foreground">One total, split equally</p>
              </button>
              <button
                type="button"
                onClick={() => setQuickSplit(false)}
                aria-pressed={!quickSplit}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  !quickSplit ? "border-mint bg-mint/10" : "border-border hover:bg-foreground/5",
                )}
              >
                <p className={cn("text-sm font-medium", !quickSplit && "text-mint")}>Itemize</p>
                <p className="mt-0.5 text-xs text-muted-foreground">List items, assign each one</p>
              </button>
            </div>
          </div>

          {quickSplit ? (
            <div className="space-y-1.5">
              <Label htmlFor="bill-total">Total amount</Label>
              <CurrencyInput
                id="bill-total"
                required
                placeholder="0.00"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Items</Label>
              <ItemListEditor
                items={items}
                onChange={setItems}
                renderExtra={
                  isPersonalSelected
                    ? undefined
                    : members.length === 0
                      ? () => (
                          <p className="text-xs text-muted-foreground">Choose a group above to assign this item.</p>
                        )
                      : (item) => (
                          <button
                            type="button"
                            onClick={() => setEditingItemKey(item.key)}
                            className="text-xs text-mint hover:underline"
                          >
                            {summarizeAssignment(getEffectiveAssignments(item.key), splitMemberIds?.length ?? 0)} · Edit split
                          </button>
                        )
                }
              />
              <p className="text-xs text-muted-foreground">
                {isPersonalSelected
                  ? "This is just for your own tracking."
                  : members.length === 0
                    ? "Choose a group above, then each item will split equally among everyone selected — override any item individually."
                    : "Each item splits equally among everyone selected below by default."}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowCharges((s) => !s)}
            className="flex w-full items-center justify-between rounded-lg border border-border p-3 text-left hover:bg-foreground/5"
            aria-expanded={showCharges}
          >
            <div>
              <p className="text-sm font-medium">Tax, tip &amp; discount</p>
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const total =
                    safeRupeesToPaise(taxAmount) +
                    safeRupeesToPaise(tipAmount) +
                    safeRupeesToPaise(serviceFeeAmount) -
                    safeRupeesToPaise(discountAmount);
                  return total !== 0 ? `${formatPaise(total)} added` : "None added — optional";
                })()}
              </p>
            </div>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showCharges ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>

          {showCharges && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-background p-3">
              <div className="space-y-1.5">
                <Label htmlFor="bill-tax">Tax</Label>
                <CurrencyInput id="bill-tax" placeholder="0.00" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-tip">Tip</Label>
                <CurrencyInput id="bill-tip" placeholder="0.00" value={tipAmount} onChange={(e) => setTipAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-fee">Service fee</Label>
                <CurrencyInput id="bill-fee" placeholder="0.00" value={serviceFeeAmount} onChange={(e) => setServiceFeeAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-discount">Discount</Label>
                <CurrencyInput id="bill-discount" placeholder="0.00" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} />
              </div>
            </div>
          )}

          {effectiveGroupId && members.length <= 1 && (
            <div className="space-y-1.5 rounded-lg bg-mint/10 p-3 text-sm">
              <p>It's just you in this group so far — invite others to split with them.</p>
              {groupData?.group.inviteToken && (
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(`${window.location.origin}/join/${groupData.group.inviteToken}`)}
                  className="font-medium text-mint hover:underline"
                >
                  Copy invite link
                </button>
              )}
            </div>
          )}

          {effectiveGroupId && members.length > 1 && (
            <div className="space-y-1.5">
              <Label>{quickSplit ? "Split equally between" : "People on this bill"}</Label>
              {!showMemberPicker ? (
                <button
                  type="button"
                  onClick={() => setShowMemberPicker(true)}
                  className="flex w-full items-center justify-between rounded-lg border border-border p-3 text-left text-sm hover:bg-foreground/5"
                >
                  <span>
                    {members.length > 0 && (splitMemberIds?.length ?? 0) === members.length
                      ? `Everyone (${members.length} people)`
                      : `${splitMemberIds?.length ?? 0} of ${members.length} people`}
                  </span>
                  <span className="text-mint">Change</span>
                </button>
              ) : (
                <div className="space-y-2 rounded-lg border border-border p-3">
                  {members.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={(splitMemberIds ?? []).includes(m.id)}
                        onCheckedChange={() => toggleSplitMember(m.id)}
                      />
                      {m.displayName}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {!quickSplit && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowReceiptTotal((s) => !s)}
                className="flex items-center gap-1.5 text-sm font-medium text-mint"
                aria-expanded={showReceiptTotal}
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showReceiptTotal ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                Check against the receipt's printed total
              </button>
              {showReceiptTotal && (
                <div className="space-y-1.5">
                  <CurrencyInput placeholder="0.00" value={receiptTotal} onChange={(e) => setReceiptTotal(e.target.value)} />
                  {receiptMismatch !== 0 && (
                    <p role="alert" className="text-xs text-coral">
                      Items add up to {formatPaise(itemsTotal)}, but the receipt says{" "}
                      {formatPaise(safeRupeesToPaise(receiptTotal))} — a difference of {formatPaise(Math.abs(receiptMismatch))}.
                      You can still save; the item total will be used.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {quickSplit && quickPreview.rows.length > 0 && safeRupeesToPaise(totalAmount) > 0 && !isPersonalSelected && (
            <div className="space-y-1.5 rounded-lg bg-mint/10 p-3 text-sm">
              <p className="font-medium text-mint">Live preview</p>
              {quickPreview.rows.map((row) => (
                <div key={row.id} className="flex justify-between">
                  <span>{row.name}</span>
                  <span className="tabular-currency">{formatPaise(row.total)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-mint/30 pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-currency">{formatPaise(quickPreview.grandTotal)}</span>
              </div>
            </div>
          )}
          {quickSplit && totalAmount && safeRupeesToPaise(totalAmount) <= 0 && (
            <p role="alert" className="text-sm text-coral">
              Total amount must be greater than zero.
            </p>
          )}

          {itemizedPreview && (
            <div className="space-y-1.5 rounded-lg bg-mint/10 p-3 text-sm">
              <p className="font-medium text-mint">Live preview</p>
              {itemizedPreview.rows.map((row) => (
                <div key={row.id} className="flex justify-between">
                  <span>{row.name}</span>
                  <span className="tabular-currency">{formatPaise(row.total)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-mint/30 pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-currency">{formatPaise(itemizedPreview.grandTotal)}</span>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-coral">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createBill.isPending || updateBill.isPending}>
              {(createBill.isPending || updateBill.isPending) && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {isEditing ? "Save Changes" : "Save Bill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      {editingItem && (
        <AssignmentEditor
          open={!!editingItemKey}
          onOpenChange={(openNext) => !openNext && setEditingItemKey(null)}
          item={{ name: editingItem.name || "Item", price: safeRupeesToPaise(editingItem.price) }}
          members={members}
          initialAssignments={getEffectiveAssignments(editingItem.key)}
          onSave={(assignments) =>
            setExistingItemData((prev) => new Map(prev).set(editingItem.key, assignments))
          }
        />
      )}
    </Dialog>
  );
}
