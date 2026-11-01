import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";

export type SettlementRequest =
  | { mode: "person"; personId: string; amount: number; note?: string; settlementDate?: string }
  | {
      mode: "pair";
      groupId: number;
      payerMemberId: number;
      recipientMemberId: number;
      amount: number;
      note?: string;
      settlementDate?: string;
    };

interface CreatedSettlements {
  settlements: { id: number; groupId: number; amount: number }[];
  totalAmount: number;
}

/**
 * Records a payment. `idempotencyKey` must be stable for one user action, so
 * a retry (double tap, flaky network) can never record the payment twice.
 */
export function useCreateSettlement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ request, idempotencyKey }: { request: SettlementRequest; idempotencyKey: string }) =>
      apiFetch<CreatedSettlements>("/api/settlements", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(request),
      }),
    onSuccess: () => {
      // A payment changes every balance-derived surface; a stale balance on
      // screen after settling is a bug, so refresh all of them.
      for (const key of ["balances", "groups", "dashboard", "activity", "bills"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
