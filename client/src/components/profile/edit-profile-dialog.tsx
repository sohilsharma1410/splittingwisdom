import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
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
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";
import { useAuth, useUpdateProfile } from "@/hooks/use-auth";

export function EditProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useAuth();
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.displayName);
    setPhone(user.phone ?? "");
    setError(null);
  }, [open, user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await updateProfile.mutateAsync({
        displayName: displayName.trim(),
        phone: phone.trim() === "" ? null : phone.trim(),
      });
      toast({ title: "Profile updated", variant: "success" });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save your profile. Try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            Your phone number lets other registered users find and add you directly, without an invite link.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-phone">Phone (optional)</Label>
            <Input
              id="profile-phone"
              placeholder="+91 98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
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
            <Button type="submit" disabled={updateProfile.isPending}>
              {updateProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
