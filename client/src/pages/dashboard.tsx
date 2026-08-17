import { LayoutDashboard } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">
          See what's owed, what you owe, and what needs attention.
        </p>
      </header>
      <EmptyState
        icon={LayoutDashboard}
        heading="Your dashboard is empty for now"
        description="Once you're signed in and have a group with a bill, your balances and recent activity will show up here."
        action={<Button disabled>New Bill</Button>}
      />
    </div>
  );
}
