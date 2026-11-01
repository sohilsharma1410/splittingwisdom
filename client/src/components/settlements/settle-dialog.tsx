import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/query-client";
import { useCreateSettlement, type SettlementRequest } from "@/hooks/use-settlements";
import { formatPaise, paiseToRupeeInput, rupeesToPaise } from "@splittingwisdom/shared";

export interface SettleTarget {
  /** Who we're settling with, in words: "Ravi". */
  displayName: string;
  /** True when the current user is the one paying. */
  iPay: boolean;
  /** What's outstanding in this direction, in paise (> 0). The dialog never lets the amount exceed it. */
  outstanding: number;
  /** How to record it. The amount, note and date are filled in by the dialog. */
  buildRequest: (fields: { amount: number; note?: string; settlementDate?: string }) => SettlementRequest;
}

const SUCCESS_CLOSE_MS = 1300;

function todayLocal(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Parses what a person typed into integer paise, or null if it isn't a clean amount. */
function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  try {
    return rupeesToPaise(cleaned);
  } catch {
    return null;
  }
}

export function SettleDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: SettleTarget;
}) {
  const create = useCreateSettlement();
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Snapshot of what was owed when the dialog opened. Recording the payment
  // refreshes the balances behind it, which changes `target.outstanding` —
  // resetting the form off that would wipe the success screen immediately.
  const [outstanding, setOutstanding] = useState(target.outstanding);
  // One key per dialog opening: every attempt for this payment carries it, so
  // a retry is recognised as the same payment rather than a second one.
  const idempotencyKey = useRef("");
  // State updates are async, so two quick taps could both see "not submitting";
  // a ref flips synchronously and actually blocks the second one.
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    setOutstanding(target.outstanding);
    setAmountText(paiseToRupeeInput(target.outstanding));
    setNote("");
    setDate(todayLocal());
    setError(null);
    setDone(false);
    submitting.current = false;
    idempotencyKey.current = crypto.randomUUID();
    // Deliberately only on open: see the snapshot comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => onOpenChange(false), SUCCESS_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [done, onOpenChange]);

  const amount = parseAmount(amountText);
  const amountProblem =
    amountText.trim() === ""
      ? "Enter an amount."
      : amount === null
        ? "Enter a valid amount, like 250 or 250.50."
        : amount <= 0
          ? "Enter an amount greater than zero."
          : amount > outstanding
            ? `That's more than is owed. The most you can settle is ${formatPaise(outstanding)}.`
            : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current || amountProblem !== null || amount === null) return;
    submitting.current = true;
    setError(null);
    try {
      await create.mutateAsync({
        request: target.buildRequest({
          amount,
          note: note.trim() || undefined,
          settlementDate: date || undefined,
        }),
        idempotencyKey: idempotencyKey.current,
      });
      setDone(true);
    } catch (err) {
      submitting.current = false;
      setError(err instanceof ApiError ? err.message : "Couldn't record the payment. Try again.");
    }
  }

  const sentence = target.iPay ? (
    <>
      You are paying <strong className="font-semibold text-foreground">{target.displayName}</strong>
    </>
  ) : (
    <>
      <strong className="font-semibold text-foreground">{target.displayName}</strong> is paying you
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {done ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center" role="status" aria-live="polite">
            <span className="settle-check flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-success-ink">
              <Check className="h-9 w-9" strokeWidth={3} aria-hidden="true" />
            </span>
            <p className="text-lg font-semibold">Payment recorded</p>
            <p className="text-sm text-muted-foreground">
              {amount !== null ? formatPaise(amount) : ""} {target.iPay ? "paid to" : "received from"} {target.displayName}
            </p>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Settle up</DialogTitle>
              <DialogDescription>
                {sentence}. Outstanding:{" "}
                <span className="tabular-currency font-medium text-foreground">{formatPaise(outstanding)}</span>
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="settle-amount">Amount (₹)</Label>
                <Input
                  id="settle-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-invalid={amountProblem !== null}
                  aria-describedby="settle-amount-help"
                  className="tabular-currency"
                />
                <div className="flex items-start justify-between gap-3">
                  <p
                    id="settle-amount-help"
                    role={amountProblem ? "alert" : undefined}
                    className={amountProblem ? "flex items-start gap-1.5 text-xs text-coral-ink" : "text-xs text-muted-foreground"}
                  >
                    {amountProblem ? (
                      <>
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {amountProblem}
                      </>
                    ) : amount !== null && amount < outstanding ? (
                      `Partial payment — ${formatPaise(outstanding - amount)} will still be outstanding.`
                    ) : (
                      "Paying the full amount."
                    )}
                  </p>
                  {amount !== outstanding && (
                    <button
                      type="button"
                      onClick={() => setAmountText(paiseToRupeeInput(outstanding))}
                      className="shrink-0 text-xs font-medium text-mint-ink hover:underline"
                    >
                      Pay full
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-note">Note (optional)</Label>
                <Input id="settle-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. paid via UPI" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-date">Date</Label>
                <Input id="settle-date" type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} />
              </div>
              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-sm text-coral-ink">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={create.isPending || amountProblem !== null}>
                  {create.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Confirm
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
