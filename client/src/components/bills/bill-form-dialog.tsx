import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { parseDateOnly } from "@/lib/date";
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
import { useCreateBill, useUpdateBill, type BillDetail } from "@/hooks/use-bills";
import { useAuth } from "@/hooks/use-auth";
import {
  formatPaise,
  rupeesToPaise,
  paiseToRupeeInput,
  splitEqually,
  allocateProportionally,
} from "@splittingwisdom/shared";

function safeRupeesToPaise(input: string): number {
  try {
    const paise = rupeesToPaise(input || "0");
    return Number.isFinite(paise) ? paise : 0;
  } catch {
    return 0;
  }
}

interface BillFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lockedGroupId?: number;
  editBill?: BillDetail;
}

export function BillFormDialog({ open, onOpenChange, lockedGroupId, editBill }: BillFormDialogProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: groupsData } = useGroups();
  const createBill = useCreateBill();
  const updateBill = useUpdateBill(editBill?.id ?? -1, editBill?.groupId ?? lockedGroupId ?? -1);
  const isEditing = !!editBill;

  const [groupId, setGroupId] = useState<number | null>(lockedGroupId ?? editBill?.groupId ?? null);
  const effectiveGroupId = lockedGroupId ?? editBill?.groupId ?? groupId;
  const { data: groupData } = useGroup(effectiveGroupId ?? -1);
  const members = groupData?.group.members ?? [];

  const [description, setDescription] = useState("");
  const [merchant, setMerchant] = useState("");
  const [billDate, setBillDate] = useState<Date>(new Date());
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [totalAmount, setTotalAmount] = useState("");
  const [showCharges, setShowCharges] = useState(false);
  const [taxAmount, setTaxAmount] = useState("");
  const [tipAmount, setTipAmount] = useState("");
  const [serviceFeeAmount, setServiceFeeAmount] = useState("");
  const [discountAmount, setDiscountAmount] = useState("");
  const [payerMemberId, setPayerMemberId] = useState<number | null>(null);
  const [splitMemberIds, setSplitMemberIds] = useState<number[] | null>(null);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setGroupId(lockedGroupId ?? editBill?.groupId ?? null);
    setDescription("");
    setMerchant("");
    setBillDate(new Date());
    setTotalAmount("");
    setShowCharges(false);
    setTaxAmount("");
    setTipAmount("");
    setServiceFeeAmount("");
    setDiscountAmount("");
    setPayerMemberId(null);
    setSplitMemberIds(null);
    setShowMemberPicker(false);
    setError(null);
  }

  // Prefill every field from the bill being edited, as soon as the dialog opens.
  useEffect(() => {
    if (!open || !editBill) return;
    setDescription(editBill.description);
    setMerchant(editBill.merchant ?? "");
    setBillDate(parseDateOnly(editBill.billDate));
    setTotalAmount(paiseToRupeeInput(editBill.subtotalAmount));
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
    setSplitMemberIds(editBill.splitMemberIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editBill]);

  // Default payer + split members once this group's member list loads (create mode only).
  useEffect(() => {
    if (isEditing || !groupData || splitMemberIds !== null) return;
    setSplitMemberIds(groupData.group.members.map((m) => m.id));
    const myMember = groupData.group.members.find((m) => m.userId === user?.id);
    setPayerMemberId(myMember?.id ?? groupData.group.members[0]?.id ?? null);
  }, [groupData, splitMemberIds, user, isEditing]);

  // When editing a bill that isn't split among everyone, show who's excluded
  // right away instead of hiding it behind the summary.
  useEffect(() => {
    if (!isEditing || members.length === 0 || splitMemberIds === null) return;
    if (splitMemberIds.length !== members.length) setShowMemberPicker(true);
  }, [isEditing, members, splitMemberIds]);

  const preview = useMemo(() => {
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

  function toggleSplitMember(id: number) {
    setSplitMemberIds((current) => {
      const list = current ?? [];
      return list.includes(id) ? list.filter((m) => m !== id) : [...list, id];
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!effectiveGroupId) {
      setError("Choose a group.");
      return;
    }
    if (!description.trim()) {
      setError("Description is required.");
      return;
    }
    const subtotal = safeRupeesToPaise(totalAmount);
    if (subtotal <= 0) {
      setError("Total amount must be greater than zero.");
      return;
    }
    if (!payerMemberId) {
      setError("Choose who paid.");
      return;
    }
    if (!splitMemberIds || splitMemberIds.length === 0) {
      setError("Select at least one person to split with.");
      return;
    }

    const payload = {
      groupId: effectiveGroupId,
      description: description.trim(),
      merchant: merchant.trim() || undefined,
      billDate: format(billDate, "yyyy-MM-dd"),
      subtotalAmount: subtotal,
      taxAmount: safeRupeesToPaise(taxAmount),
      tipAmount: safeRupeesToPaise(tipAmount),
      serviceFeeAmount: safeRupeesToPaise(serviceFeeAmount),
      discountAmount: safeRupeesToPaise(discountAmount),
      paidByMemberId: payerMemberId,
      splitMemberIds,
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
          <DialogDescription>Split a bill equally among selected members.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {!lockedGroupId && !isEditing && (
            <div className="space-y-1.5">
              <Label htmlFor="bill-group">Group</Label>
              <Select
                value={groupId ? String(groupId) : undefined}
                onValueChange={(v) => {
                  setGroupId(Number(v));
                  setSplitMemberIds(null);
                  setPayerMemberId(null);
                }}
              >
                <SelectTrigger id="bill-group">
                  <SelectValue placeholder="Choose a group" />
                </SelectTrigger>
                <SelectContent>
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
            <Label htmlFor="bill-total">Total amount</Label>
            <CurrencyInput
              id="bill-total"
              required
              placeholder="0.00"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowCharges((s) => !s)}
            className="flex items-center gap-1.5 text-sm font-medium text-mint"
            aria-expanded={showCharges}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showCharges ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
            Add tax & charges
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

          {effectiveGroupId && (
            <div className="space-y-1.5">
              <Label>Split equally between</Label>
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

          {preview.rows.length > 0 && (
            <div className="space-y-1.5 rounded-lg bg-mint/10 p-3 text-sm">
              <p className="font-medium text-mint">Live preview</p>
              {preview.rows.map((row) => (
                <div key={row.id} className="flex justify-between">
                  <span>{row.name}</span>
                  <span className="tabular-currency">{formatPaise(row.total)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-mint/30 pt-1 font-semibold">
                <span>Total</span>
                <span className="tabular-currency">{formatPaise(preview.grandTotal)}</span>
              </div>
            </div>
          )}
          {totalAmount && safeRupeesToPaise(totalAmount) <= 0 && (
            <p role="alert" className="text-sm text-coral">
              Total amount must be greater than zero.
            </p>
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
    </Dialog>
  );
}
