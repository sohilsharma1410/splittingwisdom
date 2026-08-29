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

export interface BalanceDetail {
  personId: string;
  displayName: string;
  netAmount: number;
  contributingBills: ContributingBill[];
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
