import { useState } from "react";
import { useParams } from "wouter";
import { MoreVertical, Pencil, Trash2, X, Receipt, Plus, Search, Download } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneySummary } from "@/components/balances/money-summary";
import { filterAndSortBills, type BillSort } from "@/lib/bill-list";
import { BackButton } from "@/components/ui/back-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { InitialsAvatar } from "@/components/ui/avatar";
import { InviteLinkCard } from "@/components/groups/invite-link-card";
import { RenameGroupDialog } from "@/components/groups/rename-group-dialog";
import { DeleteGroupAlert } from "@/components/groups/delete-group-alert";
import { ExportGroupsDialog } from "@/components/groups/export-groups-dialog";
import { RemoveMemberAlert } from "@/components/groups/remove-member-alert";
import { BillFormDialog } from "@/components/bills/bill-form-dialog";
import { BillCard } from "@/components/bills/bill-card";
import { PersonSearch } from "@/components/people/person-search";
import { useGroup, useAddMemberByUser, type GroupMemberDetail } from "@/hooks/use-groups";
import { useGroupBills } from "@/hooks/use-bills";
import { useKnownPeople, type Person } from "@/hooks/use-people";
import { useAuth } from "@/hooks/use-auth";
import { SettleUpSection } from "@/components/settlements/settle-up-section";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";
import { formatPaise } from "@splittingwisdom/shared";

const SORT_KEY = "billSort";

function readSavedSort(): BillSort {
  try {
    return localStorage.getItem(SORT_KEY) === "billDate" ? "billDate" : "added";
  } catch {
    return "added";
  }
}

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);
  const { user } = useAuth();
  const { data, isLoading, isError, refetch } = useGroup(groupId);
  const { data: billsData, isLoading: billsLoading } = useGroupBills(groupId);
  const { data: knownPeopleData } = useKnownPeople();
  const addMember = useAddMemberByUser(groupId);
  const { toast } = useToast();

  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [newBillOpen, setNewBillOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<GroupMemberDetail | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<BillSort>(readSavedSort);

  function changeSort(next: BillSort) {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Storage blocked: the choice just isn't remembered.
    }
  }

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
  const memberUserIds = group.members.filter((m) => m.userId !== null).map((m) => m.userId!);

  function goToSettleUp() {
    const section = document.getElementById("settle-up");
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    section?.querySelector("h2")?.focus({ preventScroll: true });
  }

  async function handleAddPerson(person: Person) {
    try {
      await addMember.mutateAsync(person.id);
      toast({ title: `Added ${person.displayName}`, variant: "success" });
    } catch (err) {
      toast({
        title: err instanceof ApiError ? err.message : "Couldn't add them. Try again.",
        variant: "error",
      });
      throw err; // let PersonSearch know the add failed, so it un-hides them
    }
  }

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
            {!group.isPersonal && (
              <DropdownMenuItem onSelect={() => setExportOpen(true)}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Export group
              </DropdownMenuItem>
            )}
            {isCreator && (
              <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-coral-ink">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete group
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {billsData && billsData.bills.length > 0 && (
        <MoneySummary
          {...billsData.summary}
          // Settle up only appears while someone owes something: only then do the cards lead there.
          onOpen={group.debts.length > 0 ? goToSettleUp : undefined}
          openLabel="Go to settle up"
        />
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Bills</h2>
          <Button size="sm" onClick={() => setNewBillOpen(true)}>
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
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by bill name or merchant"
                  aria-label="Search bills by name or merchant"
                  className="pl-9 pr-9"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              <div role="group" aria-label="Sort bills" className="flex shrink-0 items-center gap-2">
                <span className="text-sm text-muted-foreground">Newest by</span>
                {(
                  [
                    ["added", "Date added"],
                    ["billDate", "Bill date"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={sort === value ? "default" : "outline"}
                    aria-pressed={sort === value}
                    onClick={() => changeSort(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {(() => {
              const shown = filterAndSortBills(billsData.bills, search, sort);
              if (shown.length === 0) {
                return (
                  <EmptyState
                    icon={Search}
                    heading="No bills match"
                    description={`Nothing in this group's bill names or merchants matches "${search.trim()}".`}
                    action={
                      <Button variant="outline" onClick={() => setSearch("")}>
                        Clear search
                      </Button>
                    }
                  />
                );
              }
              return (
                <div className="space-y-2">
                  {shown.map((bill) => (
                    <BillCard key={bill.id} bill={bill} />
                  ))}
                </div>
              );
            })()}
          </>
        )}
      </section>

      <SettleUpSection group={group} />

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
                  className="text-muted-foreground hover:text-coral-ink"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">Add someone</h2>
        <PersonSearch
          onAdd={handleAddPerson}
          excludeIds={memberUserIds}
          knownPeople={knownPeopleData?.people}
        />
      </section>

      <section>
        <InviteLinkCard inviteToken={group.inviteToken} groupName={group.name} />
      </section>

      <BillFormDialog open={newBillOpen} onOpenChange={setNewBillOpen} lockedGroupId={group.id} />

      <ExportGroupsDialog
        groups={[{ id: group.id, name: group.name }]}
        preselected={[group.id]}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
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
