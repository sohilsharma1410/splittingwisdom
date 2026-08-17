import { Activity as ActivityIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function Activity() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Activity</h1>
        <p className="mt-1 text-muted-foreground">
          Every bill across your groups, newest first.
        </p>
      </header>
      <EmptyState
        icon={ActivityIcon}
        heading="No activity yet"
        description="Bills you add will show up here, grouped by date, with a filter for pending and settled."
      />
    </div>
  );
}
