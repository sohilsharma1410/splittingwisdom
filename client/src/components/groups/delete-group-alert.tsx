import { useLocation } from "wouter";
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
import { useDeleteGroup } from "@/hooks/use-groups";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function DeleteGroupAlert({
  groupId,
  groupName,
  open,
  onOpenChange,
}: {
  groupId: number;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const deleteGroup = useDeleteGroup(groupId);

  async function handleConfirm() {
    try {
      await deleteGroup.mutateAsync();
      toast({ title: "Group deleted", variant: "default" });
      navigate("/groups");
    } catch (err) {
      toast({
        title: "Couldn't delete group",
        description: err instanceof ApiError ? err.message : "Something went wrong.",
        variant: "error",
      });
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{groupName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the group, its members, and all its bills for everyone.
            This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Delete Group</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
