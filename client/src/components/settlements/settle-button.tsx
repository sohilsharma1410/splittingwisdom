import { Button } from "@/components/ui/button";
import { useSettle } from "@/hooks/use-settle";
import { cn } from "@/lib/utils";

/** The person-level "Settle" action used on the dashboard, balances list and balance detail. */
export function SettleButton({
  personId,
  displayName,
  netAmount,
  size = "sm",
  className,
}: {
  personId: string;
  displayName: string;
  /** Signed: positive means they owe the current user. */
  netAmount: number;
  size?: "sm" | "default";
  className?: string;
}) {
  const { openSettle } = useSettle();
  if (netAmount === 0) return null;

  return (
    <Button
      type="button"
      size={size}
      variant={netAmount < 0 ? "coral" : "outline"}
      // These sit on cards that are themselves full-cover links; never let the click fall through to the link.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openSettle({
          displayName,
          iPay: netAmount < 0,
          outstanding: Math.abs(netAmount),
          buildRequest: ({ amount, note, settlementDate }) => ({ mode: "person", personId, amount, note, settlementDate }),
        });
      }}
      className={cn("relative z-10", size === "sm" && "h-8 px-3 text-xs", className)}
      aria-label={netAmount < 0 ? `Pay ${displayName}` : `Record a payment from ${displayName}`}
    >
      {netAmount < 0 ? "Settle" : "Record payment"}
    </Button>
  );
}
