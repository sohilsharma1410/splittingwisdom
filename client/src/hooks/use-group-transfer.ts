import { useMutation, useQueryClient } from "@tanstack/react-query";
import { groupExportFileSchema, type GroupExportFile } from "@splittingwisdom/shared";
import { apiFetch } from "@/lib/query-client";

/** Saves text as a file through the browser's download. */
function saveFile(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileNameFor(file: GroupExportFile): string {
  const date = file.exportedAt.slice(0, 10);
  if (file.groups.length > 1) return `splittingwisdom-${file.groups.length}-groups-${date}.json`;
  const slug = file.groups[0].name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
  return `splittingwisdom-${slug}-${date}.json`;
}

export function useExportGroups() {
  return useMutation({
    mutationFn: async ({ groupIds, includeReceipts }: { groupIds: number[]; includeReceipts: boolean }) => {
      const file = await apiFetch<GroupExportFile>(
        `/api/groups/export?ids=${groupIds.join(",")}&receipts=${includeReceipts}`,
      );
      saveFile(JSON.stringify(file, null, 1), fileNameFor(file));
      return file;
    },
  });
}

export type ReadExportResult = { ok: true; file: GroupExportFile } | { ok: false; message: string };

/** Reads and checks a chosen export file in the browser, for the preview, before anything is sent. */
export async function readExportFile(chosen: File): Promise<ReadExportResult> {
  let json: unknown;
  try {
    json = JSON.parse(await chosen.text());
  } catch {
    return { ok: false, message: "That file isn't a SplittingWisdom export (it isn't valid JSON)." };
  }
  const parsed = groupExportFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `This file can't be imported: ${issue.message}` };
  }
  return { ok: true, file: parsed.data };
}

export function useImportGroups() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, youRefs, idempotencyKey }: { file: File; youRefs: number[]; idempotencyKey: string }) => {
      const form = new FormData();
      form.append("you", JSON.stringify(youRefs));
      form.append("file", file);
      return apiFetch<{ groupIds: number[] }>("/api/groups/import", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: form,
      });
    },
    onSuccess: () => {
      for (const key of ["groups", "balances", "dashboard", "activity"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
