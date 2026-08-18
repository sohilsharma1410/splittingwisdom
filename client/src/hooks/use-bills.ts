import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";

export interface GroupBillSummary {
  id: number;
  description: string;
  merchant: string | null;
  billDate: string;
  grandTotal: number;
  paidByName: string;
  status: "pending" | "settled";
  createdAt: string;
}

export interface BillShareBreakdown {
  memberId: number;
  displayName: string;
  itemShare: number;
  taxShare: number;
  tipShare: number;
  serviceFeeShare: number;
  discountShare: number;
  total: number;
}

export interface BillDetail {
  id: number;
  groupId: number;
  groupName: string;
  description: string;
  merchant: string | null;
  billDate: string;
  subtotalAmount: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
  grandTotal: number;
  paidByMemberId: number;
  paidByName: string;
  status: "pending" | "settled";
  createdByName: string;
  lastEditedByName: string | null;
  lastEditedAt: string | null;
  createdAt: string;
  updatedAt: string;
  splitMemberIds: number[];
  breakdown: BillShareBreakdown[];
}

export interface CreateBillInput {
  groupId: number;
  description: string;
  merchant?: string;
  billDate: string;
  subtotalAmount: number;
  taxAmount: number;
  tipAmount: number;
  serviceFeeAmount: number;
  discountAmount: number;
  paidByMemberId: number;
  splitMemberIds: number[];
}

export function useGroupBills(groupId: number) {
  return useQuery({
    queryKey: ["groups", groupId, "bills"],
    queryFn: () => apiFetch<{ bills: GroupBillSummary[] }>(`/api/groups/${groupId}/bills`),
    enabled: Number.isInteger(groupId),
  });
}

export function useBill(id: number) {
  return useQuery({
    queryKey: ["bills", id],
    queryFn: () => apiFetch<{ bill: BillDetail }>(`/api/bills/${id}`),
    enabled: Number.isInteger(id),
  });
}

function invalidateBillEffects(queryClient: ReturnType<typeof useQueryClient>, groupId: number) {
  queryClient.invalidateQueries({ queryKey: ["groups"] });
  queryClient.invalidateQueries({ queryKey: ["groups", groupId] });
  queryClient.invalidateQueries({ queryKey: ["groups", groupId, "bills"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  queryClient.invalidateQueries({ queryKey: ["activity"] });
  queryClient.invalidateQueries({ queryKey: ["balances"] });
}

export function useCreateBill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBillInput) =>
      apiFetch<{ bill: { id: number } }>("/api/bills", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (_data, variables) => invalidateBillEffects(queryClient, variables.groupId),
  });
}

export function useUpdateBill(id: number, groupId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<CreateBillInput>) =>
      apiFetch(`/api/bills/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      invalidateBillEffects(queryClient, groupId);
      queryClient.invalidateQueries({ queryKey: ["bills", id] });
    },
  });
}

export function useDeleteBill(id: number, groupId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/api/bills/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateBillEffects(queryClient, groupId);
      queryClient.removeQueries({ queryKey: ["bills", id] });
    },
  });
}
