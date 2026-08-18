import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocation } from "wouter";
import { X, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateGroup } from "@/hooks/use-groups";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function CreateGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const createGroup = useCreateGroup();

  const [name, setName] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setMemberInput("");
    setMembers([]);
    setError(null);
  }

  function addMember() {
    const trimmed = memberInput.trim();
    if (!trimmed) return;
    const exists = members.some((m) => m.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      setError(`"${trimmed}" is already added.`);
      return;
    }
    setMembers((current) => [...current, trimmed]);
    setMemberInput("");
    setError(null);
  }

  function handleMemberKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addMember();
    }
  }

  function removeMember(name: string) {
    setMembers((current) => current.filter((m) => m !== name));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Group name is required.");
      return;
    }

    try {
      const result = await createGroup.mutateAsync({ name: name.trim(), memberNames: members });
      toast({ title: "Group created", variant: "success" });
      onOpenChange(false);
      reset();
      navigate(`/group/${result.group.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a group</DialogTitle>
          <DialogDescription>
            Add the people you're splitting expenses with. You can add more later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              required
              placeholder="Goa Trip"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="member-input">Members</Label>
            <div className="flex gap-2">
              <Input
                id="member-input"
                placeholder="Type a name and press Enter"
                value={memberInput}
                onChange={(e) => setMemberInput(e.target.value)}
                onKeyDown={handleMemberKeyDown}
              />
              <Button type="button" variant="outline" onClick={addMember}>
                Add
              </Button>
            </div>
            {members.length > 0 && (
              <ul className="flex flex-wrap gap-2 pt-2" aria-label="Added members">
                {members.map((m) => (
                  <li
                    key={m}
                    className="flex items-center gap-1.5 rounded-full bg-mint/15 py-1 pl-3 pr-1.5 text-sm text-mint"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => removeMember(m)}
                      aria-label={`Remove ${m}`}
                      className="rounded-full p-0.5 hover:bg-mint/20"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
            <Button type="submit" disabled={createGroup.isPending}>
              {createGroup.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Create Group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
