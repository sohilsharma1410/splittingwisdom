import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useExportGroups } from "@/hooks/use-group-transfer";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function ExportGroupsDialog({
  groups,
  preselected,
  open,
  onOpenChange,
}: {
  groups: { id: number; name: string }[];
  /** Ticked when the dialog opens. Defaults to every group. */
  preselected?: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exportGroups = useExportGroups();
  const { toast } = useToast();

  function toggle(id: number, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleExport() {
    setError(null);
    const groupIds = groups.map((g) => g.id).filter((id) => selected.has(id));
    try {
      const file = await exportGroups.mutateAsync({ groupIds, includeReceipts });
      const bills = file.groups.reduce((sum, g) => sum + g.bills.length, 0);
      toast({
        title: `Exported ${file.groups.length} group${file.groups.length === 1 ? "" : "s"}, ${bills} bill${bills === 1 ? "" : "s"}`,
        description: "Check your downloads folder.",
        variant: "success",
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't export. Try again.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSelected(new Set(preselected ?? groups.map((g) => g.id)));
          setIncludeReceipts(false);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export groups</DialogTitle>
          <DialogDescription>
            Saves the groups, their members, bills, splits and settlements to one file. Import it later to get
            them back as new groups.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Groups</legend>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {groups.map((group) => (
              <label key={group.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-foreground/5">
                <Checkbox checked={selected.has(group.id)} onCheckedChange={(on) => toggle(group.id, on === true)} />
                <span className="truncate text-sm">{group.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3">
          <Checkbox className="mt-0.5" checked={includeReceipts} onCheckedChange={(on) => setIncludeReceipts(on === true)} />
          <span className="text-sm">
            Include receipt photos
            <span className="block text-xs text-muted-foreground">Makes the file much bigger: about 1 MB per photo.</span>
          </span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-coral-ink">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={selected.size === 0 || exportGroups.isPending}>
            {exportGroups.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            Export{selected.size > 0 ? ` ${selected.size}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
