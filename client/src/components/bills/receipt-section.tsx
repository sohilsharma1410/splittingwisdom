import { useRef, useState, type ChangeEvent } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUploadReceipt, useReceiptUrl } from "@/hooks/use-bills";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function ReceiptSection({ billId, hasReceipt }: { billId: number; hasReceipt: boolean }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadReceipt(billId);
  const { toast } = useToast();
  // Fetched only once the viewer actually opens — a signed URL expires in
  // 10 minutes server-side, so there's nothing to gain from loading it early.
  const { data: receiptUrlData, isLoading: urlLoading } = useReceiptUrl(billId, viewerOpen && hasReceipt);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await upload.mutateAsync(file);
      toast({ title: "Receipt added", variant: "success" });
    } catch (err) {
      toast({
        title: err instanceof ApiError ? err.message : "Couldn't upload the receipt. Try again.",
        variant: "error",
      });
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />
      {hasReceipt ? (
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          className="flex items-center gap-1.5 text-sm font-medium text-mint hover:underline"
        >
          <Camera className="h-4 w-4" aria-hidden="true" />
          View receipt
        </button>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
          className="flex items-center gap-1.5 text-sm font-medium text-mint hover:underline disabled:opacity-50"
        >
          {upload.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Camera className="h-4 w-4" aria-hidden="true" />
          )}
          {upload.isPending ? "Uploading…" : "Add receipt photo"}
        </button>
      )}

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="md:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Receipt</DialogTitle>
          </DialogHeader>
          {urlLoading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-mint" aria-hidden="true" />
            </div>
          ) : receiptUrlData?.url ? (
            <img
              src={receiptUrlData.url}
              alt="Receipt"
              className="max-h-[75vh] w-full rounded-lg object-contain"
            />
          ) : (
            <p className="text-sm text-muted-foreground">Couldn't load the receipt image.</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
