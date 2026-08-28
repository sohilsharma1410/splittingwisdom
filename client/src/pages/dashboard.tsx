import { useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { LayoutDashboard, Users, Receipt, TrendingUp, TrendingDown, CheckCircle2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { BillFormDialog } from "@/components/bills/bill-form-dialog";
import { useGroups } from "@/hooks/use-groups";
import { useBalances } from "@/hooks/use-balances";
import { useActivity } from "@/hooks/use-bills";
import { formatPaise } from "@splittingwisdom/shared";
import { parseDateOnly } from "@/lib/date";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const [newBillOpen, setNewBillOpen] = useState(false);
  const groupsQuery = useGroups();
  const balancesQuery = useBalances();
  const activityQuery = useActivity();

  const isLoading = groupsQuery.isLoading || balancesQuery.isLoading || activityQuery.isLoading;
  const isError = groupsQuery.isError || balancesQuery.isError || activityQuery.isError;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !groupsQuery.data || !balancesQuery.data || !activityQuery.data) {
    return (
      <ErrorState
        message="Couldn't load your dashboard."
        onRetry={() => {
          groupsQuery.refetch();
          balancesQuery.refetch();
          activityQuery.refetch();
        }}
      />
    );
  }

  const { netBalance, balances } = balancesQuery.data;
  const recentBills = activityQuery.data.bills.slice(0, 5);
  const hasNothingYet = groupsQuery.data.groups.length === 0;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-muted-foreground">
            See what's owed, what you owe, and what needs attention.
          </p>
        </div>
        <Button onClick={() => setNewBillOpen(true)} className="hidden md:inline-flex">
          New Bill
        </Button>
      </header>

      {hasNothingYet ? (
        <EmptyState
          icon={LayoutDashboard}
          heading="Your dashboard is empty for now"
          description="Create a group and add a bill to see your balances and activity here."
          action={<Button onClick={() => setNewBillOpen(true)}>New Bill</Button>}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Link href="/balances" className="rounded-xl border border-border bg-surface p-4 hover:shadow-md">
              <p className="text-sm text-muted-foreground">Net balance</p>
              <p
                className={cn(
                  "tabular-currency mt-1 text-2xl font-semibold",
                  netBalance > 0 && "text-success",
                  netBalance < 0 && "text-coral",
                )}
              >
                {netBalance === 0 ? "Settled" : formatPaise(Math.abs(netBalance))}
              </p>
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                {netBalance === 0 ? (
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : netBalance > 0 ? (
                  <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {netBalance === 0 ? "All settled" : netBalance > 0 ? "Owed to you" : "You owe"}
              </p>
            </Link>
            <Link href="/groups" className="rounded-xl border border-border bg-surface p-4 hover:shadow-md">
              <p className="text-sm text-muted-foreground">Active groups</p>
              <p className="mt-1 flex items-center gap-2 text-2xl font-semibold">
                <Users className="h-5 w-5 text-mint" aria-hidden="true" />
                {groupsQuery.data.groups.length}
              </p>
            </Link>
            <Link href="/activity" className="rounded-xl border border-border bg-surface p-4 hover:shadow-md">
              <p className="text-sm text-muted-foreground">Recent bills</p>
              <p className="mt-1 flex items-center gap-2 text-2xl font-semibold">
                <Receipt className="h-5 w-5 text-mint" aria-hidden="true" />
                {activityQuery.data.bills.length}
              </p>
            </Link>
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recent activity</h2>
              <Link href="/activity" className="text-sm text-mint hover:underline">
                View all
              </Link>
            </div>
            {recentBills.length === 0 ? (
              <EmptyState icon={Receipt} heading="No bills yet" description="Bills you add will show up here." />
            ) : (
              <div className="space-y-2">
                {recentBills.map((bill) => (
                  <Link
                    key={bill.id}
                    href={`/bill/${bill.id}`}
                    className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4 pr-20 hover:shadow-md md:pr-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{bill.description}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {bill.groupName} · {format(parseDateOnly(bill.billDate), "d MMM yyyy")} · Paid by{" "}
                        {bill.paidByName}
                      </p>
                    </div>
                    <span className="tabular-currency shrink-0 font-semibold">
                      {formatPaise(bill.grandTotal)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Outstanding balances</h2>
            {balances.filter((b) => b.netAmount !== 0).length === 0 ? (
              <EmptyState icon={CheckCircle2} heading="All settled up" description="No outstanding balances." />
            ) : (
              <div className="space-y-2">
                {balances
                  .filter((b) => b.netAmount !== 0)
                  .map((b) => (
                    <Link
                      key={b.personId}
                      href={`/balance/${b.personId}`}
                      className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 pr-20 hover:shadow-md md:pr-4"
                    >
                      <InitialsAvatar name={b.displayName} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{b.displayName}</p>
                        <p className="text-xs text-muted-foreground">{b.netAmount > 0 ? "owes you" : "you owe"}</p>
                      </div>
                      <span
                        className={cn(
                          "tabular-currency shrink-0 text-sm font-semibold",
                          b.netAmount > 0 ? "text-success" : "text-coral",
                        )}
                      >
                        {formatPaise(Math.abs(b.netAmount))}
                      </span>
                    </Link>
                  ))}
              </div>
            )}
          </section>
        </>
      )}

      <BillFormDialog open={newBillOpen} onOpenChange={setNewBillOpen} />
    </div>
  );
}
