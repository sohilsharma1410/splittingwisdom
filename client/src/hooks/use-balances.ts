import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";

export interface BalanceSummaryItem {
  personId: string;
  displayName: string;
  netAmount: number;
  lastActivity: string;
}

export interface BalancesSummary {
  netBalance: number;
  totalOwedToMe: number;
  totalIOwe: number;
  unsettledCount: number;
  balances: BalanceSummaryItem[];
}

export interface ContributingBillItem {
  itemId: number;
  name: string;
  price: number;
  splitType: "equal" | "percentage" | "ratio" | "custom";
  share: number;
}

export interface ContributingBill {
  billId: number;
  description: string;
  groupName: string;
  billDate: string;
  payerIsMe: boolean;
  payerName: string;
  grandTotal: number;
  theirShare: number;
  items: ContributingBillItem[];
}

export interface SettlementHistoryItem {
  id: number;
  groupId: number;
  groupName: string;
  amount: number;
  /** "paid-by-me": I paid them. "paid-to-me": they paid me. */
  direction: "paid-by-me" | "paid-to-me";
  note: string | null;
  settlementDate: string;
  createdAt: string;
}

export interface BalanceDetail {
  personId: string;
  displayName: string;
  /** Signed, positive = they owe me. Already net of settlements. */
  netAmount: number;
  /** What the bills alone created (signed, positive = they owe me). */
  billsNet: number;
  /** What payments did to that (signed): billsNet + settlementsNet = netAmount. */
  settlementsNet: number;
  contributingBills: ContributingBill[];
  settlements: SettlementHistoryItem[];
}

export function useBalances() {
  return useQuery({
    queryKey: ["balances"],
    queryFn: () => apiFetch<BalancesSummary>("/api/balances"),
  });
}

export function useBalanceDetail(personId: string) {
  return useQuery({
    queryKey: ["balances", personId],
    queryFn: () => apiFetch<BalanceDetail>(`/api/balances/${personId}`),
    enabled: !!personId,
  });
}
