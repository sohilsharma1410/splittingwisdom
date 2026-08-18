import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRenameGroup } from "@/hooks/use-groups";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function RenameGroupDialog({
  groupId,
  currentName,
  open,
  onOpenChange,
}: {
  groupId: number;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const rename = useRenameGroup(groupId);
  const { toast } = useToast();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Group name is required.");
      return;
    }
    try {
      await rename.mutateAsync(name.trim());
      toast({ title: "Group renamed", variant: "success" });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) setName(currentName);
        setError(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename group</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="rename-group-input">Group name</Label>
            <Input
              id="rename-group-input"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-coral">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending}>
              {rename.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
