import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useSettle } from "@/hooks/use-settle";
import type { GroupDetail, GroupPayment } from "@/hooks/use-groups";
import { formatPaise } from "@splittingwisdom/shared";
import { cn } from "@/lib/utils";

type View = "direct" | "simplified";

/**
 * Who owes whom in a group. Direct debts (today's real, traceable pairs) are
 * the default; the simplified view is a suggestion for fewer payments — it
 * never changes the ledger. Tapping a payment you're part of opens the same
 * settlement dialog, pre-filled.
 */
export function SettleUpSection({ group }: { group: GroupDetail }) {
  const { user } = useAuth();
  const { openSettle } = useSettle();
  const [view, setView] = useState<View>("direct");
  const hasDebts = group.debts.length > 0;

  // Arriving from "Fewer payments possible" on the Balances page: show the
  // simplified view and bring this section into view.
  useEffect(() => {
    if (!hasDebts || window.location.hash !== "#settle-up") return;
    setView("simplified");
    document.getElementById("settle-up")?.scrollIntoView({ block: "start" });
  }, [hasDebts]);

  if (!hasDebts) return null;

  const myMemberId = group.members.find((m) => m.userId === user?.id)?.id;
  const nameOf = (memberId: number) => group.members.find((m) => m.id === memberId)?.displayName ?? "Someone";
  const payments = view === "direct" ? group.debts : group.simplifiedPayments;
  const alreadyMinimal = group.simplifiedPayments.length >= group.debts.length;

  const describe = (p: GroupPayment) => {
    if (p.fromMemberId === myMemberId) return { text: <>You pay <strong>{nameOf(p.toMemberId)}</strong></>, other: nameOf(p.toMemberId) };
    if (p.toMemberId === myMemberId) return { text: <><strong>{nameOf(p.fromMemberId)}</strong> pays you</>, other: nameOf(p.fromMemberId) };
    return { text: <><strong>{nameOf(p.fromMemberId)}</strong> pays <strong>{nameOf(p.toMemberId)}</strong></>, other: "" };
  };

  return (
    <section id="settle-up" className="space-y-3 scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Settle up</h2>
        {group.debts.length > 1 && (
          <div role="group" aria-label="Debt view" className="flex rounded-lg border border-border p-0.5 text-sm">
            {(
              [
                ["direct", "Direct"],
                ["simplified", "Simplified"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors",
                  view === value ? "bg-mint text-mint-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {view === "simplified" && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 text-sm text-muted-foreground">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-mint-ink" aria-hidden="true" />
          {group.simplifiedPayments.length === 0
            ? "Everyone is settled overall — nothing left to pay. The debts above cancel each other out."
            : alreadyMinimal
            ? "These are already the fewest payments that settle everyone."
            : `${group.debts.length} debts simplified to ${group.simplifiedPayments.length} payment${group.simplifiedPayments.length === 1 ? "" : "s"}. Your bills and balances stay exactly as they are — this only changes who pays whom.`}
        </p>
      )}

      <ul className="space-y-2">
        {payments.map((p) => {
          const { text, other } = describe(p);
          const involvesMe = p.fromMemberId === myMemberId || p.toMemberId === myMemberId;
          const iPay = p.fromMemberId === myMemberId;
          return (
            <li key={`${p.fromMemberId}-${p.toMemberId}`} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-sm">{text}</p>
              <span className="tabular-currency shrink-0 text-sm font-semibold">{formatPaise(p.amount)}</span>
              {involvesMe && (
                <Button
                  size="sm"
                  variant={iPay ? "coral" : "outline"}
                  className="h-8 shrink-0 px-3 text-xs"
                  onClick={() =>
                    openSettle({
                      displayName: other,
                      iPay,
                      outstanding: p.amount,
                      buildRequest: ({ amount, note, settlementDate }) => ({
                        mode: "pair",
                        groupId: group.id,
                        payerMemberId: p.fromMemberId,
                        recipientMemberId: p.toMemberId,
                        amount,
                        note,
                        settlementDate,
                      }),
                    })
                  }
                >
                  {iPay ? "Settle" : "Record payment"}
                  <span className="sr-only">{iPay ? ` ${formatPaise(p.amount)} with ${other}` : ` ${formatPaise(p.amount)} from ${other}`}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
