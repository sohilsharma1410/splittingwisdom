import { Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

export default function Groups() {
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Groups</h1>
          <p className="mt-1 text-muted-foreground">
            Trips, households, and shared projects, organized.
          </p>
        </div>
        <Button disabled className="hidden md:inline-flex">
          Create Group
        </Button>
      </header>
      <EmptyState
        icon={Users}
        heading="No groups yet"
        description="Create a group and add the people you split expenses with — friends, roommates, or a trip crew."
        action={<Button disabled>Create Group</Button>}
      />
    </div>
  );
}
