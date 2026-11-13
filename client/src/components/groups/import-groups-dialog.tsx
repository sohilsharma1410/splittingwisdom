import { useRef, useState, type ChangeEvent } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, FileUp, Loader2, Receipt, Users } from "lucide-react";
import { exportedGroupTotals, formatPaise, type GroupExportFile } from "@splittingwisdom/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readExportFile, useImportGroups } from "@/hooks/use-group-transfer";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function ImportGroupsDialog({
  existingGroupNames,
  open,
  onOpenChange,
}: {
  existingGroupNames: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<GroupExportFile | null>(null);
  const [youRefs, setYouRefs] = useState<number[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef("");
  const importGroups = useImportGroups();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  function reset() {
    setChosen(null);
    setPreview(null);
    setYouRefs([]);
    setError(null);
  }

  async function handleChoose(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    reset();
    setReading(true);
    const result = await readExportFile(file);
    setReading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setChosen(file);
    setPreview(result.file);
    setYouRefs(result.file.groups.map((g) => g.exportedBy));
    idempotencyKey.current = crypto.randomUUID();
  }

  async function handleImport() {
    if (!chosen || !preview) return;
    setError(null);
    try {
      const { groupIds } = await importGroups.mutateAsync({ file: chosen, youRefs, idempotencyKey: idempotencyKey.current });
      toast({ title: `Imported ${groupIds.length} group${groupIds.length === 1 ? "" : "s"}`, variant: "success" });
      onOpenChange(false);
      reset();
      if (groupIds.length === 1) navigate(`/group/${groupIds[0]}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import. Nothing was saved. Try again.");
    }
  }

  const existing = new Set(existingGroupNames.map((n) => n.trim().toLowerCase()));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && importGroups.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import groups</DialogTitle>
          <DialogDescription>
            Choose a file made with Export. Everything in it is added as new groups. Your existing groups are
            never changed.
          </DialogDescription>
        </DialogHeader>

        <div>
          <input
            id="import-file"
            type="file"
            accept=".json,application/json"
            onChange={handleChoose}
            className="peer sr-only"
            disabled={reading || importGroups.isPending}
          />
          <Label
            htmlFor="import-file"
            className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-4 text-sm hover:bg-foreground/5 peer-focus-visible:ring-2 peer-focus-visible:ring-mint"
          >
            {reading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileUp className="h-4 w-4" aria-hidden="true" />}
            {reading ? "Checking the file…" : chosen ? `${chosen.name} (choose another)` : "Choose export file"}
          </Label>
        </div>

        {preview && (
          <ul className="space-y-3" aria-label="Groups in this file">
            {preview.groups.map((group, index) => {
              const totals = exportedGroupTotals(group);
              return (
                <li key={index} className="space-y-3 rounded-xl border border-border p-3">
                  <div>
                    <p className="font-medium">{group.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Receipt className="h-3.5 w-3.5" aria-hidden="true" />
                        {totals.billCount} bill{totals.billCount === 1 ? "" : "s"} ·{" "}
                        <span className="tabular-currency">{formatPaise(totals.spent)}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" aria-hidden="true" />
                        {group.members.map((m) => m.displayName).join(", ")}
                      </span>
                      {totals.receiptCount > 0 && <span>{totals.receiptCount} receipt photo{totals.receiptCount === 1 ? "" : "s"}</span>}
                    </p>
                  </div>
                  {existing.has(group.name.trim().toLowerCase()) && (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-coral-ink" aria-hidden="true" />
                      You already have a group called “{group.name}”. Importing adds a second one; it doesn't
                      merge.
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor={`import-you-${index}`}>Which one is you?</Label>
                    <Select
                      value={String(youRefs[index])}
                      onValueChange={(value) => setYouRefs((refs) => refs.map((r, i) => (i === index ? Number(value) : r)))}
                    >
                      <SelectTrigger id={`import-you-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {group.members.map((m) => (
                          <SelectItem key={m.ref} value={String(m.ref)}>
                            {m.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {preview && (
          <p className="text-xs text-muted-foreground">
            Everyone else is added by name. They can join with the group's invite link and pick their name to
            take it over.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-coral-ink">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importGroups.isPending}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!preview || importGroups.isPending}>
            {importGroups.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {preview ? `Import ${preview.groups.length} group${preview.groups.length === 1 ? "" : "s"}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
