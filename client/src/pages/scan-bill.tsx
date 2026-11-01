import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useLocation, useSearch } from "wouter";
import { AlertCircle, AlertTriangle, Camera, ImagePlus, Loader2, Plus, ScanLine, Trash2 } from "lucide-react";
import { formatPaise } from "@splittingwisdom/shared";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/hooks/use-auth";
import { useCreateBill, useExtractReceipt, type ExtractResponse } from "@/hooks/use-bills";
import { useGroup, useGroups } from "@/hooks/use-groups";
import { ApiError } from "@/lib/query-client";
import {
  blankItem,
  buildCreateBill,
  computeTotals,
  draftFromExtraction,
  itemsNeedingReview,
  mismatchOf,
  roundOffToMatchReceipt,
  type ReceiptDraft,
} from "@/lib/receipt-draft";
import { cn } from "@/lib/utils";

const ACCEPT = "image/jpeg,image/png,image/webp";
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Scan a receipt -> check what was read -> confirm the bill. */
export default function ScanBill() {
  const search = useSearch();
  const lockedGroup = Number(new URLSearchParams(search).get("group")) || null;
  const extract = useExtractReceipt();
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhoto({ file, url: URL.createObjectURL(file) });
    setResult(null);
    extract.mutate(file, { onSuccess: setResult });
  }

  function startOver() {
    setPhoto(null);
    setResult(null);
    extract.reset();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <BackButton fallbackHref="/" />
        <div>
          <h1 className="text-2xl font-semibold">Scan a receipt</h1>
          <p className="text-sm text-muted-foreground">We read it, you check it, then it becomes a bill.</p>
        </div>
      </header>

      {!photo && <PickPhoto onPick={onPick} />}

      {photo && extract.isPending && <Reading photoUrl={photo.url} />}

      {photo && extract.isError && (
        <div role="alert" className="space-y-3 rounded-xl border border-border bg-surface p-5">
          <p className="flex items-start gap-2 text-sm text-coral-ink">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {extract.error instanceof ApiError ? extract.error.message : "Couldn't upload the photo."}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => extract.mutate(photo.file, { onSuccess: setResult })}>Try again</Button>
            <Button variant="ghost" onClick={startOver}>Choose another photo</Button>
          </div>
        </div>
      )}

      {photo && result && (
        <ReviewForm key={result.imagePath} photoUrl={photo.url} result={result} lockedGroup={lockedGroup} onStartOver={startOver} />
      )}
    </div>
  );
}

function PickPhoto({ onPick }: { onPick: (e: ChangeEvent<HTMLInputElement>) => void }) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  return (
    <section className="space-y-4 rounded-xl border border-dashed border-border bg-surface p-8 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mint/15 text-mint-ink">
        <ScanLine className="h-7 w-7" aria-hidden="true" />
      </span>
      <div>
        <h2 className="text-lg font-semibold">Add a photo of the receipt</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Lay it flat in good light with all the lines in view. JPG, PNG or WebP.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={() => camera.current?.click()}>
          <Camera className="h-4 w-4" aria-hidden="true" />
          Take a photo
        </Button>
        <Button variant="outline" onClick={() => gallery.current?.click()}>
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          Choose from gallery
        </Button>
      </div>
      <input ref={camera} type="file" accept={ACCEPT} capture="environment" className="hidden" onChange={onPick} aria-label="Take a photo of the receipt" />
      <input ref={gallery} type="file" accept={ACCEPT} className="hidden" onChange={onPick} aria-label="Choose a receipt photo" />
    </section>
  );
}

function Reading({ photoUrl }: { photoUrl: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <img src={photoUrl} alt="Your receipt" className="max-h-64 w-full rounded-xl border border-border object-contain md:max-h-[70vh]" />
      <div className="space-y-3" role="status" aria-live="polite">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-mint-ink" aria-hidden="true" />
          Reading receipt…
        </p>
        {slow && <p className="text-xs text-muted-foreground">Still reading — long receipts and slower models can take a minute.</p>}
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-11" />)}
      </div>
    </div>
  );
}

