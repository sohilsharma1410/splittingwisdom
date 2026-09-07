import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query-client";

export interface Person {
  id: number;
  displayName: string;
}

export function useKnownPeople() {
  return useQuery({
    queryKey: ["people", "known"],
    queryFn: () => apiFetch<{ people: Person[] }>("/api/users/known"),
  });
}

export function useSearchPeople() {
  return useMutation({
    mutationFn: (q: string) => apiFetch<{ people: Person[] }>(`/api/users/search?q=${encodeURIComponent(q)}`),
  });
}
