import { useState } from "react";
import { useParams } from "wouter";
import { MoreVertical, Pencil, Trash2, X, Receipt, Plus } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { InitialsAvatar } from "@/components/ui/avatar";
import { InviteLinkCard } from "@/components/groups/invite-link-card";
import { AddMemberForm } from "@/components/groups/add-member-form";
import { RenameGroupDialog } from "@/components/groups/rename-group-dialog";
import { DeleteGroupAlert } from "@/components/groups/delete-group-alert";
import { RemoveMemberAlert } from "@/components/groups/remove-member-alert";
import { BillFormDialog } from "@/components/bills/bill-form-dialog";
import { BillCard } from "@/components/bills/bill-card";
import { useGroup, type GroupMemberDetail } from "@/hooks/use-groups";
import { useGroupBills } from "@/hooks/use-bills";
import { useAuth } from "@/hooks/use-auth";
import { formatPaise } from "@splittingwisdom/shared";

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);
  const { user } = useAuth();
  const { data, isLoading, isError, refetch } = useGroup(groupId);
  const { data: billsData, isLoading: billsLoading } = useGroupBills(groupId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newBillOpen, setNewBillOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<GroupMemberDetail | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (isError || !data) {
    return <ErrorState message="Couldn't load this group." onRetry={() => refetch()} />;
  }

  const { group } = data;
  const isCreator = group.createdBy === user?.id;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <BackButton fallbackHref="/groups" />
          <div>
            <h1 className="text-3xl font-semibold">{group.name}</h1>
            <p className="mt-1 text-muted-foreground">
              {group.members.length} member{group.members.length === 1 ? "" : "s"} ·{" "}
              {billsData?.bills.length ?? 0} bill{billsData?.bills.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Group settings"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
            >
              <MoreVertical className="h-5 w-5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Rename group
            </DropdownMenuItem>
            {isCreator && (
              <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-coral">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete group
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Members</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {group.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4"
            >
              <InitialsAvatar name={member.displayName} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.displayName}
                  {member.userId === user?.id && (
                    <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {member.balance === 0
                    ? "Settled"
                    : formatPaise(Math.abs(member.balance))}
                  {!member.isLinked && " · not signed up yet"}
                </p>
              </div>
              {isCreator && member.userId !== user?.id && (
                <button
                  onClick={() => setRemoveTarget(member)}
                  aria-label={`Remove ${member.displayName}`}
                  className="text-muted-foreground hover:text-coral"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
        <AddMemberForm groupId={group.id} />
      </section>

      <section>
        <InviteLinkCard inviteToken={group.inviteToken} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Bills</h2>
          <Button size="sm" variant="outline" onClick={() => setNewBillOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add Bill
          </Button>
        </div>

        {billsLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        )}

        {!billsLoading && billsData && billsData.bills.length === 0 && (
          <EmptyState
            icon={Receipt}
            heading="No bills yet"
            description="Add a bill and split it equally among the people involved."
            action={<Button onClick={() => setNewBillOpen(true)}>Add Bill</Button>}
          />
        )}

        {!billsLoading && billsData && billsData.bills.length > 0 && (
          <div className="space-y-2">
            {billsData.bills.map((bill) => (
              <BillCard key={bill.id} bill={bill} />
            ))}
          </div>
        )}
      </section>

      <BillFormDialog open={newBillOpen} onOpenChange={setNewBillOpen} lockedGroupId={group.id} />

      <RenameGroupDialog
        groupId={group.id}
        currentName={group.name}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteGroupAlert
        groupId={group.id}
        groupName={group.name}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
      {removeTarget && (
        <RemoveMemberAlert
          groupId={group.id}
          memberId={removeTarget.id}
          memberName={removeTarget.displayName}
          open={!!removeTarget}
          onOpenChange={(open) => !open && setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
