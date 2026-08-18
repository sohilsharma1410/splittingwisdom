import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useRemoveMember } from "@/hooks/use-groups";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function RemoveMemberAlert({
  groupId,
  memberId,
  memberName,
  open,
  onOpenChange,
}: {
  groupId: number;
  memberId: number;
  memberName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const removeMember = useRemoveMember(groupId);

  async function handleConfirm() {
    try {
      await removeMember.mutateAsync(memberId);
      toast({ title: `${memberName} removed`, variant: "default" });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Couldn't remove member",
        description: err instanceof ApiError ? err.message : "Something went wrong.",
        variant: "error",
      });
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {memberName}?</AlertDialogTitle>
          <AlertDialogDescription>
            They'll no longer be part of this group. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
