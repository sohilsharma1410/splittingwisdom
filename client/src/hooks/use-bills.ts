import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";

export type SplitType = "equal" | "percentage" | "ratio" | "custom";

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

export interface ItemAssignmentDetail {
  memberId: number;
  displayName: string;
  splitType: SplitType;
  percentage: number | null;
  ratio: number | null;
  customAmount: number | null;
  share: number;
}

export interface BillItemDetail {
  id: number;
  name: string;
  price: number;
  quantity: number;
  assignments: ItemAssignmentDetail[];
}

export interface BillDetail {
  id: number;
  groupId: number;
  groupName: string;
  description: string;
  merchant: string | null;
  billDate: string;
  subtotalAmount: number;
  itemsSubtotal: number;
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
  items: BillItemDetail[];
  itemCount: number;
  unassignedItemCount: number;
  breakdown: BillShareBreakdown[];
}

/** One item row as sent to the server — assignments empty means unassigned. */
export interface ItemAssignmentInput {
  memberId: number;
  splitType: SplitType;
  percentage?: number;
  ratio?: number;
  customAmount?: number;
}

export interface BillItemInput {
  name: string;
  price: number;
  quantity?: number;
  assignments: ItemAssignmentInput[];
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
  items: BillItemInput[];
}

export interface ActivityBillItem {
  id: number;
  groupId: number;
  groupName: string;
  description: string;
  merchant: string | null;
  billDate: string;
  grandTotal: number;
  itemCount: number;
  unassignedItemCount: number;
  paidByName: string;
  status: "pending" | "settled";
  myShare: number;
  createdAt: string;
  items: BillItemDetail[];
  breakdown: { memberId: number; displayName: string; total: number }[];
}

export function useActivity() {
  return useQuery({
    queryKey: ["activity"],
    queryFn: () => apiFetch<{ bills: ActivityBillItem[] }>("/api/bills"),
  });
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
    enabled: Number.isInteger(id) && id > 0,
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
