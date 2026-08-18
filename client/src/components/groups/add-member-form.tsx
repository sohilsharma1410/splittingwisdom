import { useState, type FormEvent } from "react";
import { UserPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAddMember } from "@/hooks/use-groups";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function AddMemberForm({ groupId }: { groupId: number }) {
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const addMember = useAddMember(groupId);
  const { toast } = useToast();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!displayName.trim()) return;

    try {
      await addMember.mutateAsync(displayName.trim());
      toast({ title: `${displayName.trim()} added`, variant: "success" });
      setDisplayName("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2" noValidate>
      <div className="flex gap-2">
        <Input
          aria-label="New member name"
          placeholder="Add a member by name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={addMember.isPending} className="shrink-0">
          {addMember.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <UserPlus className="h-4 w-4" aria-hidden="true" />
          )}
          Add
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
    </form>
  );
}
