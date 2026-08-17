import { useParams } from "wouter";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Group</h1>
        <p className="mt-1 text-muted-foreground">Group #{id}</p>
      </header>
      <EmptyState
        icon={Users}
        heading="Group details arrive in Checkpoint C"
        description="Members, balances, and bills for this group will show up here once groups are built."
      />
    </div>
  );
}
