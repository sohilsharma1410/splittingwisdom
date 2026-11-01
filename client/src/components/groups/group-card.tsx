import { Link } from "wouter";
import { TrendingUp, TrendingDown, CheckCircle2 } from "lucide-react";
import { AvatarStack } from "@/components/ui/avatar";
import { formatPaise } from "@splittingwisdom/shared";
import type { GroupSummary } from "@/hooks/use-groups";

function BalanceIndicator({ amount }: { amount: number }) {
  if (amount === 0) {
    return (
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        Settled
      </span>
    );
  }
  if (amount > 0) {
    return (
      <span className="flex items-center gap-1 text-sm font-medium text-success-ink">
        <TrendingUp className="h-4 w-4" aria-hidden="true" />
        Owed {formatPaise(amount)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-sm font-medium text-coral-ink">
      <TrendingDown className="h-4 w-4" aria-hidden="true" />
      You owe {formatPaise(-amount)}
    </span>
  );
}

export function GroupCard({ group }: { group: GroupSummary }) {
  return (
    <Link
      href={`/group/${group.id}`}
      className="block rounded-xl border border-border bg-surface p-5 shadow-sm card-lift"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold">{group.name}</h3>
      </div>
      <div className="mt-3">
        <AvatarStack names={group.memberPreview} />
      </div>
      <p className="mt-4 flex gap-3 text-sm text-muted-foreground">
        <span>{group.memberCount} member{group.memberCount === 1 ? "" : "s"}</span>
        <span>{group.billCount} bill{group.billCount === 1 ? "" : "s"}</span>
      </p>
      <div className="mt-3">
        <BalanceIndicator amount={group.myBalance} />
      </div>
    </Link>
  );
}
