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
import { useDeleteBill } from "@/hooks/use-bills";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export function DeleteBillAlert({
  billId,
  groupId,
  description,
  open,
  onOpenChange,
}: {
  billId: number;
  groupId: number;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const deleteBill = useDeleteBill(billId, groupId);

  async function handleConfirm() {
    try {
      await deleteBill.mutateAsync();
      toast({ title: "Bill deleted", variant: "default" });
      navigate(`/group/${groupId}`);
    } catch (err) {
      toast({
        title: "Couldn't delete bill",
        description: err instanceof ApiError ? err.message : "Something went wrong.",
        variant: "error",
      });
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{description}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the bill and its effect on every balance. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Delete Bill</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
