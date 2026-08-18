import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";

export interface GroupSummary {
  id: number;
  name: string;
  coverImage: string | null;
  memberCount: number;
  billCount: number;
  myBalance: number;
  memberPreview: string[];
  lastActivity: string;
}

export interface GroupMemberDetail {
  id: number;
  displayName: string;
  userId: number | null;
  isLinked: boolean;
  joinedAt: string;
  balance: number;
}

export interface GroupDetail {
  id: number;
  name: string;
  coverImage: string | null;
  createdBy: number;
  inviteToken: string;
  createdAt: string;
  updatedAt: string;
  members: GroupMemberDetail[];
}

export interface InvitePreview {
  group: { id: number; name: string };
  alreadyMember: boolean;
  unclaimedMembers: { id: number; displayName: string }[];
}

export function useGroups() {
  return useQuery({
    queryKey: ["groups"],
    queryFn: () => apiFetch<{ groups: GroupSummary[] }>("/api/groups"),
  });
}

export function useGroup(id: number) {
  return useQuery({
    queryKey: ["groups", id],
    queryFn: () => apiFetch<{ group: GroupDetail }>(`/api/groups/${id}`),
    enabled: Number.isInteger(id),
  });
}

export function useInvitePreview(token: string, enabled = true) {
  return useQuery({
    queryKey: ["groups", "invite", token],
    queryFn: () => apiFetch<InvitePreview>(`/api/groups/invite/${token}`),
    enabled,
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; memberNames: string[] }) =>
      apiFetch<{ group: { id: number } }>("/api/groups", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function useRenameGroup(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      queryClient.invalidateQueries({ queryKey: ["groups", id] });
    },
  });
}

export function useDeleteGroup(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/api/groups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      queryClient.removeQueries({ queryKey: ["groups", id] });
    },
  });
}

export function useAddMember(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (displayName: string) =>
      apiFetch(`/api/groups/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ displayName }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups", id] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function useRemoveMember(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: number) =>
      apiFetch(`/api/groups/${id}/members/${memberId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups", id] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}

export function useJoinGroup(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId?: number) =>
      apiFetch<{ group: { id: number; name: string } }>(`/api/groups/invite/${token}/join`, {
        method: "POST",
        body: JSON.stringify({ memberId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
  });
}
