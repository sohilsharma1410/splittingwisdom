import { useState } from "react";
import { Download, Upload, Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { GroupCard } from "@/components/groups/group-card";
import { CreateGroupDialog } from "@/components/groups/create-group-dialog";
import { ExportGroupsDialog } from "@/components/groups/export-groups-dialog";
import { ImportGroupsDialog } from "@/components/groups/import-groups-dialog";
import { useGroups } from "@/hooks/use-groups";

export default function Groups() {
  const [createOpen, setCreateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useGroups();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Groups</h1>
          <p className="mt-1 text-muted-foreground">
            Trips, households, and shared projects, organized.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            Import
          </Button>
          <Button variant="outline" onClick={() => setExportOpen(true)} disabled={!data || data.groups.length === 0}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Export
          </Button>
          <Button onClick={() => setCreateOpen(true)}>Create Group</Button>
        </div>
      </header>

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}

      {isError && <ErrorState message="Couldn't load your groups." onRetry={() => refetch()} />}

      {!isLoading && !isError && data && data.groups.length === 0 && (
        <EmptyState
          icon={Users}
          heading="No groups yet"
          description="Create a group and add the people you split expenses with — friends, roommates, or a trip crew."
          action={<Button onClick={() => setCreateOpen(true)}>Create Group</Button>}
        />
      )}

      {!isLoading && !isError && data && data.groups.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.groups.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </div>
      )}

      <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ExportGroupsDialog groups={data?.groups ?? []} open={exportOpen} onOpenChange={setExportOpen} />
      <ImportGroupsDialog
        existingGroupNames={(data?.groups ?? []).map((g) => g.name)}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}