function ReviewForm({ photoUrl, result, lockedGroup, onStartOver }: { photoUrl: string; result: ExtractResponse; lockedGroup: number | null; onStartOver: () => void }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const createBill = useCreateBill();
  const groups = useGroups();

  const initial = useMemo(() => draftFromExtraction(result.extraction, today()), [result]);
  const [draft, setDraft] = useState<ReceiptDraft>(initial);
  const [dirty, setDirty] = useState(false);
  const [groupId, setGroupId] = useState<number | null>(lockedGroup);
  const [payerMemberId, setPayerMemberId] = useState<number | null>(null);
  const [splitIds, setSplitIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const group = useGroup(groupId ?? 0);
  const members = group.data?.group.members ?? [];

  // One group on the account: no need to make them pick it.
  useEffect(() => {
    if (groupId === null && groups.data?.groups.length === 1) setGroupId(groups.data.groups[0].id);
  }, [groups.data, groupId]);

  // Whenever the group's people load, default to "paid by me, split between everyone".
  useEffect(() => {
    if (members.length === 0) return;
    setSplitIds(members.map((m) => m.id));
    setPayerMemberId(members.find((m) => m.userId === user?.id)?.id ?? members[0].id);
  }, [group.data?.group.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Partial<ReceiptDraft>) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); };
  const editItem = (key: string, patch: Partial<ReceiptDraft["items"][number]>) =>
    edit({ items: draft.items.map((i) => (i.key === key ? { ...i, ...patch, low: patch.low ?? false } : i)) });

  const totals = computeTotals(draft);
  const mismatch = mismatchOf(draft);
  const review = itemsNeedingReview(draft);
  const failed = result.extractionFailed || !result.extraction;

  async function confirm() {
    setError(null);
    const built = buildCreateBill(draft, { groupId, payerMemberId, memberIds: splitIds, imagePath: result.imagePath });
    if (!built.ok) { setError(built.message); return; }
    try {
      const created = await createBill.mutateAsync(built.input);
      toast({ title: "Bill saved", variant: "success" });
      navigate(`/bill/${created.bill.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the bill. Try again.");
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="md:sticky md:top-4 md:self-start">
        <button type="button" onClick={() => setZoom(true)} className="block w-full" aria-label="View the full receipt photo">
          <img src={photoUrl} alt="Your receipt" className="max-h-56 w-full rounded-xl border border-border object-contain md:max-h-[70vh]" />
        </button>
        <p className="mt-2 text-xs text-muted-foreground">
          {failed ? "Photo saved." : `Read by ${result.ocr?.model ?? "the receipt reader"}.`} Tap the photo to enlarge it.
        </p>
      </div>

      <div className="space-y-6">
        {failed && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-border bg-surface p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-coral-ink" aria-hidden="true" />
            Couldn't read this receipt — add the items manually. Your photo is kept with the bill.
          </p>
        )}

        {!failed && (review.length > 0 || draft.lowOverall) && (
          <section aria-label="Needs review" className="rounded-xl border-2 border-warn bg-surface p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-warn">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Please check {review.length > 0 ? `${review.length} line${review.length === 1 ? "" : "s"}` : "the whole receipt"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {draft.lowOverall && "The photo was hard to read, so look over every line. "}
              {review.length > 0 && <>The reader wasn't sure about: {review.map((i) => i.name || "an unnamed line").join(", ")}.</>}
            </p>
          </section>
        )}

        {mismatch && (
          <section role="alert" aria-label="Totals don't match" className="space-y-2 rounded-xl border-2 border-warn bg-surface p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-warn">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              The total doesn't match the receipt
            </h2>
            <p className="tabular-currency text-sm text-muted-foreground">
              Items and charges add up to {formatPaise(mismatch.computed)}, but the receipt total reads {formatPaise(mismatch.receiptTotal)} — off by {formatPaise(Math.abs(mismatch.delta))}.
              Fix a price or charge above, or:
            </p>
            <Button size="sm" variant="outline" onClick={() => edit({ roundOff: roundOffToMatchReceipt(draft) })}>
              Treat the difference as round-off
            </Button>
          </section>
        )}

        <section className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="scan-name">Bill name</Label>
            <Input id="scan-name" value={draft.description} onChange={(e) => edit({ description: e.target.value })} placeholder="e.g. Dinner at Ganbei" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="scan-date">Date</Label>
              <Input id="scan-date" type="date" value={draft.billDate} max={today()} onChange={(e) => edit({ billDate: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="scan-group">Group</Label>
              <Select value={groupId !== null ? String(groupId) : undefined} onValueChange={(v) => { setGroupId(Number(v)); setDirty(true); }} disabled={lockedGroup !== null}>
                <SelectTrigger id="scan-group"><SelectValue placeholder="Choose a group" /></SelectTrigger>
                <SelectContent>
                  {(groups.data?.groups ?? []).map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {groups.data && groups.data.groups.length === 0 && (
            <p className="text-sm text-muted-foreground">You need a group first. Create one from the Groups page, then scan again.</p>
          )}
          {groupId !== null && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="scan-payer">Paid by</Label>
                {group.isLoading ? <Skeleton className="h-10" /> : (
                  <Select value={payerMemberId !== null ? String(payerMemberId) : undefined} onValueChange={(v) => setPayerMemberId(Number(v))}>
                    <SelectTrigger id="scan-payer"><SelectValue placeholder="Who paid?" /></SelectTrigger>
                    <SelectContent>{members.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.displayName}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="space-y-3" aria-label="Items">
          <h2 className="text-lg font-semibold">Items</h2>
          <ul className="space-y-2">
            {draft.items.map((item, index) => (
              <li key={item.key} className={cn("rounded-xl border bg-surface p-3", item.low ? "border-2 border-warn" : "border-border")}>
                {item.low && (
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-warn">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    Please check this line
                  </p>
                )}
                <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-2 sm:grid-cols-[minmax(0,1fr)_4.5rem_8rem_2.5rem]">
                  <Input aria-label={`Item ${index + 1} name`} value={item.name} onChange={(e) => editItem(item.key, { name: e.target.value })} placeholder="Item name" className="col-span-1" />
                  <Input aria-label={`Item ${index + 1} quantity`} inputMode="numeric" value={item.quantity} onChange={(e) => editItem(item.key, { quantity: e.target.value })} className="text-center" />
                  <div className="col-span-1 sm:col-span-1"><CurrencyInput aria-label={`Item ${index + 1} price`} value={item.price} onChange={(e) => editItem(item.key, { price: e.target.value })} placeholder="0.00" /></div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove item ${index + 1}`} disabled={draft.items.length === 1} onClick={() => edit({ items: draft.items.filter((i) => i.key !== item.key) })}>
                    <Trash2 className="h-4 w-4 text-coral-ink" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">The price is the whole line as printed (for example 4 naan = ₹60 in total).</p>
          <Button type="button" variant="outline" size="sm" onClick={() => edit({ items: [...draft.items, blankItem()] })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add an item
          </Button>
        </section>

        <section className="space-y-3" aria-label="Charges">
          <h2 className="text-lg font-semibold">Charges</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {([["tax", "Tax (GST)"], ["service", "Service charge"], ["tip", "Tip"], ["discount", "Discount"]] as const).map(([field, label]) => (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={`scan-${field}`}>{label}</Label>
                <CurrencyInput id={`scan-${field}`} value={draft[field]} onChange={(e) => edit({ [field]: e.target.value })} placeholder="0.00" />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="scan-roundoff">Round-off (use − for a minus)</Label>
              <CurrencyInput id="scan-roundoff" value={draft.roundOff} onChange={(e) => edit({ roundOff: e.target.value })} placeholder="0.00" />
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-surface p-4" aria-label="Total">
          <dl className="tabular-currency space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Items</dt><dd>{formatPaise(totals.itemsSubtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Charges{totals.discount ? " less discount" : ""}</dt><dd>{formatPaise(totals.grandTotal - totals.itemsSubtotal)}</dd></div>
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><dt>Total</dt><dd data-testid="scan-total">{formatPaise(totals.grandTotal)}</dd></div>
            {draft.receiptTotal !== null && <div className="flex justify-between text-xs text-muted-foreground"><dt>Receipt says</dt><dd>{formatPaise(draft.receiptTotal)}</dd></div>}
          </dl>
        </section>

        {groupId !== null && members.length > 0 && (
          <section className="space-y-2" aria-label="Split between">
            <h2 className="text-lg font-semibold">Split equally between</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {members.map((m) => (
                <li key={m.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface p-3 text-sm">
                    <Checkbox checked={splitIds.includes(m.id)} onCheckedChange={(on) => setSplitIds((ids) => (on ? [...ids, m.id] : ids.filter((id) => id !== m.id)))} />
                    {m.displayName}
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Every item is split equally between these people. After saving you can change who had what, item by item.</p>
          </section>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-2 text-sm text-coral-ink">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button onClick={confirm} disabled={createBill.isPending}>
            {createBill.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Confirm bill
          </Button>
          <Button variant="ghost" onClick={() => (dirty ? setLeaveOpen(true) : onStartOver())}>Scan a different photo</Button>
        </div>
      </div>

      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="md:max-w-2xl">
          <DialogHeader><DialogTitle>Receipt</DialogTitle></DialogHeader>
          <img src={photoUrl} alt="Your receipt, full size" className="max-h-[75vh] w-full rounded-lg object-contain" />
        </DialogContent>
      </Dialog>

      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>You've edited what was read. Scanning a different photo throws those edits away.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={onStartOver}>Discard and rescan</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
